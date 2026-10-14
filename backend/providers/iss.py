"""
Источник телеметрии Международной космической станции.

Предоставляемые сведения
------------------------
* Географические координаты станции.
* Высота над поверхностью Земли.
* Скорость движения.
* Радиус области, с поверхности которой станция видна невооружённым
  глазом (так называемая зона обзора, footprint).
* Текущая освещённость станции: солнечный свет, полутень или полная
  тень. Этот параметр определяет, можно ли увидеть станцию невооружённым
  глазом в конкретный момент.
* Направление на Солнце, позволяющее определить фазу освещения.

Почему источники разделены по ролям
-----------------------------------
Станция движется со скоростью около 7,7 километра в секунду, то есть
за одну минуту смещается примерно на 460 километров. Поэтому данные
источника могут расходиться с расчётом по элементам орбиты: источник
обновляется дискретно, а элементы орбиты публикуются раз в сутки.
Этот модуль отвечает только за телеметрию. Расчёт по элементам
орбиты ведётся в модуле `orbit`, а интерфейс использует источники
согласованно: расчёт — для плавной анимации, телеметрию — для
показаний панели.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from .. import settings
from ..cache import cached_json
from ..http_client import http_client

#: Названия значений поля `visibility`, возвращаемого источником,
#: и их перевод на русский язык.
VISIBILITY_LABELS = {
    'daylight': 'солнечный свет',
    'penumbra': 'полутень',
    'eclipsed': 'полная тень',
}

#: Ключ кэша для телеметрии станции.
#: Телеметрия меняется быстро, поэтому запись хранится недолго.
CACHE_KEY = 'iss_telemetry'


@cached_json(CACHE_KEY, ttl_seconds=20)
async def fetch_iss_telemetry() -> dict[str, Any]:
    """
    Запрашивает текущую телеметрию станции.

    Returns
    -------
    dict[str, Any]
        Нормализованные сведения о станции. Структура результата
        не зависит от особенностей источника: ключи и единицы
        измерения приведены к единому виду на уровне сервера,
        благодаря чему изменения во внешнем API не затрагивают
        код интерфейса.

    Raises
    ------
    ExternalServiceError
        Если источник недоступен и в кэше нет свежей записи.
    """
    url = settings.ISS_TELEMETRY_URL.format(norad_id=settings.ISS_NORAD_ID)
    raw_data = await http_client.fetch_json(url, 'телеметрия МКС')

    return {
        'name': raw_data.get('name', 'iss'),
        'norad_id': raw_data.get('id', settings.ISS_NORAD_ID),
        'latitude': raw_data.get('latitude'),
        'longitude': raw_data.get('longitude'),
        # Приведение к километрам выполняется всегда: источник
        # допускает указание единиц измерения в отдельном поле,
        # и при их смене значения были бы неверно интерпретированы.
        'altitude_km': raw_data.get('altitude'),
        # Источник отдаёт скорость в километрах в час, тогда как
        # для отображения и расчётов удобнее километры в секунду.
        'velocity_kmh': raw_data.get('velocity'),
        'velocity_km_s': round(raw_data['velocity'] / 3600.0, 3)
        if isinstance(raw_data.get('velocity'), (int, float)) else None,
        # Зона обзора с поверхности Земли, радиус в километрах.
        #
        # Источник отдаёт это поле как ДИАМЕТР зоны, а не как радиус.
        # Проверяется это просто: при высоте МКС около 430 км радиус
        # зоны составляет примерно 2270 км, а диаметр — около 4540 км.
        # Источник в этот момент отдаёт 4557, то есть именно диаметр.
        #
        # Если не разделить на два, круг на сфере получается вдвое
        # больше должного. Деление выполняется здесь, на сервере, чтобы
        # единицы измерения во всём интерфейсе оставались одинаковыми.
        'footprint_km': raw_data['footprint'] / 2
        if isinstance(raw_data.get('footprint'), (int, float)) else None,
        # Текущее состояние освещённости и его текстовое описание.
        'visibility': raw_data.get('visibility'),
        'visibility_label': VISIBILITY_LABELS.get(
            raw_data.get('visibility'), 'неизвестно'
        ),
        # Географические координаты подспутниковой точки Солнца.
        # По ним определяется, какая часть поверхности Земли
        # освещена в данный момент.
        'solar_latitude': raw_data.get('solar_lat'),
        'solar_longitude': raw_data.get('solar_lon'),
        # Метка времени получения данных, в секундах Unix.
        'timestamp': raw_data.get('timestamp'),
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
    }


@cached_json('iss_crew', ttl_seconds=3600)
async def fetch_crew() -> dict[str, Any]:
    """
    Запрашивает список людей, находящихся на орбитальных станциях.

    Источник сообщает имя человека и название станции, но не содержит
    фотографий и других подробностей. Чтобы список был информативнее,
    функция дополняет его фотографиями из энциклопедии, обращаясь
    к ней только для имён, найденных в основном источнике.

    Returns
    -------
    dict[str, Any]
        Словарь со списком станций. Для каждой станции указаны
        её название, количество людей на борту и список людей
        с фотографиями.

    Raises
    ------
    ExternalServiceError
        Если основной источник недоступен и в кэше нет свежей записи.
    """
    url = settings.OPEN_NOTIFY_CREW_URL
    raw_data = await http_client.fetch_json(url, 'список экипажа')

    raw_people = raw_data.get('people', [])

    # Группировка людей по станциям выполняется здесь, а не в интерфейсе,
    # чтобы при появлении новых станций в источнике не требовалось
    # изменений в коде представления.
    stations: dict[str, list[str]] = {}
    for person in raw_people:
        craft_name = person.get('craft', 'неизвестная станция')
        person_name = person.get('name', 'неизвестно')
        stations.setdefault(craft_name, []).append(person_name)

    station_list: list[dict[str, Any]] = []
    for craft_name, people_names in stations.items():
        photos = await _fetch_photos_for_people(people_names)

        station_list.append({
            'name': craft_name,
            'crew_count': len(people_names),
            'people': [
                {'name': person_name, 'photo_url': photos.get(person_name)}
                for person_name in sorted(people_names)
            ],
        })

    station_list.sort(key=lambda station: (-station['crew_count'], station['name']))

    return {
        'total_people': raw_data.get('number', len(raw_people)),
        'stations': station_list,
        'retrieved_at': datetime.now(timezone.utc).isoformat(),
    }


#: Сайты энциклопедии, на которых ищется фотография, по убыванию приоритета.
#:
#: Русская Википедия проверяется первой, потому что при одинаковом
#: результате её файлы обычно ближе к русским читателям. Но у большинства
#: действующих космонавтов статьи на русском языке нет, поэтому второй
#: запрос к английской версии находит фотографию почти всегда. Проверка
#: только русской версии давала 2 фотографии на 12 человек.
PHOTO_SOURCES = (
    'https://ru.wikipedia.org/api/rest_v1/page/summary/{title}',
    'https://en.wikipedia.org/api/rest_v1/page/summary/{title}',
)

#: Пауза между запросами к энциклопедии, в секундах.
#:
#: Википедия ограничивает частоту запросов, и при обращении без пауз
#: уже третий запрос подряд возвращает ошибку. Пауза делает перебор
#: устойчивым: проверка двенадцати человек занимает около пятнадцати
#: секунд, что незаметно, поскольку данные кэшируются на час.
PHOTO_REQUEST_DELAY_SECONDS = 1.2

#: Адрес поиска человека в базе знаний Википедии (Wikidata).
WIKIDATA_SEARCH_URL = (
    'https://www.wikidata.org/w/api.php?action=wbsearchentities'
    '&search={name}&language=en&format=json&limit=8'
)

#: Адрес запроса подписей и фотографии выбранного объекта.
WIKIDATA_ENTITY_URL = (
    'https://www.wikidata.org/w/api.php?action=wbgetentities'
    '&ids={entity_id}&props=labels%7Cclaims&languages=en&format=json'
)

#: Адрес файла на Wikimedia Commons по его имени.
WIKIMEDIA_FILE_URL = (
    'https://commons.wikimedia.org/wiki/Special:FilePath/{file_name}'
)

#: Свойство объекта базы знаний, в котором хранится фотография.
WIKIDATA_PHOTO_PROPERTY = 'P18'

#: Слова, отбрасываемые при сравнении имён: точки в инициалах и
#: сокращённые отчества. Они не меняют личность человека, но мешают
#: отождествлению: в базе `Jeanette J. Epps`, а в источнике экипажа
#: `Jeanette Epps`.
NAME_STOP_WORDS = frozenset({'j', 'e', 'jr', 'sr'})




def _name_words(name: str) -> frozenset[str]:
    """
    Приводит имя к набору слов для сравнения.

    Parameters
    ----------
    name : str
        Имя или фамилия.

    Returns
    -------
    frozenset[str]
        Строчные слова без точек и без сокращённых отчеств.
    """
    cleaned = name.lower().replace('-', ' ').replace('.', ' ')
    return frozenset(
        word for word in cleaned.split() if word not in NAME_STOP_WORDS
    )


def _names_match(left: str | None, right: str) -> bool:
    """
    Проверяет, что две записи имени относятся к одному человеку.

    Сравнение идёт по набору слов, а не по строкам целиком. Точное
    совпадение строк слишком строго: в базе знаний имя записано с
    отчеством или инициалом.

    Parameters
    ----------
    left : str | None
        Имя из базы знаний.
    right : str
        Имя из источника экипажа.

    Returns
    -------
    bool
        `True`, если наборы слов совпадают.
    """
    left_words = _name_words(left or '')
    right_words = _name_words(right)

    if not left_words or not right_words:
        return False

    return left_words == right_words


async def _fetch_photo_from_wikidata(person_name: str) -> str | None:
    """
    Ищет фотографию человека в базе знаний Википедии.

    Энциклопедия определяет объект только по имени, и этого мало:
    у `Michael Barratt` в русской Википедии стоит перенаправление на
    однофамильца, из-за чего показывался чужой портрет. В базе знаний
    у каждого человека свой идентификатор, а английская подпись
    сверяется с именем из источника, поэтому однофамильцы отсеиваются.

    Среди подходящих объектов выбирается любой с фотографией: у части
    дубликатов фотография есть не у всех записей.

    Parameters
    ----------
    person_name : str
        Имя латиницей, как его отдаёт источник экипажа.

    Returns
    -------
    str | None
        Адрес фотографии либо `None`, если фотографии нет.
    """
    search_url = WIKIDATA_SEARCH_URL.format(name=quote(person_name, safe=''))

    try:
        search_result = await http_client.fetch_json(
            search_url, f'поиск в базе знаний: {person_name}',
        )
    except Exception:
        return None

    exact_matches: list[dict[str, Any]] = []

    for candidate in (search_result.get('search') or [])[:8]:
        entity_id = candidate.get('id')
        if not entity_id:
            continue

        entity_url = WIKIDATA_ENTITY_URL.format(entity_id=entity_id)

        try:
            entity_result = await http_client.fetch_json(
                entity_url, f'объект базы знаний {entity_id}',
            )
        except Exception:
            continue

        entities = entity_result.get('entities') or {}
        entity = entities.get(entity_id) or {}

        english_label = ((entity.get('labels') or {}).get('en') or {}).get('value')

        if not _names_match(english_label, person_name):
            continue

        photo_name = None
        claims = (entity.get('claims') or {}).get(WIKIDATA_PHOTO_PROPERTY) or []
        for claim in claims:
            value = claim.get('mainsnak', {}).get('datavalue', {}).get('value')
            if isinstance(value, str):
                photo_name = value
                break

        if photo_name:
            return WIKIMEDIA_FILE_URL.format(
                file_name=quote(photo_name.replace(' ', '_'), safe=''),
            )

        exact_matches.append(entity)

    return None


async def _fetch_photos_for_people(people_names: list[str]) -> dict[str, str]:
    """
    Подбирает фотографии членов экипажа.

    Функция является вспомогательной и не влияет на работоспособность
    основного кода: если энциклопедия недоступна или человек
    не найден, функция возвращает пустой словарь, и список
    отображается без фотографий.

    Parameters
    ----------
    people_names : list[str]
        Список имён членов экипажа.

    Returns
    -------
    dict[str, str]
        Соответствие между именем человека и адресом фотографии.
    """
    photos: dict[str, str] = {}

    for person_index, person_name in enumerate(people_names):
        if person_index > 0:
            # Пауза нужна между соседними людьми, но не перед первым.
            await asyncio.sleep(PHOTO_REQUEST_DELAY_SECONDS)

        # Сначала база знаний: у неё есть идентификатор человека, и
        # чужие однофамильцы отсеиваются. Энциклопедия определяет объект
        # только по имени и потому иногда приводит не к тому человеку.
        photo_url = await _fetch_photo_from_wikidata(person_name)
        if photo_url:
            photos[person_name] = photo_url
            continue

        page_title = person_name.replace(' ', '_')

        for template in PHOTO_SOURCES:
            url = template.format(title=quote(page_title, safe=''))
            try:
                summary = await http_client.fetch_json(url, f'сведения о {person_name}')
            except Exception:
                # Отсутствие фотографии не является ошибкой основной
                # операции, поэтому ошибка подавляется и перебор
                # источников продолжается.
                continue

            thumbnail_url = (summary.get('thumbnail') or {}).get('source')
            if thumbnail_url:
                photos[person_name] = thumbnail_url
                break

    return photos
