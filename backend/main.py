"""
Веб-приложение «Орбитальный пост наблюдения».

Назначение
----------
Приложение собирает сведения о космических объектах из открытых
источников данных и предоставляет их интерфейсу в едином формате.

Почему данные проходят через сервер
-----------------------------------
Большинство источников, используемых проектом, отдают данные
в открытом доступе и без ключа, однако часть из них не разрешает
обращения напрямую из браузера: источник может не отдавать
заголовки, разрешающие кросс-доменные запросы, либо быть доступен
только по незащищённому протоколу. Собственный сервер решает эту
задачу, а заодно выполняет три дополнительные функции:

1. Нормализует ответы: приводит единицы измерения, названия полей
   и форматы дат к единому виду. Изменения во внешних источниках
   не приводят к ошибкам в интерфейсе.
2. Кэширует ответы: ограничивает частоту обращений к источникам
   и позволяет приложению пережить перезапуск без повторного
   сбора всех данных.
3. Рассчитывает орбиту: положение станции между обращениями
   к источнику вычисляется на сервере по элементам орбиты,
   что обеспечивает плавную анимацию.

Поведение при сбоях
-------------------
Каждый маршрут возвращает данные в единой оболочке, содержащей
признак успеха, сами данные и сведения о том, был ли ответ
получен из кэша. При недоступности источника маршрут возвращает
код 503 с описанием ошибки: интерфейс показывает в соответствующей
панели сообщение о недоступности источника, не нарушая работу
остальных панелей.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import settings
from .http_client import ExternalServiceError, http_client
from .providers import asteroids, iss, launches, orbit, satellites, space_weather

# Настройка журналирования выполняется до создания приложения,
# чтобы сообщения, возникающие при инициализации, также попадали в вывод.
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(name)s | %(message)s',
    datefmt='%H:%M:%S',
)
logger = logging.getLogger(__name__)

#: Директория со статическими файлами интерфейса.
FRONTEND_DIRECTORY: Path = Path(__file__).resolve().parent.parent / 'frontend'


def build_success_payload(
    data: Any,
    from_cache: bool = False,
) -> dict[str, Any]:
    """
    Формирует единообразный ответ API для успешного случая.

    Единая оболочка позволяет интерфейсу обрабатывать любой маршрут
    одинаковым образом: проверить признак успеха, прочитать данные
    и при необходимости показать сообщение об устаревшем кэше.

    Parameters
    ----------
    data : Any
        Полезная нагрузка ответа.
    from_cache : bool
        Признак того, что данные возвращены из кэша, а не получены
        напрямую. Используется интерфейсом для индикации актуальности.

    Returns
    -------
    dict[str, Any]
        Словарь с полями `ok`, `data`, `from_cache` и `served_at`.
    """
    return {
        'ok': True,
        'data': data,
        'from_cache': from_cache,
        'served_at': datetime.now(timezone.utc).isoformat(),
    }


def build_error_payload(error: Exception, service_name: str) -> dict[str, Any]:
    """
    Формирует единообразный ответ API для случая сбоя.

    Parameters
    ----------
    error : Exception
        Исключение, описывающее причину сбоя.
    service_name : str
        Человекочитаемое имя источника, недоступность которого
        вызвала сбой.

    Returns
    -------
    dict[str, Any]
        Словарь с признаком неуспеха, описанием ошибки и подсказкой.
    """
    return {
        'ok': False,
        'error': {
            'service': service_name,
            'message': str(error),
            # Подсказка объясняет интерфейсу, что показывать пользователю:
            # источник временно недоступен, остальные панели работают.
            'hint': (
                'Источник данных временно недоступен. '
                'Остальные панели продолжают работать.'
            ),
        },
        'served_at': datetime.now(timezone.utc).isoformat(),
    }


@asynccontextmanager
async def lifespan(application: FastAPI):
    """
    Управляет жизненным циклом приложения.

    Parameters
    ----------
    application : FastAPI
        Создаваемое приложение.

    Yields
    ------
    None
        Управление передаётся приложению на время его работы.

    Notes
    -----
    На старте каталог кэша создаётся заново: это предотвращает
    ошибки при первом обращении к кэшу после развёртывания.
    На остановке закрываются сетевые соединения клиента.
    """
    settings.CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    logger.info('Запуск приложения. Каталог кэша: %s', settings.CACHE_DIRECTORY)
    yield
    await http_client.close()
    logger.info('Приложение остановлено')


app = FastAPI(
    title='Орбитальный пост наблюдения',
    description=(
        'Дашборд космических околоземных объектов: телеметрия станции, '
        'экипаж, расписание запусков, астероиды, космическая погода '
        'и каталог спутников.'
    ),
    version='1.0.0',
    lifespan=lifespan,
)

# Разрешение кросс-доменных запросов позволяет открывать интерфейс
# не только с адреса сервера, но и, например, средствами предпросмотра
# редактора, которые поднимают собственный локальный сервер.
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['GET'],
    allow_headers=['*'],
)


#: Префиксы адресов, для которых запрещается кэширование.
#: Запросы к API сюда не входят: там кэширование полезно.
NO_CACHE_PATH_PREFIXES = ('/css', '/js', '/vendor', '/assets')


@app.middleware('http')
async def disable_frontend_cache(request, call_next):
    """
    Запрещает браузеру хранить файлы интерфейса.

    Без этого браузер возвращает ранее загруженные версии файлов
    интерфейса из своего кэша даже после того, как сервер уже отдал
    новые: приложение продолжает работать со старым оформлением
    или старой логикой до принудительного обновления страницы.

    Значение `no-cache` запрещает повторное использование без
    проверки актуальности: браузер переспрашивает сервер и получает
    свежую версию, если она действительно изменилась.
    """
    response = await call_next(request)

    path = request.url.path
    if path == '/' or path.startswith(NO_CACHE_PATH_PREFIXES):
        response.headers['Cache-Control'] = 'no-cache'

    return response


def register_endpoint(
    path: str,
    service_name: str,
    provider: Callable[[], Awaitable[Any]],
) -> None:
    """
    Регистрирует маршрут API, обращающийся к одному поставщику данных.

    Функция создаёт обработчик маршрута, который обращается к указанному
    поставщику, оборачивает полученные данные в оболочку ответа
    и переводит сбой источника в понятный ответ для интерфейса.
    Использование общего помощника избавляет каждый маршрут от повторения
    одинаковой последовательности действий.

    Parameters
    ----------
    path : str
        Адрес маршрута, например `/api/iss`.
    service_name : str
        Человекочитаемое имя источника для сообщений об ошибках
        и в описании маршрута.
    provider : Callable[[], Awaitable[Any]]
        Асинхронная функция без аргументов, возвращающая данные
        источника.
    """
    async def handler() -> JSONResponse:
        """
        Обрабатывает запрос: получает данные и формирует ответ.

        Returns
        -------
        JSONResponse
            Ответ с данными при успехе либо описание сбоя.
        """
        try:
            data = await provider()
            return JSONResponse(
                status_code=200,
                content=build_success_payload(data),
            )
        except ExternalServiceError as error:
            # Недоступность источника — ожидаемая ситуация при работе
            # с внешними сервисами, поэтому описывается отдельным кодом
            # ответа, а не как внутренняя ошибка приложения.
            logger.error('Маршрут %s: %s', path, error)
            return JSONResponse(
                status_code=503,
                content=build_error_payload(error, service_name),
            )
        except Exception as error:
            logger.exception('Непредвиденная ошибка в маршруте %s', path)
            return JSONResponse(
                status_code=500,
                content=build_error_payload(error, service_name),
            )

    # Имя обработчика используется в автоматически формируемой
    # документации, поэтому задаётся осмысленно.
    handler.__name__ = path.replace('/api/', '').replace('/', '_')

    app.get(path, tags=['Данные'], summary=service_name)(handler)


# ---------------------------------------------------------------------------
# Маршруты, отвечающие за отдельные источники данных
# ---------------------------------------------------------------------------

register_endpoint('/api/iss', 'телеметрия МКС', iss.fetch_iss_telemetry)
register_endpoint('/api/crew', 'экипаж станций', iss.fetch_crew)
register_endpoint('/api/launches', 'расписание запусков', launches.fetch_upcoming_launches)
register_endpoint('/api/asteroids', 'околеземные астероиды', asteroids.fetch_near_earth_asteroids)
register_endpoint('/api/asteroids/hazardous', 'опасные астероиды', asteroids.fetch_hazardous_asteroids)
@app.get('/api/asteroids/{designation}')
async def asteroid_details(designation: str) -> JSONResponse:
    """
    Возвращает подробные сведения об одном астероиде.

    Маршрут объявлен после маршрута списка опасных объектов:
    в FastAPI порядок объявления определяет приоритет, и благодаря
    этому запрос `/api/asteroids/hazardous` попадает в статический
    маршрут, а не воспринимается как обозначение астероида.
    """
    try:
        data = await asteroids.fetch_asteroid_details(designation)
        return JSONResponse(status_code=200, content=build_success_payload(data))
    except ExternalServiceError as error:
        return JSONResponse(
            status_code=503,
            content=build_error_payload(error, 'сведения об астероиде'),
        )


register_endpoint('/api/space-weather/geomagnetic', 'геомагнитная активность', space_weather.fetch_geomagnetic_activity)
register_endpoint('/api/space-weather/forecast', 'прогноз активности', space_weather.fetch_activity_forecast)
register_endpoint('/api/space-weather/solar-cycle', 'солнечный цикл', space_weather.fetch_solar_cycle)
register_endpoint('/api/space-weather/alerts', 'предупреждения', space_weather.fetch_space_weather_alerts)
register_endpoint('/api/satellites', 'каталог спутников', satellites.fetch_satellite_groups)
register_endpoint('/api/orbit/elements', 'элементы орбиты МКС', satellites.fetch_orbital_elements)


# ---------------------------------------------------------------------------
# Маршруты, выполняющие расчёты на стороне сервера
# ---------------------------------------------------------------------------

@app.get('/api/orbit/position', tags=['Расчёты'], summary='Текущее положение МКС')
async def get_current_position():
    """
    Возвращает текущее положение станции, рассчитанное по элементам орбиты.

    Returns
    -------
    JSONResponse
        Положение станции либо описание сбоя, если элементы орбиты
        недоступны.
    """
    try:
        elements = await satellites.get_iss_orbital_elements()
        if elements is None:
            # Отсутствие элементов означает, что источник ещё не
            # отвечал. В этом случае запускается их получение.
            elements = await satellites.fetch_orbital_elements()

        satellite = orbit.build_satellite_recorder(
            [elements['name'], elements['tle_line1'], elements['tle_line2']]
        )
        state = orbit.propagate(satellite, datetime.now(timezone.utc))

        return JSONResponse(
            status_code=200,
            content=build_success_payload({
                **state.as_dict(),
                'orbital_elements_epoch': satellite.jdsatepoch,
                'computed_at': datetime.now(timezone.utc).isoformat(),
            }),
        )
    except Exception as error:
        logger.exception('Не удалось вычислить положение МКС')
        return JSONResponse(
            status_code=503,
            content=build_error_payload(error, 'элементы орбиты МКС'),
        )


@app.get('/api/orbit/track', tags=['Расчёты'], summary='Траектория МКС')
async def get_orbit_track(
    minutes_ahead: int = 90,
    step_seconds: float = 60.0,
):
    """
    Возвращает траекторию станции на заданный промежуток времени.

    Параметры
    ---------
    minutes_ahead : int
        На сколько минут вперёд строится прогноз.
    step_seconds : float
        Шаг по времени в секундах.

    Returns
    -------
    JSONResponse
        Список точек траектории либо описание сбоя.
    """
    try:
        elements = await satellites.get_iss_orbital_elements()
        if elements is None:
            elements = await satellites.fetch_orbital_elements()

        satellite = orbit.build_satellite_recorder(
            [elements['name'], elements['tle_line1'], elements['tle_line2']]
        )

        start_moment = datetime.now(timezone.utc)
        track = orbit.propagate_track(
            satellite, start_moment, minutes_ahead, step_seconds
        )

        # Дополнительно строится траектория за прошедший промежуток,
        # чтобы интерфейс мог показать, где станция уже побывала.
        past_track = orbit.propagate_track(
            satellite,
            start_moment - timedelta(minutes=45),
            45,
            step_seconds,
        )

        return JSONResponse(
            status_code=200,
            content=build_success_payload({
                'future_track': track,
                'past_track': past_track,
                'minutes_ahead': minutes_ahead,
                'step_seconds': step_seconds,
            }),
        )
    except Exception as error:
        logger.exception('Не удалось построить траекторию МКС')
        return JSONResponse(
            status_code=503,
            content=build_error_payload(error, 'элементы орбиты МКС'),
        )


@app.get('/api/orbit/pass', tags=['Расчёты'], summary='Прогноз прохода над точкой')
async def get_pass_prediction(latitude: float, longitude: float):
    """
    Рассчитывает ближайшие проходы станции над точкой на поверхности.

    Параметры
    ---------
    latitude : float
        Широта точки наблюдения в градусах.
    longitude : float
        Долгота точки наблюдения в градусах.

    Returns
    -------
    JSONResponse
        Список проходов с указанием времени, максимальной высоты
        над горизонтом и признака видимости в сумерках.

    Notes
    -----
    Проход считается наблюдаемым, если станция поднимается выше
    10 градусов над горизонтом: более низкие положения скрыты
    рельефом и зданиями на практике.
    """
    try:
        elements = await satellites.get_iss_orbital_elements()
        if elements is None:
            elements = await satellites.fetch_orbital_elements()

        satellite = orbit.build_satellite_recorder(
            [elements['name'], elements['tle_line1'], elements['tle_line2']]
        )

        passes = _calculate_passes(satellite, latitude, longitude)

        return JSONResponse(
            status_code=200,
            content=build_success_payload({
                'location': {'latitude': latitude, 'longitude': longitude},
                'passes': passes,
            }),
        )
    except Exception as error:
        logger.exception('Не удалось рассчитать проходы МКС')
        return JSONResponse(
            status_code=503,
            content=build_error_payload(error, 'элементы орбиты МКС'),
        )


def _calculate_passes(
    satellite: orbit.Satrec,
    latitude: float,
    longitude: float,
    horizon_hours: float = 48.0,
    step_seconds: float = 30.0,
) -> list[dict[str, Any]]:
    """
    Вычисляет проходы спутника над заданной точкой поверхности.

    Parameters
    ----------
    satellite : orbit.Satrec
        Объект расчёта орбиты.
    latitude : float
        Широта точки наблюдения в градусах.
    longitude : float
        Долгота точки наблюдения в градусах.
    horizon_hours : float
        На сколько часов вперёд выполняется расчёт.
    step_seconds : float
        Шаг по времени в секундах. Значение определяет точность
        максимальной высоты в моменте наивысшего положения.

    Returns
    -------
    list[dict[str, Any]]
        Список проходов, отсортированный по времени наступления.
    """
    import math

    # Координаты точки наблюдения заданы в системе, связанной с
    # поверхностью Земли. Спутник же считается в системе TEME,
    # привязанной к звёздам. Чтобы сравнивать эти положения, точку
    # наблюдения нужно поворачивать вместе с планетой: угол поворота
    # (звёздное время Гринвича) зависит от момента времени, поэтому
    # вычисляется на каждом шаге цикла.
    latitude_radians = math.radians(latitude)
    longitude_radians = math.radians(longitude)
    equatorial_projection = math.cos(latitude_radians) * settings.EARTH_RADIUS_KM
    polar_projection = math.sin(latitude_radians) * settings.EARTH_RADIUS_KM

    start_moment = datetime.now(timezone.utc)
    total_steps = int(horizon_hours * 3600 / step_seconds)

    passes: list[dict[str, Any]] = []
    current_pass: dict[str, Any] | None = None

    for step_index in range(total_steps + 1):
        moment = start_moment + timedelta(seconds=step_index * step_seconds)

        try:
            state = orbit.propagate(satellite, moment)
        except RuntimeError:
            break

        # Положение точки наблюдения в той же системе координат, что
        # и спутник: к долготе точки прибавляется поворот планеты
        # на текущее звёздное время.
        sidereal_angle = orbit.greenwich_sidereal_angle(
            orbit.datetime_to_julian_date(moment),
        )
        rotated_longitude = longitude_radians + sidereal_angle
        observer_x = equatorial_projection * math.cos(rotated_longitude)
        observer_y = equatorial_projection * math.sin(rotated_longitude)
        observer_z = polar_projection

        # Вектор от точки наблюдения к спутнику.
        to_satellite_x = state.position_km[0] - observer_x
        to_satellite_y = state.position_km[1] - observer_y
        to_satellite_z = state.position_km[2] - observer_z

        total_distance = (
            to_satellite_x ** 2 + to_satellite_y ** 2 + to_satellite_z ** 2
        ) ** 0.5

        # Угол возвышения над местным горизонтом. Горизонт — плоскость,
        # перпендикулярная радиус-вектору точки наблюдения, поэтому угол
        # вычисляется как проекция направления на спутник на вертикаль:
        # ноль означает «на горизонте», 90 градусов — «в зените».
        # Прежний расчёт от плоскости экватора на средних широтах
        # завышал угол в десятки градусов.
        direction_to_satellite = (
            to_satellite_x * observer_x
            + to_satellite_y * observer_y
            + to_satellite_z * observer_z
        ) / (total_distance * settings.EARTH_RADIUS_KM)

        elevation_degrees = math.degrees(
            math.asin(max(-1.0, min(1.0, direction_to_satellite)))
        )

        if elevation_degrees > 10.0:
            if current_pass is None:
                # Спутник поднялся выше горизонта: начинается новый проход.
                current_pass = {
                    'start_time': moment.isoformat(),
                    'start_visibility': state.as_dict(),
                    'max_elevation_degrees': elevation_degrees,
                    'max_elevation_time': moment.isoformat(),
                    'is_visible_now': True,
                }
            elif elevation_degrees > current_pass['max_elevation_degrees']:
                # Обновляется отметка наивысшего положения прохода.
                current_pass['max_elevation_degrees'] = elevation_degrees
                current_pass['max_elevation_time'] = moment.isoformat()
        elif current_pass is not None:
            # Спутник опустился ниже горизонта: проход завершён.
            current_pass['end_time'] = moment.isoformat()
            current_pass['duration_seconds'] = round(
                (
                    datetime.fromisoformat(current_pass['end_time'])
                    - datetime.fromisoformat(current_pass['start_time'])
                ).total_seconds()
            )
            passes.append(current_pass)
            current_pass = None

    # Незавершённый проход добавляется в результат: он продолжается
    # за пределами рассмотренного промежутка времени, но уже сейчас
    # виден наблюдателю, поэтому пропускать его не следует.
    if current_pass is not None:
        current_pass['end_time'] = None
        current_pass['duration_seconds'] = None
        passes.append(current_pass)

    return passes


@app.get('/api/status', tags=['Служебное'], summary='Состояние источников')
async def get_sources_status():
    """
    Проверяет доступность каждого источника данных.

    Функция опрашивает источники параллельно и возвращает результат
    по каждому из них, что позволяет интерфейсу честно показать,
    какие данные актуальны, а какие недоступны.

    Returns
    -------
    JSONResponse
        Список источников с признаком доступности и временем проверки.
    """
    # Список намеренно включает только дешёвые и быстрые источники:
    # полная проверка всех маршрутов заняла бы слишком много времени.
    checks: list[tuple[str, Callable[[], Awaitable[Any]]]] = [
        ('телеметрия МКС', iss.fetch_iss_telemetry),
        ('экипаж станций', iss.fetch_crew),
        ('расписание запусков', launches.fetch_upcoming_launches),
        ('околоземные астероиды', asteroids.fetch_near_earth_asteroids),
        ('геомагнитная активность', space_weather.fetch_geomagnetic_activity),
        ('каталог спутников', satellites.fetch_satellite_groups),
    ]

    async def run_check(name: str, check: Callable[[], Awaitable[Any]]) -> dict[str, Any]:
        """
        Выполняет одну проверку и формирует результат по ней.

        Parameters
        ----------
        name : str
            Название источника.
        check : Callable[[], Awaitable[Any]]
            Функция, обращающаяся к источнику.

        Returns
        -------
        dict[str, Any]
            Результат проверки.
        """
        try:
            await check()
            return {'name': name, 'available': True, 'checked_at': datetime.now(timezone.utc).isoformat()}
        except Exception as error:
            return {
                'name': name,
                'available': False,
                'error': str(error),
                'checked_at': datetime.now(timezone.utc).isoformat(),
            }

    results = await asyncio.gather(
        *(run_check(name, check) for name, check in checks)
    )

    return JSONResponse(
        status_code=200,
        content=build_success_payload({
            'sources': list(results),
            'available_count': sum(1 for result in results if result['available']),
            'total_count': len(results),
        }),
    )


# ---------------------------------------------------------------------------
# Раздача статических файлов интерфейса
# ---------------------------------------------------------------------------

@app.get('/', include_in_schema=False)
async def serve_index():
    """
    Отдаёт главную страницу интерфейса.

    Returns
    -------
    FileResponse
        Файл `index.html` из каталога интерфейса.
    """
    return FileResponse(FRONTEND_DIRECTORY / 'index.html')


# Подключение каталогов статических файлов выполняется последним,
# чтобы объявленные выше маршруты обрабатывались до обращения
# к файловой системе: иначе запросы к адресам API перехватывались бы
# обработчиком статических файлов.
app.mount(
    '/css',
    StaticFiles(directory=FRONTEND_DIRECTORY / 'css'),
    name='css',
)
app.mount(
    '/js',
    StaticFiles(directory=FRONTEND_DIRECTORY / 'js'),
    name='js',
)
app.mount(
    '/vendor',
    StaticFiles(directory=FRONTEND_DIRECTORY / 'vendor'),
    name='vendor',
)
app.mount(
    '/assets',
    StaticFiles(directory=FRONTEND_DIRECTORY / 'assets'),
    name='assets',
)
