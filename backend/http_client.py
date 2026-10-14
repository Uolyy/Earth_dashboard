"""
Единая точка выполнения HTTP-запросов к внешним источникам данных.

Собственный клиент используется вместо обращения к внешним сервисам
напрямую по трём причинам:

1. Единая обработка ошибок: любой сбой внешнего источника приводит
   к предсказуемому исключению `ExternalServiceError`, которое
   перехватывается на уровне API и превращается в понятный ответ
   для интерфейса, вместо «500 Internal Server Error».
2. Единая политика повторов: сетевые ошибки и таймауты повторяются
   несколько раз, поскольку большинство сбоев носят временный характер.
3. Контроль обращений к внешним сервисам: собственный клиент
   используется совместно с кэшем, что позволяет не опрашивать
   источники чаще, чем те рассчитаны выдерживать.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx

from . import settings

#: Имя HTTP-клиента, отображаемое в логах и в заголовках User-Agent.
#: Идентификатор помогает администраторам внешних сервисов понять,
#: откуда пришёл запрос.
#: Википедия и ряд других вики-сервисов отвечают 403 Forbidden на запросы,
#: в заголовке User-Agent которых нет внятного названия проекта и контакта.
#: Поэтому идентификатор должен быть подробным, а не формальным.
USER_AGENT = (
    'OrbitalWatchDashboard/1.0 '
    '(https://github.com/Uolyy/Earth_dashboard; educational open-source project) '
    'python-httpx'
)

logger = logging.getLogger(__name__)


class ExternalServiceError(Exception):
    """
    Ошибка обращения к внешнему источнику данных.

    Исключение сигнализирует о том, что источник недоступен:
    вернул ошибку, не отдал ожидаемый формат данных или не ответил
    в течение отведённого времени.

    Parameters
    ----------
    service_name : str
        Человекочитаемое имя источника, используется в тексте ошибки.
    original_error : Exception
        Исходное исключение, из которого получено сообщение об ошибке.
    """

    def __init__(self, service_name: str, original_error: Exception) -> None:
        self.service_name = service_name
        self.original_error = original_error
        super().__init__(f'Источник «{service_name}» недоступен: {original_error}')


class HttpClient:
    """
    Асинхронный HTTP-клиент с повторами и единой обработкой ошибок.

    Экземпляр класса создаётся один раз при старте приложения и
    переиспользуется всеми модулями-поставщиками данных.

    Attributes
    ----------
    _client : httpx.AsyncClient
        Внутренний клиент, переиспользующий одно TCP-соединение
        между соседними запросами.
    """

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.HTTP_TIMEOUT_SECONDS),
            headers={'User-Agent': USER_AGENT},
            follow_redirects=True,
        )

    async def close(self) -> None:
        """
        Освобождает сетевые ресурсы, занятые клиентом.

        Вызывается при остановке приложения, чтобы соединения были
        закрыты корректно, а не по таймауту операционной системы.
        """
        await self._client.aclose()

    async def fetch_json(
        self,
        url: str,
        service_name: str,
        params: dict[str, Any] | None = None,
    ) -> Any:
        """
        Запрашивает URL и разбирает ответ как JSON.

        Parameters
        ----------
        url : str
            Адрес запроса.
        service_name : str
            Человекочитаемое имя источника. Используется в сообщениях
            об ошибках, чтобы пользователь видел, какой именно сервис
            не ответил.
        params : dict[str, Any] | None
            Дополнительные параметры запроса, передаваемые как строка
            запроса. По умолчанию `None`.

        Returns
        ----------
        Any
            Разобранный JSON: словарь, список или иной тип в зависимости
            от ответа источника.

        Raises
        ----------
        ExternalServiceError
            Если после всех попыток получить валидный JSON не удалось.
        """
        last_error: Exception | None = None

        for attempt in range(1, settings.HTTP_RETRIES + 2):
            try:
                response = await self._client.get(url, params=params)
                response.raise_for_status()
                return response.json()
            except (httpx.HTTPError, json.JSONDecodeError, ValueError) as error:
                last_error = error
                logger.warning(
                    'Запрос к «%s» не удался (попытка %d из %d): %s',
                    service_name, attempt, settings.HTTP_RETRIES + 1, error,
                )
                if attempt <= settings.HTTP_RETRIES:
                    await asyncio.sleep(settings.HTTP_RETRY_DELAY_SECONDS * attempt)

        # Все попытки исчерпаны: сообщаем вызывающему коду точную причину.
        raise ExternalServiceError(service_name, last_error or Exception('неизвестная ошибка'))

    async def fetch_text(self, url: str, service_name: str) -> str:
        """
        Запрашивает URL и возвращает тело ответа как текст.

        Применяется для источников, отдающих данные не в JSON,
        а в текстовом формате (например, каталоги в формате TLE).

        Parameters
        ----------
        url : str
            Адрес запроса.
        service_name : str
            Человекочитаемое имя источника для сообщений об ошибках.

        Returns
        -------
        str
            Текстовое содержимое ответа.

        Raises
        -------
        ExternalServiceError
            Если после всех попыток получить ответ не удалось.
        """
        last_error: Exception | None = None

        for attempt in range(1, settings.HTTP_RETRIES + 2):
            try:
                response = await self._client.get(url)
                response.raise_for_status()
                return response.text
            except httpx.HTTPError as error:
                last_error = error
                logger.warning(
                    'Текстовый запрос к «%s» не удался (попытка %d из %d): %s',
                    service_name, attempt, settings.HTTP_RETRIES + 1, error,
                )
                if attempt <= settings.HTTP_RETRIES:
                    await asyncio.sleep(settings.HTTP_RETRY_DELAY_SECONDS * attempt)

        raise ExternalServiceError(service_name, last_error or Exception('неизвестная ошибка'))


#: Глобальный экземпляр клиента, используемый всеми поставщиками данных.
#: Создание происходит при импорте модуля, что совпадает со стартом приложения.
http_client = HttpClient()
