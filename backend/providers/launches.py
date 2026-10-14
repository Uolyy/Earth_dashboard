"""
Источник расписания запусков космических ракет.

Источник данных предоставляет сведения о предстоящих пусках:
название миссии, тип и конфигурацию ракеты-носителя, стартовую
площадку, предполагаемое время старта, вероятность успеха,
а также признак наличия трансляции в прямом эфире.

Особенности нормализации
------------------------
Время старта указывается источником в виде интервала: например,
окно запуска может составлять от двух до четырёх часов. В расчёте
обратного отсчёта используется начало окна, поскольку именно оно
позволяет сформулировать «не позднее этого времени», тогда как
конец окна означает «не раньше этого времени».

Значение вероятности (probability) передаётся как целое число
в процентах либо как `null`, если вероятность не определена.
Значение `null` означает, что запуск пока не подтверждён, и
интерфейс отображает это состояние отдельно, не подставляя
догадки вместо отсутствующих данных.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .. import settings
from ..cache import cached_json
from ..http_client import http_client

#: Ключ кэша для расписания запусков.
#: Расписание меняется сравнительно редко, поэтому запись хранится
#: достаточно долго, чтобы не обращаться к источнику при каждом
#: обновлении страницы.
CACHE_KEY = 'upcoming_launches'

#: Количество запусков, запрашиваемых у источника.
FETCH_LIMIT = 25

#: Статусы, означающие, что запуск уже состоялся и его исход известен.
#: Источник ещё некоторое время держит такие записи в списке
#: «upcoming» после старта, поэтому они отфильтровываются вручную:
#: интерфейс показывает первым элементом ближайший будущий запуск.
TERMINAL_STATUS_ABBREVS = frozenset({'Success', 'Failure', 'Partial Failure'})


def _parse_datetime(value: str | None) -> datetime | None:
    """
    Разбирает строку с датой и временем в формате ISO 8601.

    Parameters
    ----------
    value : str | None
        Строка с датой либо `None`.

    Returns
    -------
    datetime | None
        Разобранный момент времени с часовым поясом UTC
        либо `None`, если значение отсутствует или не разбирается.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


@cached_json(CACHE_KEY, ttl_seconds=900)
async def fetch_upcoming_launches() -> dict[str, Any]:
    """
    Запрашивает расписание предстоящих запусков.

    Returns
    -------
    dict[str, Any]
        Словарь со списком запусков, отсортированных по времени старта.
        Для каждого запуска указаны ключевые сведения, достаточные
        для отображения карточки и обратного отсчёта.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    url = settings.LAUNCHES_URL.format(limit=FETCH_LIMIT)
    raw_data = await http_client.fetch_json(url, 'расписание запусков')

    raw_launches = raw_data.get('results', [])
    launches: list[dict[str, Any]] = []

    now_moment = datetime.now(timezone.utc)

    for raw_launch in raw_launches:
        net_moment = _parse_datetime(raw_launch.get('net'))

        # Уже состоявшиеся запуски пропускаются. Источник ещё какое-то
        # время держит их в разделе «upcoming» после старта, а первым
        # элементом выборки интерфейс показывает ближайший запуск,
        # поэтому просроченные и завершённые записи сюда не попадают.
        status_data = raw_launch.get('status') or {}
        if status_data.get('abbrev') in TERMINAL_STATUS_ABBREVS:
            continue
        if net_moment is not None and net_moment <= now_moment:
            continue

        window_start = _parse_datetime(raw_launch.get('window_start')) or net_moment
        window_end = _parse_datetime(raw_launch.get('window_end')) or net_moment

        rocket_data = raw_launch.get('rocket') or {}
        rocket_configuration = rocket_data.get('configuration') or {}
        rocket_company = rocket_data.get('launch_service_provider') or {}

        mission_data = raw_launch.get('mission') or {}
        pad_data = raw_launch.get('pad') or {}
        location_data = pad_data.get('location') or {}

        # Значение probability приходит как число в процентах.
        # Отсутствие значения означает, что вероятность не определена.
        raw_probability = raw_launch.get('probability')

        launches.append({
            'id': raw_launch.get('id'),
            'name': raw_launch.get('name', 'Неизвестная миссия'),
            'status': raw_launch.get('status'),
            # Время начала окна запуска: именно по нему считается
            # обратный отсчёт, поскольку оно означает крайний срок старта.
            'net': net_moment.isoformat() if net_moment else None,
            'window_start': window_start.isoformat() if window_start else None,
            'window_end': window_end.isoformat() if window_end else None,
            # Длительность окна запуска в минутах. Позволяет показать,
            # насколько неопределённым является время старта.
            'window_duration_minutes': round(
                (window_end - window_start).total_seconds() / 60.0
            ) if window_start and window_end else None,
            # Точность указания времени: минута, час, день или квартал.
            # Отображается рядом с обратным отсчётом, поскольку при
            # невысокой точности обратный отсчёт является приблизительным.
            'net_precision': raw_launch.get('net_precision'),
            'probability': raw_probability,
            'has_probability': raw_probability is not None,
            'weather_concerns': raw_launch.get('weather_concerns'),
            'hold_reason': raw_launch.get('holdreason') or raw_launch.get('failreason'),
            'rocket_name': rocket_configuration.get('name', 'Неизвестная ракета'),
            'rocket_family': rocket_configuration.get('full_name')
            or rocket_configuration.get('name'),
            'rocket_provider': rocket_company.get('name'),
            'rocket_success_rate': _extract_success_rate(rocket_data),
            'mission_name': mission_data.get('name'),
            'mission_description': mission_data.get('description'),
            'mission_type': mission_data.get('type'),
            'pad_name': pad_data.get('name'),
            'location_name': location_data.get('name'),
            'location_country': location_data.get('country_code'),
            # Географические координаты площадки. Источник отдаёт их
            # в градусах; при отсутствии значения остаётся None,
            # и интерфейс не показывает ссылку на место запуска.
            'pad_latitude': pad_data.get('latitude'),
            'pad_longitude': pad_data.get('longitude'),
            'webcast_live': raw_launch.get('webcast_live') or False,
            'image_url': raw_launch.get('image'),
            'infographic_url': raw_launch.get('infographic'),
            'upcoming_count_year': raw_launch.get('orbital_launch_attempt_count_year'),
        })

    launches.sort(key=lambda launch: (launch['net'] is None, launch['net'] or ''))

    return {
        'launches': launches,
        'total_count': len(launches),
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
    }


def _extract_success_rate(rocket_data: dict[str, Any]) -> float | None:
    """
    Извлекает процент успешных пусков ракеты-носителя.

    Parameters
    ----------
    rocket_data : dict[str, Any]
        Раздел сведений о ракете-носителе из ответа источника.

    Returns
    -------
    float | None
        Доля успешных пусков в процентах либо `None`,
        если источник таких сведений не предоставил.
    """
    configuration = rocket_data.get('configuration') or {}
    stats = configuration.get('stats') or {}
    flights_total = stats.get('flights_total')
    flights_successful = stats.get('flights_successful')

    if not flights_total or flights_successful is None:
        return None

    return round(flights_successful / flights_total * 100.0, 1)
