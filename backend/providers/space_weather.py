"""
Источник сведений о космической погоде.

Что такое космическая погода
---------------------------
Состояние среды в околоземном пространстве определяется
взаимодействием Солнца с магнитным полем Земли. Потоки
заряженных частиц, выбрасываемые Солнцем, создают возмущения
магнитного поля, которые вносят помехи в радиосвязь, влияют
на работу спутников и электронных сетей, а также отражаются
на видимости полярных сияний.

Индекс геомагнитной активности
------------------------------
Индекс Kp — безразмерная величина, характеризующая возмущённость
магнитного поля Земли. Значения шкалы:

    G1 (слабая)  Kp = 5
    G2 (умеренная) Kp = 6
    G3 (сильная)   Kp = 7
    G4 (серьёзная) Kp = 8
    G5 (экстремальная) Kp = 9

Значения индекса представлены в диапазоне от 0 (полное спокойствие)
до 9 (экстремальная возмущённость). В исторических рядах индекс
записывается с шагом в три часа, а современная служба наблюдения
дополнительно публикует оценочные значения с шагом в минуту.

Солнечный цикл
--------------
Количество солнечной активности меняется с периодом примерно
в 11 лет, образуя цикл. Активность характеризуется числом
солнечных пятен. Цикл состоит из фазы роста, фазы максимума
и фазы спада. Знание текущей фазы позволяет предсказать
интенсивность геомагнитной активности в ближайшие годы.

Все источники этого модуля предоставляют данные в открытом
доступе и не требуют ключа или регистрации.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .. import settings
from ..cache import cached_json
from ..http_client import http_client

#: Ключи кэша для отдельных наборов данных.
GEOMAGNETIC_CACHE_KEY = 'space_weather_geomagnetic'
FORECAST_CACHE_KEY = 'space_weather_forecast'
SOLAR_CYCLE_CACHE_KEY = 'space_weather_solar_cycle'
ALERTS_CACHE_KEY = 'space_weather_alerts'

#: Описание уровней геомагнитной активности по шкале NOAA.
#: Ключ — значение индекса Kp, округлённое до целого;
#: значение — пара из обозначения уровня и его описания.
STORM_SCALE = {
    0: ('G0', 'Спокойная обстановка'),
    5: ('G1', 'Слабая буря'),
    6: ('G2', 'Умеренная буря'),
    7: ('G3', 'Сильная буря'),
    8: ('G4', 'Серьёзная буря'),
    9: ('G5', 'Экстремальная буря'),
}


def describe_geomagnetic_level(kp_index: float | None) -> dict[str, str]:
    """
    Определяет уровень геомагнитной активности по значению индекса.

    Функция обращается к шкале, публикуемой службой прогнозов,
    поскольку на границах между уровнями возможны дробные значения
    индекса, и округление «вниз» дало бы заниженную оценку.

    Parameters
    ----------
    kp_index : float | None
        Значение индекса геомагнитной активности.

    Returns
    -------
    dict[str, str]
        Словарь с обозначением уровня, его описанием и указанием
        на то, начинается ли шкала с этого уровня.
    """
    if kp_index is None:
        return {'level': 'G0', 'label': 'Нет данных', 'is_storm': False}

    rounded_value = int(round(kp_index))
    if rounded_value <= 0:
        return {'level': 'G0', 'label': 'Спокойная обстановка', 'is_storm': False}
    if rounded_value > 9:
        rounded_value = 9

    # Поиск начинается с наибольшего уровня, поскольку уровни
    # заданы как нижние границы соответствующих диапазонов.
    thresholds = sorted(STORM_SCALE.keys(), reverse=True)
    for threshold in thresholds:
        if rounded_value >= threshold:
            level, label = STORM_SCALE[threshold]
            return {
                'level': level,
                'label': label,
                'is_storm': threshold >= 5,
            }

    return {'level': 'G0', 'label': 'Спокойная обстановка', 'is_storm': False}


@cached_json(GEOMAGNETIC_CACHE_KEY, ttl_seconds=300)
async def fetch_geomagnetic_activity() -> dict[str, Any]:
    """
    Запрашивает текущий индекс геомагнитной активности и его историю.

    Returns
    -------
    dict[str, Any]
        Текущее значение индекса, его уровень и ряд наблюдений
        за последние сутки для построения графика.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    url = f'{settings.SPACE_WEATHER_BASE_URL}/json/planetary_k_index_1m.json'
    raw_data = await http_client.fetch_json(url, 'индекс геомагнитной активности')

    # Источник публикует записи по одной на каждую минуту.
    # Для графика такая детализация избыточна: ряд сокращается
    # до одной записи в десять минут, что сохраняет форму кривой
    # и существенно уменьшает объём передаваемых данных.
    observations: list[dict[str, Any]] = []
    step = max(1, len(raw_data) // 144)

    for raw_record in raw_data[::step]:
        kp_value = raw_record.get('kp_index')
        if kp_value is None:
            continue
        observations.append({
            'time': raw_record.get('time_tag'),
            'kp_index': float(kp_value),
        })

    latest_value = observations[-1] if observations else None

    return {
        'current_kp': latest_value['kp_index'] if latest_value else None,
        'current_time': latest_value['time'] if latest_value else None,
        'current_level': describe_geomagnetic_level(
            latest_value['kp_index'] if latest_value else None
        ),
        'maximum_kp_24h': max(
            (observation['kp_index'] for observation in observations),
            default=None,
        ),
        'average_kp_24h': (
            round(sum(observation['kp_index'] for observation in observations)
                  / len(observations), 2)
            if observations else None
        ),
        'history': observations,
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
    }


@cached_json(FORECAST_CACHE_KEY, ttl_seconds=3600)
async def fetch_activity_forecast() -> dict[str, Any]:
    """
    Запрашивает прогноз геомагнитной активности на трое суток.

    Returns
    -------
    dict[str, Any]
        Прогноз по суткам с указанием ожидаемого уровня активности
        и времени его наступления.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    url = f'{settings.SPACE_WEATHER_BASE_URL}/products/noaa-planetary-k-index-forecast.json'
    raw_data = await http_client.fetch_json(url, 'прогноз геомагнитной активности')

    # Ответ представляет собой список записей, каждая из которых
    # содержит метку времени, прогнозируемое значение индекса
    # и признак того, относится ли запись к наблюдениям
    # или к прогнозу.
    forecasts: list[dict[str, Any]] = []

    for record in raw_data:
        if not isinstance(record, dict):
            continue
        kp_value = record.get('kp')
        if kp_value is None:
            continue
        forecasts.append({
            'time': record.get('time_tag'),
            'kp_index': float(kp_value),
            'level': describe_geomagnetic_level(float(kp_value)),
            # Признак различает уже произошедшие события
            # и ожидаемые: интерфейс окрашивает их по-разному.
            'is_observed': record.get('observed') == 'observed',
        })

    forecasts.sort(key=lambda forecast: forecast['time'])

    return {
        'forecasts': forecasts,
        'maximum_kp_expected': max(
            (forecast['kp_index'] for forecast in forecasts), default=None
        ),
        'storm_expected': any(
            forecast['level']['is_storm'] for forecast in forecasts
        ),
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
    }


@cached_json(SOLAR_CYCLE_CACHE_KEY, ttl_seconds=43200)
async def fetch_solar_cycle() -> dict[str, Any]:
    """
    Запрашивает наблюдавшиеся и прогнозируемые показатели солнечного цикла.

    Возвращаются два ряда: фактические значения числа солнечных пятен
    и прогнозные значения для текущего цикла. Сопоставление этих
    рядов позволяет определить, насколько наблюдаемая активность
    соответствует ожиданиям.

    Returns
    -------
    dict[str, Any]
        Фактический и прогнозируемый ряды показателей,
        текущее состояние цикла и ближайший ожидаемый максимум.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    observed_url = (
        f'{settings.SPACE_WEATHER_BASE_URL}'
        '/json/solar-cycle/observed-solar-cycle-indices.json'
    )
    predicted_url = (
        f'{settings.SPACE_WEATHER_BASE_URL}'
        '/products/solar-cycle-25-ssn-predicted-range.json'
    )

    observed_data = await http_client.fetch_json(
        observed_url, 'наблюдения солнечного цикла'
    )
    predicted_data = await http_client.fetch_json(
        predicted_url, 'прогноз солнечного цикла'
    )

    observed_series: list[dict[str, Any]] = []
    for record in observed_data:
        # Источник обозначает отсутствие наблюдений значением -1.
        # Такие записи не включаются в ряд, поскольку они не несут
        # сведений об активности.
        smoothed_value = record.get('smoothed_ssn')
        if smoothed_value is None or float(smoothed_value) < 0:
            continue
        observed_series.append({
            'period': record.get('time-tag'),
            'sunspot_number': float(smoothed_value),
        })

    # Ряд наблюдений с 1749 года содержит свыше трёх тысяч точек.
    # Для отображения передаются только значения последних полных циклов
    # и текущего, что сохраняет читаемость графика.
    observed_series = observed_series[-300:]

    predicted_series: list[dict[str, Any]] = []
    for record in predicted_data:
        predicted_series.append({
            'period': record.get('time-tag'),
            # Прогнозный ряд задаётся интервалом: нижняя и верхняя
            # границы отражают неопределённость прогноза.
            'predicted_low': record.get('ssn-low'),
            'predicted_high': record.get('ssn-high'),
            'predicted_mid': record.get('ssn-high') and record.get('ssn-low')
            and round((record['ssn-low'] + record['ssn-high']) / 2.0, 1),
        })

    latest_observed = observed_series[-1] if observed_series else None

    return {
        'observed': observed_series,
        'predicted': predicted_series,
        'current_sunspot_number': (
            latest_observed['sunspot_number'] if latest_observed else None
        ),
        'current_period': latest_observed['period'] if latest_observed else None,
        'cycle_number': 25,
        # Максимум текущего цикла ожидается в середине второго десятилетия
        # 2020-х годов; значение используется для расчёта обратного отсчёта.
        'expected_maximum_period': '2025-04',
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
    }


@cached_json(ALERTS_CACHE_KEY, ttl_seconds=600)
async def fetch_space_weather_alerts() -> dict[str, Any]:
    """
    Запрашивает действующие предупреждения о космической погоде.

    Returns
    -------
    dict[str, Any]
        Список действующих предупреждений с указанием вида явления
        и времени действия.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    url = f'{settings.SPACE_WEATHER_BASE_URL}/products/alerts.json'
    raw_data = await http_client.fetch_json(url, 'предупреждения о космической погоде')

    alerts: list[dict[str, Any]] = []
    for record in raw_data:
        alerts.append({
            'event': record.get('event'),
            'issued': record.get('issue_datetime'),
            'effective': record.get('begin_datetime'),
            'expires': record.get('end_datetime'),
            'severity': record.get('severity'),
            'description': record.get('description'),
            'affected': record.get('affected_region'),
        })

    return {
        'alerts': alerts,
        'active_alerts_count': len(alerts),
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
    }
