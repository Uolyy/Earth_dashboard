"""
Кэш ответов внешних источников, сохраняемый на диск.

Зачем нужен кэш
----------------
Внешние источники данных — общие сервисы, и обращаться к ним
на каждый перерисовывающийся элемент интерфейса недопустимо.
Кэш решает три задачи:

1. Снижает частоту обращений к внешним сервисам до допустимой.
2. Позволяет приложению пережить перезапуск: данные, полученные
   незадолго до остановки, остаются доступны сразу после запуска.
3. Делает интерфейс устойчивым к кратковременным сбоям сети:
   при недоступности источника показываются последние успешно
   полученные данные с явной пометкой о том, что они устарели.

Почему именно файлы
-------------------
Каталог источников невелик (порядка десятка записей), поэтому
полноценная база данных избыточна. Файловое хранилище позволяет
обойтись без дополнительных зависимостей и легко просматривается
вручную при отладке.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from pathlib import Path
from typing import Any

from . import settings

logger = logging.getLogger(__name__)

#: Шаблон имени файла кэша. Допустимые символы ограничены набором
#: букв, цифр, дефисов и подчёркиваний, поэтому ключи кэша
#: приводятся к безопасному виду при расчёте имени файла.
SAFE_KEY_PATTERN = re.compile(r'[^a-zA-Z0-9_-]+')


def _build_cache_path(cache_key: str) -> Path:
    """
    Вычисляет путь файла кэша для указанного ключа.

    Ключ приводится к безопасному виду, а его длина ограничивается,
    чтобы не столкнуться с ограничением длины имени файла
    в файловой системе.

    Parameters
    ----------
    cache_key : str
        Произвольный строковый ключ, однозначно описывающий запрос.

    Returns
    -------
    Path
        Путь к файлу, в котором будет храниться значение.
    """
    safe_key = SAFE_KEY_PATTERN.sub('_', cache_key).strip('_')[:80]
    # Хеш добавляется к имени, чтобы ключи, различающиеся только
    # «невидимыми» символами, не приводили к совпадению имён файлов.
    digest = hashlib.sha256(cache_key.encode('utf-8')).hexdigest()[:10]
    return settings.CACHE_DIRECTORY / f'{safe_key}_{digest}.json'


def read_cache(cache_key: str) -> Any | None:
    """
    Читает значение из кэша, если оно есть и не устарело.

    Parameters
    ----------
    cache_key : str
        Ключ, под которым значение было сохранено.

    Returns
    -------
    Any | None
        Сохранённое значение либо `None`, если записи нет,
        она повреждена или срок её жизни истёк.
    """
    cache_path = _build_cache_path(cache_key)
    if not cache_path.exists():
        return None

    try:
        record = json.loads(cache_path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError) as error:
        logger.warning('Повреждена запись кэша %s: %s', cache_path.name, error)
        return None

    age_seconds = time.time() - record.get('saved_at', 0)
    if age_seconds > record.get('ttl_seconds', settings.CACHE_TTL_SECONDS):
        return None

    return record.get('value')


def read_cache_with_age(cache_key: str) -> tuple[Any | None, float]:
    """
    Читает значение из кэша вместе с его возрастом.

    Функция используется в тех случаях, когда интерфейсу нужно
    показать, насколько свежи данные: при недоступности источника
    это позволяет честно сообщить пользователю, что перед ним
    не онлайн-данные, а сохранённый снимок.

    Parameters
    ----------
    cache_key : str
        Ключ, под которым значение было сохранено.

    Returns
    -------
    tuple[Any | None, float]
        Пара из двух элементов: значение (или `None`) и возраст
        записи в секундах. При отсутствии записи возраст равен `0.0`.
    """
    cache_path = _build_cache_path(cache_key)
    if not cache_path.exists():
        return None, 0.0

    try:
        record = json.loads(cache_path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
        return None, 0.0

    return record.get('value'), max(0.0, time.time() - record.get('saved_at', 0))


def write_cache(cache_key: str, value: Any, ttl_seconds: int | None = None) -> None:
    """
    Сохраняет значение в кэш.

    Parameters
    ----------
    cache_key : str
        Ключ, под которым сохраняется значение.
    value : Any
        Значение, пригодное для сериализации в JSON.
    ttl_seconds : int | None
        Срок жизни записи в секундах. Если не задан, берётся
        значение по умолчанию из настроек.

    Notes
    -----
    Ошибка записи не приводит к аварии: невозможность сохранить
    кэш означает лишь, что при следующем запросе данные будут
    получены заново.
    """
    settings.CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)

    record = {
        'saved_at': time.time(),
        'ttl_seconds': ttl_seconds if ttl_seconds is not None else settings.CACHE_TTL_SECONDS,
        'value': value,
    }

    try:
        _build_cache_path(cache_key).write_text(
            json.dumps(record, ensure_ascii=False), encoding='utf-8'
        )
    except (OSError, TypeError) as error:
        logger.warning('Не удалось сохранить кэш %s: %s', cache_key, error)


def cached_json(
    cache_key: str,
    ttl_seconds: int | None = None,
    allow_stale_on_error: bool = True,
):
    """
    Возвращает результат функции, используя кэш при наличии свежей записи.

    Функция оформлена в виде декоратора, чтобы вызывающий код
    не был вынужден повторять одну и ту же последовательность:
    «проверить кэш → обратиться к источнику → сохранить в кэш».

    Parameters
    ----------
    cache_key : str
        Ключ кэша.
    ttl_seconds : int | None
        Срок жизни записи. `None` означает значение по умолчанию.
    allow_stale_on_error : bool
        Разрешать ли отдавать устаревшее значение, если источник
        недоступен. Позволяет интерфейсу оставаться работоспособным
        при кратковременных сбоях сети.

    Returns
    -------
    Callable
        Декоратор, оборачивающий асинхронную функцию-поставщик данных.
    """
    def decorator(provider_function):
        async def wrapper(*args, **kwargs):
            cached_value = read_cache(cache_key)
            if cached_value is not None:
                return cached_value

            try:
                fresh_value = await provider_function(*args, **kwargs)
            except Exception:
                if allow_stale_on_error:
                    stale_value, age_seconds = read_cache_with_age(cache_key)
                    if stale_value is not None:
                        logger.warning(
                            'Источник недоступен, используется кэш %s (возраст %.0f с)',
                            cache_key, age_seconds,
                        )
                        return stale_value
                raise

            write_cache(cache_key, fresh_value, ttl_seconds)
            return fresh_value

        wrapper.__name__ = provider_function.__name__
        wrapper.__doc__ = provider_function.__doc__
        return wrapper

    return decorator
