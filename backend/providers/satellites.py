"""
Источник сведений о спутниках на околоземных орбитах.

Что содержит каталог
--------------------
Каталог возвращает двухстрочные элементы орбиты для всех
зарегистрированных спутников. Каждые три строки описывают один
аппарат: название и две строки с элементами орбиты.

Зачем нужны элементы орбиты для панели
--------------------------------------
Функция `fetch_orbital_elements` отбирает элементы орбиты МКС,
которые используются для плавной анимации её движения. Функция
`fetch_satellite_groups` обращается к тем же данным ради другого
сценария: подсчёта спутников по принадлежности к группировкам.
Такой подход переиспользует один источник для двух задач вместо
обращения к разным сервисам.

Ограничение по объёму
---------------------
Полный каталог содержит около 48 000 аппаратов и занимает
несколько мегабайт. Для подсчёта по группам он не нужен целиком:
в каждой группировке интересует количество, а не точный состав.
Каждая группировка запрашивается отдельным обращением, а подсчёт
ведётся по каталогу самой группы. Значение помечается как
приблизительное: состав группировок меняется постоянно, и точность
до единицы здесь не нужна.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .. import settings
from ..cache import cached_json, read_cache
from ..http_client import http_client

#: Ключ кэша для элементов орбиты МКС.
#: Элементы орбиты публикуются источником раз в сутки, поэтому
#: и здесь не требуется частое обновление.
ISS_TLE_CACHE_KEY = 'iss_tle'

#: Ключ кэша для выборки спутников по группам.
SATELLITE_GROUPS_CACHE_KEY = 'satellite_groups'

#: Группы спутников, представляющие наибольший интерес.
#: Значения соответствуют обозначениям групп, принятым в источнике.
#: Состав подборки отражает распределение аппаратов по типам:
#: межпланетные станции, спутники связи, навигационные системы,
#: метеорологические аппараты и системы обеспечения связи.
SURVEYED_GROUPS: dict[str, str] = {
    'stations': 'Межпланетные станции',
    'science': 'Научные аппараты',
    'communications': 'Спутники связи',
    'navigation': 'Навигационные системы',
    'weather': 'Метеорологические аппараты',
    'resource': 'Аппараты изучения ресурсов Земли',
    'military': 'Аппараты военного назначения',
}

#: Сколько записей запрашивается для оценки состава группы.
SAMPLE_LIMIT = 2000


@cached_json(ISS_TLE_CACHE_KEY, ttl_seconds=3600)
async def fetch_orbital_elements() -> dict[str, Any]:
    """
    Запрашивает двухстрочные элементы орбиты МКС.

    Returns
    -------
    dict[str, Any]
        Три строки элементов орбиты, а также момент времени, на
        который элементы рассчитаны. Эпоха элементов важна для
        понимания точности расчёта: чем больше времени прошло
        с момента публикации элементов, тем больше накапливается
        погрешность.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    url = settings.ISS_TLE_URL.format(norad_id=settings.ISS_NORAD_ID)
    tle_text = await http_client.fetch_text(url, 'элементы орбиты МКС')

    lines = [line for line in tle_text.splitlines() if line.strip()]
    if len(lines) < 3:
        raise ValueError(
            f'Источник вернул неполные элементы орбиты: '
            f'ожидалось не менее трёх строк, получено {len(lines)}'
        )

    # Первая строка содержит название аппарата, следующие две —
    # собственно элементы орбиты.
    name, first_line, second_line = lines[0], lines[1], lines[2]

    return {
        'name': name,
        # Эти две строки передаются в интерфейс без изменений:
        # расчёт положения выполняется на стороне сервера, который
        # использует библиотеку, разбирающую этот формат.
        'tle_line1': first_line,
        'tle_line2': second_line,
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
    }


async def get_iss_orbital_elements() -> dict[str, Any] | None:
    """
    Возвращает элементы орбиты МКС из кэша, не обращаясь к источнику.

    Функция применяется при построении траектории: траектория
    пересчитывается часто, а элементы орбиты меняются редко,
    поэтому повторное обращение к источнику при каждом пересчёте
    не требуется.

    Returns
    -------
    dict[str, Any] | None
        Элементы орбиты из кэша либо `None`, если запись отсутствует.
    """
    return read_cache(ISS_TLE_CACHE_KEY)


@cached_json(SATELLITE_GROUPS_CACHE_KEY, ttl_seconds=21600)
async def fetch_satellite_groups() -> dict[str, Any]:
    """
    Подсчитывает спутники по принадлежности к группировкам.

    Returns
    -------
    dict[str, Any]
        Список групп с указанием числа аппаратов в каждой.
        Значения являются оценкой на основе выборки: они позволяют
        сравнить относительные размеры группировок, не загружая
        полный каталог.

    Raises
    ------
    ExternalServiceError
        Если хотя бы один из опрашиваемых источников недоступен
        и в кэше нет свежей записи.
    """
    groups: list[dict[str, Any]] = []
    failed_groups: list[str] = []

    for group_code, group_label in SURVEYED_GROUPS.items():
        url = settings.SATELLITE_GROUPS_URL.format(group=group_code)
        try:
            group_text = await http_client.fetch_text(
                url, f'каталог спутников группы {group_label}'
            )
        except Exception as error:
            # Отдельные группы опрашиваются независимо друг от друга.
            # Недоступность одной из них не должна лишать интерфейс
            # сведений обо всех остальных, поэтому ошибка фиксируется
            # и опрос продолжается.
            failed_groups.append(group_label)
            continue

        lines = [line for line in group_text.splitlines() if line.strip()]
        # Каждые три строки описывают один аппарат, поэтому количество
        # аппаратов равно числу полных троек строк.
        satellite_count = len(lines) // 3

        groups.append({
            'code': group_code,
            'label': group_label,
            'satellite_count': satellite_count,
            # Отметка о приблизительности значения: каталог группы
            # включает аппараты разных поколений, а их состав
            # постоянно меняется.
            'is_estimate': len(lines) % 3 != 0 or satellite_count >= SAMPLE_LIMIT,
        })

    groups.sort(key=lambda group: group['satellite_count'], reverse=True)

    return {
        'groups': groups,
        'failed_groups': failed_groups,
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
    }
