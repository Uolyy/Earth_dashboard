"""
Источник сведений об астероидах, сближающихся с Землёй.

Классификация объектов
----------------------
* Околоземные астероиды (near-Earth objects) — астероиды, орбиты
  которых подходят к орбите Земли достаточно близко, чтобы их можно
  было наблюдать вблизи.
* Потенциально опасные астероиды (potentially hazardous asteroids) —
  подкласс околоземных астероидов, орбиты которых пересекают
  область земной орбиты и размер которых превышает 140 метров.
  Именно объекты этого класса способны нанести планете ущерб
  регионального масштаба.

Оценка опасности
----------------
Размер астероида определяется по абсолютной звездной величине H —
величине, которую объект имел бы на расстоянии в одну астрономическую
единицу при нулевом альбедо и наблюдаемый строго над атмосферой.
Соответствие между величиной и диаметром задаётся эмпирической
зависимостью; если диаметр у объекта неизвестен, он оценивается
по этой зависимости, что позволяет сопоставлять объекты между собой.

Важная оговорка
---------------
Приведённые оценки диаметра являются приближёнными и используются
исключительно для сравнения объектов между собой. Для оценки
реальной опасности сближения требуются точные элементы орбиты
и расчёт минимального расстояния сближения, которые находятся
за пределами предоставляемого набору данных.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .. import settings
from ..cache import cached_json
from ..http_client import http_client

#: Ключи кэша для двух наборов сведений.
ASTEROIDS_CACHE_KEY = 'near_earth_asteroids'
HAZARDOUS_CACHE_KEY = 'hazardous_asteroids'

#: Количество объектов, запрашиваемых у источника.
#: Значение ограничено разумным пределом: интерфейсу достаточно
#: выборки для сравнения, а полный каталог содержит десятки тысяч записей.
FETCH_LIMIT = 300

#: Ключ кэша подробных сведений об одном астероиде.
#: К названию объекта добавляется префикс, чтобы записи разных
#: астероидов хранились независимо друг от друга.
ASTEROID_DETAILS_CACHE_PREFIX = 'asteroid_details_'

#: Время жизни записи кэша подробных сведений.
#: Значение велико: орбитальные характеристики астероида меняются
#: крайне медленно, а каждый запрос обращается к источнику извне.
ASTEROID_DETAILS_TTL = 86400

#: Тот же астрономический масштаб в километрах.
#: Используется для перевода расстояний сближения из единиц
#: источника в километры.
ASTRONOMICAL_UNIT_KM = 149597870.7

#: Названия физических параметров в том виде, в каком их отдаёт
#: источник, и соответствующие им поля ответа.
PHYSICAL_PARAMETER_FIELDS = {
    'diameter': 'diameter_km',
    'H': 'absolute_magnitude',
    'rot_per': 'rotation_hours',
    'albedo': 'albedo',
    'spec_B': 'spectral_type',
}

#: Тело, сближения с которым представляют интерес.
#: Источник возвращает подходы и к другим планетам, но наблюдаемым
#: для нас является только сближение с Землёй.
EARTH_BODY_NAME = 'Earth'

#: Формат даты сближения в ответе источника.
#: Месяц записывается названием на английском языке.
CLOSE_APPROACH_DATE_FORMAT = '%Y-%b-%d %H:%M'

#: Абсолютная звездная величина, соответствующая диаметру около 140 метров.
#: Объекты крупнее считаются потенциально опасными.
#: Значение используется для пояснения классов опасности в интерфейсе.
HAZARDOUS_SIZE_THRESHOLD_H = 18.0


def _clean_text(value: Any) -> str | None:
    """
    Приводит текстовое значение источника к пригодному для показа виду.

    Источник обозначает отсутствующее имя не пустой строкой,
    а строкой `"None"` — так сериализуется значение `None`
    в некоторых языках программирования. Показ такой строки
    пользователю был бы бессмысленным, поэтому значение
    преобразуется в `None` и далее заменяется номерным обозначением.

    Parameters
    ----------
    value : Any
        Исходное значение из ответа источника.

    Returns
    -------
    str | None
        Очищенная строка либо `None`, если значение отсутствует
        или не содержит полезных сведений.
    """
    if value is None:
        return None

    text = str(value).strip()

    # Перечисленные значения не несут сведений и заменяются на None.
    if not text or text.lower() in {'none', 'null', 'n/a', '-'}:
        return None

    return text


def _to_float(value: Any) -> float | None:
    """
    Приводит значение к числу с плавающей точкой.

    Источник возвращает часть полей в виде строк, часть — в виде
    чисел, а отсутствующие значения обозначает пустой строкой.

    Parameters
    ----------
    value : Any
        Исходное значение из ответа источника.

    Returns
    -------
    float | None
        Числовое значение либо `None`, если преобразование
        невозможно или значение отсутствует.
    """
    if value is None or value == '':
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _estimate_diameter_km(absolute_magnitude: float | None) -> float | None:
    """
    Оценивает диаметр астероида по абсолютной звездной величине.

    Диаметр рассчитывается по формуле, связывающей размер тела
    с его абсолютной величиной при условии типичного значения
    коэффициента отражения поверхности. Оценка носит приближённый
    характер и предназначена для сравнения объектов между собой.

    Parameters
    ----------
    absolute_magnitude : float | None
        Абсолютная звездная величина объекта.

    Returns
    -------
    float | None
        Оценка диаметра в километрах либо `None`, если величина неизвестна.
    """
    if absolute_magnitude is None:
        return None

    # Коэффициент 1329 соответствует типичному значению коэффициента
    # отражения поверхности каменных астероидов.
    return round(1329.0 / (10 ** (absolute_magnitude / 5.0)), 3)


@cached_json(ASTEROIDS_CACHE_KEY, ttl_seconds=21600)
async def fetch_near_earth_asteroids() -> dict[str, Any]:
    """
    Запрашивает выборку околоземных астероидов.

    Returns
    -------
    dict[str, Any]
        Словарь со списком объектов и общей статистикой выборки.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    # Обозначение `neo` выбрано согласно документации источника:
    # оно объединяет все классы околоземных астероидов, тогда как
    # `pha` ограничивает выборку только потенциально опасными объектами.
    return await _fetch_group('neo', 'околоземные астероиды')


