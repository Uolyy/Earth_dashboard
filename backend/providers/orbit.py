"""
Расчёт положения спутника по двухстрочным элементам орбиты (TLE).

Что такое TLE
-------------
Двухстрочные элементы орбиты — компактный текстовый формат,
в котором записаны параметры орбиты спутника: наклон плоскости,
эксцентриситет, положение восходящего узла, аргумент перицентра,
средняя аномалия и скорость изменения элементов. Формат был
стандартизирован для обмена данными между операторами систем
контроля космического пространства.

Алгоритм SGP4, реализованный в библиотеке `sgp4`, по этим
элементам восстанавливает положение аппарата в системе координат,
связанной с Землёй, для любого момента времени.

Зачем это нужно в дашборде
---------------------------
Положение МКС меняется непрерывно, а внешний источник обновляет
данные примерно раз в секунду. Между обращениями к источнику
координаты вычисляются локально по TLE, благодаря чему движение
станции на экране остаётся плавным и не зависит от частоты опроса.

Система координат
-----------------
Алгоритм SGP4 ведёт вычисления в системе TEME (True Equator,
Mean Equinox): начало координат находится в центре Земли, ось Z
направлена к северному полюсу, а ось X лежит в плоскости экватора.
Эта система привязана к звёздам и не вращается вместе с планетой,
поэтому напрямую её использовать нельзя: интерфейсу нужны привычные
географические широта и долгота, отсчитываемые от Гринвича, который
вращается вместе с Землёй. Перевод выполняется в функции `propagate`:
из инерциальной долготы вычитается звёздное время Гринвича — угол,
на который планета повернулась к запрошенному моменту.

Замечание о единицах измерения
------------------------------
Библиотека `sgp4` возвращает координаты и скорость в километрах
и километрах в секунду соответственно. Положение спутника на экране
рассчитывается в сценарии средства визуализации из этих величин
путём деления на радиус Земли.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

from sgp4.api import Satrec, WGS72, jday

from .. import settings

logger = logging.getLogger(__name__)


#: Базовый век, к которому прибавляются две последние цифры года в поле
#: эпохи TLE. Формат поля — `YYDDD.DDDDDDDD`, поэтому год записан
#: двузначным, а полный год получается прибавлением этого века.
TLE_EPOCH_BASE_YEAR = 2000


@dataclass(frozen=True)
class OrbitalState:
    """
    Положение спутника в один момент времени.

    Attributes
    ----------
    latitude_degrees : float
        Географическая широта в градусах, положительное значение
        соответствует северному полушарию.
    longitude_degrees : float
        Географическая долгота в градусах, значение лежит
        в диапазоне от -180 до 180.
    altitude_km : float
        Высота над поверхностью Земли в километрах.
    speed_km_s : float
        Скорость движения относительно поверхности Земли,
        в километрах в секунду.
    position_km : tuple[float, float, float]
        Радиус-вектор в системе координат TEME, в километрах.
    velocity_km_s : tuple[float, float, float]
        Вектор скорости в системе координат TEME,
        в километрах в секунду.
    minutes_since_epoch : float
        Время, прошедшее с эпохи элементов орбиты, в минутах.
    """

    latitude_degrees: float
    longitude_degrees: float
    altitude_km: float
    speed_km_s: float
    position_km: tuple[float, float, float]
    velocity_km_s: tuple[float, float, float]
    minutes_since_epoch: float

    def as_dict(self) -> dict:
        """
        Представляет состояние в виде словаря для передачи в JSON.

        Returns
        -------
        dict
            Словарь, пригодный для сериализации в JSON.
        """
        return {
            'latitude': round(self.latitude_degrees, 4),
            'longitude': round(self.longitude_degrees, 4),
            'altitude_km': round(self.altitude_km, 2),
            'speed_km_s': round(self.speed_km_s, 3),
            'position_km': [round(value, 2) for value in self.position_km],
            'velocity_km_s': [round(value, 4) for value in self.velocity_km_s],
            'minutes_since_epoch': round(self.minutes_since_epoch, 2),
        }


def unix_time_to_julian_date(unix_time: float) -> float:
    """
    Переводит время Unix в Julian Date.

    Parameters
    ----------
    unix_time : float
        Число секунд, прошедших с 1970-01-01 00:00:00 UTC.

    Returns
    -------
    float
        Соответствующее значение Julian Date.

    Notes
    -----
    Julian Date отсчитывается от 4713 года до н. э. и используется
    в астрономических расчётах как непрерывная шкала времени.
    Нулевой точке Unix-эпохи соответствует значение 2440587.5.
    """
    return unix_time / 86400.0 + settings.UNIX_EPOCH_JULIAN_DATE


def datetime_to_julian_date(moment: datetime) -> float:
    """
    Переводит момент времени в Julian Date.

    Parameters
    ----------
    moment : datetime
        Момент времени. Наивное время интерпретируется как UTC.

    Returns
    -------
    float
        Соответствующее значение Julian Date.
    """
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return unix_time_to_julian_date(moment.timestamp())


def julian_date_to_datetime(julian_date: float) -> datetime:
    """
    Переводит Julian Date обратно в момент времени.

    Parameters
    ----------
    julian_date : float
        Значение Julian Date.

    Returns
    -------
    datetime
        Соответствующий момент времени в часовом поясе UTC.
    """
    unix_time = (julian_date - settings.UNIX_EPOCH_JULIAN_DATE) * 86400.0
    return datetime.fromtimestamp(unix_time, tz=timezone.utc)


def build_satellite_recorder(tle_lines: Iterable[str]) -> Satrec:
    """
    Создаёт объект расчёта орбиты по двум строкам TLE.

    Parameters
    ----------
    tle_lines : Iterable[str]
        Строки TLE. Первая строка — описание аппарата,
        вторая и третья — собственно элементы орбиты.

    Returns
    -------
    Satrec
        Объект библиотеки `sgp4`, выполняющий расчёт положения
        спутника по заданным элементам орбиты.

    Raises
    ------
    ValueError
        Если переданное количество строк не равно двум.
        Некорректные значения внутри самих строк обрабатываются
        библиотекой самостоятельно.
    """
    lines = [line for line in tle_lines if line.strip()]
    if len(lines) < 2:
        raise ValueError(
            'Для расчёта орбиты необходимы две строки TLE, '
            f'получено строк: {len(lines)}'
        )

    # Берутся две последние непустые строки: элементы орбиты находятся
    # именно в них, тогда как предшествующая строка содержит название
    # аппарата и не является частью формата TLE.
    return Satrec.twoline2rv(lines[-2], lines[-1], WGS72)


def _true_epoch_julian_date(satellite: Satrec) -> float:
    """
    Возвращает Julian Date эпохи элементов орбиты без округления.

    Нужен для поля `minutes_since_epoch`, которое показывает, насколько
    расчёт отстал от эпохи элементов. Само положение от этого значения не
    зависит: оно вычисляется через `Satrec.sgp4`.

    Восстанавливается напрямую из исходной строки элементов, которую
    библиотека сохраняет в атрибуте `line1str`: готовые атрибуты для этого
    неудобны, так как `epochyr` хранит год в усечённом виде (`26` вместо
    `2026`).
    """
    line = getattr(satellite, 'line1str', None)
    if not line or len(line) < 32:
        return satellite.jdsatepoch

    try:
        epoch_field = float(line[18:32])
    except ValueError:
        return satellite.jdsatepoch

    # Поле эпохи записывается как `YYDDD.DDDDDDDD`: последние семь знаков
    # после точки — дробная часть дня года.
    year = int(epoch_field)
    day = epoch_field - year

    first_day, first_fraction = jday(TLE_EPOCH_BASE_YEAR + year, 1, 1, 0, 0, 0.0)
    epoch_julian_date = first_day + first_fraction + (day - 1.0)

    # Если восстановленная дата вышла за пределы здравого смысла,
    # источник повреждён и точное значение недоступно.
    if not 2400000.0 < epoch_julian_date < 2500000.0:
        return satellite.jdsatepoch

    return epoch_julian_date


def propagate(satellite: Satrec, moment: datetime) -> OrbitalState:
    """
    Вычисляет положение спутника для указанного момента времени.

    Parameters
    ----------
    satellite : Satrec
        Объект расчёта орбиты, созданный функцией `build_satellite_recorder`.
    moment : datetime
        Момент времени, для которого требуется положение.

    Returns
    -------
    OrbitalState
        Состояние спутника: координаты, высота и скорость.

    Raises
    ------
    RuntimeError
        Если алгоритм не смог вычислить положение. Такое возможно
        для устаревших или некорректных элементов орбиты.
    """
    moment_julian_date = datetime_to_julian_date(moment)

    # Положение считается напрямую по календарному моменту, а не через
    # satellite.sgp4_tsince. Проверено сравнением на одном и том же
    # элементе орбиты в один и тот же момент: sgp4_tsince в установленной
    # версии библиотеки (2.23) возвращает точку, отстоящую от верной на
    # 8489 километров. Сдвигом аргумента это не лечится: перебор времени с
    # шагом в сутки и в половину суток не даёт совпадения, то есть
    # расходится не начало отсчёта, а сам алгоритм. Вызов sgp4 с Julian Date
    # и его дробной частью совпадает с телеметрией источника в пределах
    # сотен километров, что объясняется возрастом элементов орбиты.
    julian_day, julian_fraction = jday(
        moment.year,
        moment.month,
        moment.day,
        moment.hour,
        moment.minute,
        moment.second,
    )

    error_code, position, velocity = satellite.sgp4(julian_day, julian_fraction)
    minutes_since_epoch = (
        moment_julian_date - _true_epoch_julian_date(satellite)
    ) * 1440.0

    if error_code != 0:
        raise RuntimeError(
            f'Не удалось вычислить положение спутника: '
            f'код ошибки {error_code}. Возможно, элементы орбиты устарели.'
        )

    position_x, position_y, position_z = position
    velocity_x, velocity_y, velocity_z = velocity

    distance_km = (position_x ** 2 + position_y ** 2 + position_z ** 2) ** 0.5
    speed_km_s = (velocity_x ** 2 + velocity_y ** 2 + velocity_z ** 2) ** 0.5

    # Переход от прямоугольных координат к географическим выполняется
    # по стандартным формулам: широта определяется наклоном радиус-вектора
    # к плоскости экватора.
    latitude_degrees = _degrees(_arcsin(position_z / distance_km))

    # С долготой требуется переход между системами координат. SGP4 отдаёт
    # положение в системе TEME, связанной со звёздами: её ось X направлена
    # на точку весеннего равноденствия и не вращается вместе с планетой.
    # Если взять угол напрямую, получится долгота относительно звёзд,
    # а не относительно Гринвича. Проверка на реальных элементах орбиты
    # МКС показывала расхождение с телеметрией порядка 180 градусов —
    # ровно на угол поворота Земли. Поэтому из инерциальной долготы
    # вычитается звёздное время Гринвича, а результат приводится
    # к диапазону от -180 до 180 градусов.
    inertial_longitude_degrees = _degrees(_arctan2(position_y, position_x))
    sidereal_angle_degrees = _degrees(
        greenwich_sidereal_angle(moment_julian_date)
    )
    longitude_degrees = _normalize_longitude_degrees(
        inertial_longitude_degrees - sidereal_angle_degrees
    )

    return OrbitalState(
        latitude_degrees=latitude_degrees,
        longitude_degrees=longitude_degrees,
        altitude_km=distance_km - settings.EARTH_RADIUS_KM,
        speed_km_s=speed_km_s,
        position_km=(position_x, position_y, position_z),
        velocity_km_s=(velocity_x, velocity_y, velocity_z),
        minutes_since_epoch=minutes_since_epoch,
    )


def propagate_track(
    satellite: Satrec,
    start_moment: datetime,
    duration_minutes: float,
    step_seconds: float = 60.0,
) -> list[dict]:
    """
    Вычисляет траекторию спутника на заданный промежуток времени.

    Функция используется для построения прогнозной линии орбиты
    и для отображения пройденного пути.

    Parameters
    ----------
    satellite : Satrec
        Объект расчёта орбиты.
    start_moment : datetime
        Начальный момент времени.
    duration_minutes : float
        Продолжительность прогноза в минутах.
    step_seconds : float
        Шаг по времени в секундах. Меньший шаг даёт более гладкую
        линию при большем объёме вычислений.

    Returns
    -------
    list[dict]
        Список состояний спутника, каждое из которых дополнительно
        содержит метку времени в формате ISO 8601 для удобства
        отображения в интерфейсе.
    """
    if duration_minutes <= 0 or step_seconds <= 0:
        return []

    track: list[dict] = []
    total_steps = int(duration_minutes * 60 / step_seconds)

    for step_index in range(total_steps + 1):
        moment = start_moment.timestamp() + step_index * step_seconds
        try:
            state = propagate(satellite, datetime.fromtimestamp(moment, tz=timezone.utc))
        except RuntimeError as error:
            logger.warning('Расчёт траектории прерван на шаге %d: %s', step_index, error)
            break

        state_dict = state.as_dict()
        state_dict['time'] = datetime.fromtimestamp(moment, tz=timezone.utc).isoformat()
        track.append(state_dict)

    return track


def greenwich_sidereal_angle(julian_date: float) -> float:
    """
    Возвращает угол поворота Земли (звёздное время Гринвича) в радианах.

    Зачем он нужен
    --------------
    Система TEME, в которой работает алгоритм SGP4, привязана к звёздам
    и не вращается вместе с Землёй: её ось X направлена на точку
    весеннего равноденствия. Географическая долгота отсчитывается от
    Гринвича, который поворачивается вместе с планетой. Разница между
    этими направлениями — и есть звёздное время: чтобы перейти от
    инерциальной долготы к географической, его нужно вычесть.

    Формула — стандартное приближение (IAU 1982): за каждые сутки,
    прошедшие с начала эпохи J2000, угол увеличивается на
    360,985647 градуса. Точность формулы — доли секунды дуги,
    что для визуализации заведомо достаточно.

    Parameters
    ----------
    julian_date : float
        Момент времени в формате Julian Date, по всемирному времени.

    Returns
    -------
    float
        Угол поворота Земли в радианах, в диапазоне от 0 до 2π.
    """
    import math

    days_since_j2000 = julian_date - 2451545.0
    degrees_value = (
        280.46061837
        + 360.98564736629 * days_since_j2000
    ) % 360.0
    return math.radians(degrees_value)


def _normalize_longitude_degrees(value: float) -> float:
    """
    Приводит долготу к диапазону от -180 до 180 градусов.

    Вычитание звёздного времени может увести долготу за привычные
    границы, поэтому значение оборачивается вокруг глобуса:
    угол 190 градусов означает то же самое, что -170.

    Parameters
    ----------
    value : float
        Долгота в градусах, произвольная по величине.

    Returns
    -------
    float
        Долгота в градусах в диапазоне от -180 до 180.
    """
    return (value + 180.0) % 360.0 - 180.0


def _degrees(radians: float) -> float:
    """
    Переводит угол из радиан в градусы.

    Parameters
    ----------
    radians : float
        Угол в радианах.

    Returns
    -------
    float
        Угол в градусах.
    """
    import math
    return math.degrees(radians)


def _arcsin(value: float) -> float:
    """
    Вычисляет арксинус с ограничением диапазона аргумента.

    Parameters
    ----------
    value : float
        Значение аргумента. Значения за пределами диапазона
        [-1, 1] — следствие накопления погрешности вычислений —
        приводятся к границам диапазона.

    Returns
    -------
    float
        Арксинус в радианах.
    """
    import math
    return math.asin(max(-1.0, min(1.0, value)))


def _arctan2(first: float, second: float) -> float:
    """
    Вычисляет арктангенс отношения двух величин.

    Parameters
    ----------
    first : float
        Числитель отношения.
    second : float
        Знаменатель отношения.

    Returns
    -------
    float
        Угол в радианах в диапазоне от -π до π.
    """
    import math
    return math.atan2(first, second)