@cached_json(HAZARDOUS_CACHE_KEY, ttl_seconds=21600)
async def fetch_hazardous_asteroids() -> dict[str, Any]:
    """
    Запрашивает выборку потенциально опасных астероидов.

    Returns
    -------
    dict[str, Any]
        Словарь со списком объектов и общей статистикой выборки.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    return await _fetch_group('pha', 'потенциально опасные астероиды')


def _parse_close_approach_date(value: Any) -> datetime | None:
    """
    Разбирает дату сближения, приходящую от источника.

    Parameters
    ----------
    value : Any
        Исходное значение из ответа источника.

    Returns
    -------
    datetime | None
        Разобранная дата в UTC либо `None`, если значение отсутствует
        или имеет неожиданный формат.
    """
    text = _clean_text(value)
    if text is None:
        return None

    try:
        # Источник не указывает часовой пояс: времена сближений
        # приводятся по всемирному времени.
        return datetime.strptime(text, CLOSE_APPROACH_DATE_FORMAT).replace(
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None


def _extract_physical_parameters(raw_parameters: list[Any]) -> dict[str, Any]:
    """
    Выбирает из физических параметров те, что показаны в интерфейсе.

    Источник возвращает параметры списком записей, где каждая запись
    содержит название, значение и единицу измерения. Сопоставление
    названий со справочником позволяет не зависеть от порядка
    записей и от появления новых параметров в будущем.

    Parameters
    ----------
    raw_parameters : list[Any]
        Список записей с физическими параметрами.

    Returns
    -------
    dict[str, Any]
        Отобранные параметры; отсутствующие значения не включаются.
    """
    result: dict[str, Any] = {}

    for parameter in raw_parameters:
        if not isinstance(parameter, dict):
            continue

        field_name = PHYSICAL_PARAMETER_FIELDS.get(parameter.get('name'))
        if field_name is None:
            continue

        raw_value = parameter.get('value')

        # Числовые параметры приводятся к числу, а спектральный
        # класс остаётся строкой: `B` или `C` не являются числами.
        if field_name == 'spectral_type':
            value = _clean_text(raw_value)
        else:
            value = _to_float(raw_value)

        if value is not None:
            result[field_name] = value

    return result


def _extract_earth_close_approaches(raw_approaches: list[Any]) -> list[dict[str, Any]]:
    """
    Выбирает сближения с Землёй и приводит их к общему виду.

    Parameters
    ----------
    raw_approaches : list[Any]
        Список записей о сближениях из ответа источника.

    Returns
    -------
    list[dict[str, Any]]
        Сближения с Землёй, упорядоченные по расстоянию от более
        близкого к более далёкому. Порядок не хронологический:
        перечень отвечает на вопрос о том, насколько тесно объект
        подходил к Земле, а не о том, когда это происходило.
    """
    approaches: list[dict[str, Any]] = []

    for approach in raw_approaches:
        if not isinstance(approach, dict):
            continue

        if approach.get('body') != EARTH_BODY_NAME:
            continue

        close_date = _parse_close_approach_date(approach.get('cd'))
        distance_au = _to_float(approach.get('dist'))
        if close_date is None or distance_au is None:
            continue

        approaches.append({
            'date': close_date.isoformat(),
            'is_future': close_date > datetime.now(timezone.utc),
            'distance_km': round(distance_au * ASTRONOMICAL_UNIT_KM, 0),
            # Относительная скорость показывается в километрах в секунду:
            # так она соизмерима со скоростью станции и понятнее
            # считывается, чем значение в километрах в час.
            'relative_velocity_km_s': _to_float(approach.get('v_rel')),
        })

    approaches.sort(key=lambda item: item['distance_km'])
    return approaches


async def fetch_asteroid_details_uncached(designation: str) -> dict[str, Any]:
    """
    Запрашивает подробные сведения об одном астероиде.

    Parameters
    ----------
    designation : str
        Обозначение астероида: имя либо номер.

    Returns
    -------
    dict[str, Any]
        Полное наименование, класс орбиты, физические параметры
        и список сближений с Землёй.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен.
    """
    url = settings.ASTEROID_DETAILS_URL.format(designation=designation)
    raw_data = await http_client.fetch_json(url, 'сведения об астероиде')

    orbit_class = raw_data.get('object', {}).get('orbit_class', {})

    return {
        'designation': designation,
        'full_name': _clean_text(raw_data.get('object', {}).get('fullname')),
        'orbit_class_code': _clean_text(orbit_class.get('code')),
        'orbit_class_name': _clean_text(orbit_class.get('name')),
        'is_near_earth': bool(raw_data.get('object', {}).get('neo')),
        'physical_parameters': _extract_physical_parameters(
            raw_data.get('phys_par', []),
        ),
        'close_approaches': _extract_earth_close_approaches(
            raw_data.get('ca_data', []),
        ),
    }


async def fetch_asteroid_details(designation: str) -> dict[str, Any]:
    """
    Возвращает подробные сведения об астероиде, используя кэш.

    Кэш вызывается через фабрику декоратора, поэтому записи
    разных астероидов хранятся независимо, а к каждому обращению
    после первого источник не опрашивается заново.

    Parameters
    ----------
    designation : str
        Обозначение астероида: имя либо номер.

    Returns
    -------
    dict[str, Any]
        Сведения об астероиде.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    cached_provider = cached_json(
        f'{ASTEROID_DETAILS_CACHE_PREFIX}{designation}',
        ttl_seconds=ASTEROID_DETAILS_TTL,
    )(fetch_asteroid_details_uncached)

    return await cached_provider(designation)


async def _fetch_group(group: str, service_name: str) -> dict[str, Any]:
    """
    Запрашивает одну группу объектов и приводит её к общему виду.

    Функция вызывается двумя вышестоящими функциями с разными
    значениями группы, что позволяет не дублировать логику
    разбора ответа источника.

    Parameters
    ----------
    group : str
        Обозначение группы объектов, ожидаемое источником.
    service_name : str
        Человекочитаемое имя источника для сообщений об ошибках.

    Returns
    -------
    dict[str, Any]
        Нормализованный список объектов и статистика по нему.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    url = settings.ASTEROIDS_URL.format(group=group, limit=FETCH_LIMIT)
    raw_data = await http_client.fetch_json(url, service_name)

    # Источник возвращает табличную структуру: сначала перечень названий
    # полей, затем строки, каждая из которых содержит значения
    # в порядке, заданном этим перечнем. Строки сопоставляются
    # с названиями полей для устойчивости к изменениям порядка полей.
    field_names: list[str] = raw_data.get('fields', [])
    raw_rows: list[list[Any]] = raw_data.get('data', [])

    asteroids: list[dict[str, Any]] = []

    for raw_row in raw_rows:
        row = dict(zip(field_names, raw_row))

        absolute_magnitude = _to_float(row.get('H'))
        # Диаметр, если он известен, берётся из источника; иначе
        # оценивается по абсолютной величине.
        diameter_km = _to_float(row.get('diameter'))
        diameter_is_estimated = diameter_km is None
        if diameter_is_estimated:
            diameter_km = _estimate_diameter_km(absolute_magnitude)

        designation = _clean_text(row.get('pdes'))
        object_name = _clean_text(row.get('name'))

        asteroids.append({
            'designation': designation,
            # Отсутствующее имя не оставляет объект без обозначения:
            # вместо него показывается номер, присвоенный при открытии.
            'name': object_name or designation,
            'has_own_name': object_name is not None,
            # Полное обозначение содержит номер, имя и дату открытия.
            'full_name': _clean_text(row.get('full_name')),
            'absolute_magnitude': absolute_magnitude,
            'diameter_km': diameter_km,
            'diameter_is_estimated': diameter_is_estimated,
            'orbit_class': _clean_text(row.get('class')),
            'is_potentially_hazardous': _clean_text(row.get('pha')) == 'Y',
            # Признак опасности по размеру: тела крупнее порога
            # способны нанести ущерб значительного масштаба.
            'exceeds_size_threshold': (
                absolute_magnitude is not None
                and absolute_magnitude < HAZARDOUS_SIZE_THRESHOLD_H
            ),
        })

    # Объекты с наименьшей звездной величиной являются самыми крупными,
    # поэтому именно они располагаются в начале списка.
    asteroids.sort(
        key=lambda asteroid: (
            asteroid['absolute_magnitude'] is None,
            asteroid['absolute_magnitude'] or 0.0,
        )
    )

    known_diameters = [
        asteroid['diameter_km'] for asteroid in asteroids if asteroid['diameter_km']
    ]

    return {
        'asteroids': asteroids,
        'statistics': {
            'objects_in_sample': len(asteroids),
            'total_objects_known': raw_data.get('count'),
            'hazardous_objects_in_sample': sum(
                1 for asteroid in asteroids
                if asteroid['is_potentially_hazardous']
            ),
            'largest_diameter_km': max(known_diameters) if known_diameters else None,
            'median_diameter_km': (
                round(sorted(known_diameters)[len(known_diameters) // 2], 3)
                if known_diameters else None
            ),
            'over_size_threshold': sum(
                1 for asteroid in asteroids if asteroid['exceeds_size_threshold']
            ),
        },
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
    }
