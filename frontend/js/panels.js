/**
 * Модули панели интерфейса: телеметрия, экипаж, запуски, астероиды.
 *
 * Организация модуля
 * ------------------
 * Каждая функция отвечает за одну панель: запрашивает данные,
 * строит содержимое блока и сообщает о сбое, если источник
 * недоступен. Функции не знают друг о друге: связь между ними
 * устанавливает основной модуль интерфейса.
 *
 * Общий принцип
 * --------------
 * Ни одна панель не блокирует другие. Если источник данных не отвечает,
 * соответствующая панель показывает сообщение об ошибке, а остальные
 * продолжают работать. Это возможно благодаря тому, что запросы
 * выполняются независимо друг от друга.
 *
 * Безопасность вывода
 * -------------------
 * Все данные, приходящие от внешних источников, вставляются в документ
 * через `textContent`, а не через `innerHTML`. Такой подход не позволяет
 * тексту из внешнего источника быть интерпретированным как разметка.
 */

import { fetchFromApi, renderError, reportError } from './api.js';
import {
    createElement,
    formatCoordinate,
    formatDateTime,
    formatDiameter,
    formatNumber,
    getElement,
    padNumber,
    splitDuration,
} from './utils.js';

/* ================================================================== */
/* Панель телеметрии станции                                          */
/* ================================================================== */

/**
 * Обновляет показатели телеметрии станции.
 *
 * Функция вызывается регулярно: положение станции меняется непрерывно,
 * а показатели на панели должны следовать за ним.
 *
 * @returns {Promise<void>} Разрешается после обновления показателей.
 */
export async function updateTelemetry() {
    const container = getElement('module-telemetry');

    try {
        const telemetry = await fetchFromApi('/api/iss');

        // Показатели обновляются по отдельности, а не перестраиваются
        // целиком: полная перестройка уничтожила бы анимацию
        // перехода между состояниями оформления.
        setText('metric-altitude', formatNumber(telemetry.altitude_km, 1));
        setText('metric-speed', formatNumber(telemetry.velocity_km_s, 2));
        setText('metric-latitude', formatCoordinate(telemetry.latitude, 'lat'));
        setText('metric-longitude', formatCoordinate(telemetry.longitude, 'lon'));
        setText('metric-footprint', formatNumber(telemetry.footprint_km, 0));

        setVisibilityState(telemetry);

        return telemetry;

    } catch (error) {
        reportError('телеметрия МКС', error);
        // Показатели телеметрии при сбое не очищаются: последние
        // полученные значения остаются видимыми и отмечены
        // как устаревшие, что честнее пустых полей.
        markTelemetryAsStale();
        return null;
    }
}

/**
 * Устанавливает текстовое содержимое элемента, если он существует.
 *
 * @param {string} elementId Идентификатор элемента.
 * @param {string} text Текст для отображения.
 */
function setText(elementId, text) {
    const element = getElement(elementId);
    if (element) {
        element.textContent = text;
    }
}

/**
 * Отображает состояние освещённости станции.
 *
 * Цвет подписи соответствует состоянию: в солнечный свет аппарат
 * хорошо виден, в тени — не виден вовсе. Это позволяет оценить
 * наблюдаемость станции невооружённым глазом прямо по панели.
 *
 * @param {Object} telemetry Данные телеметрии станции.
 */
function setVisibilityState(telemetry) {
    const element = getElement('metric-visibility');
    if (!element) {
        return;
    }

    element.textContent = telemetry.visibility_label ?? 'неизвестно';

    // Классы оформления задаются с нуля, чтобы не накапливались
    // при последовательных обновлениях.
    element.className = 'metric-value';
    if (telemetry.visibility === 'daylight') {
        element.classList.add('visibility-daylight');
    } else if (telemetry.visibility === 'eclipsed') {
        element.classList.add('visibility-eclipsed');
    } else {
        element.classList.add('visibility-penumbra');
    }
}

/**
 * Помечает показатели телеметрии как устаревшие.
 */
function markTelemetryAsStale() {
    const container = getElement('module-telemetry');
    if (!container) {
        return;
    }

    let notice = container.querySelector('.telemetry-stale');
    if (!notice) {
        notice = createElement('div', {
            className: 'module-error telemetry-stale',
            textContent: 'Данные телеметрии не обновляются: источник недоступен.',
        });
        container.appendChild(notice);
    }
}

/* ================================================================== */
/* Панель экипажа                                                     */
/* ================================================================== */

/**
 * Загружает и отображает список экипажа станций.
 *
 * @returns {Promise<void>} Разрешается после отрисовки панели.
 */
export async function updateCrew() {
    const container = getElement('crew-content');

    try {
        const crew = await fetchFromApi('/api/crew');

        container.innerHTML = '';

        setText('crew-count', `${crew.total_people} чел.`);

        for (const station of crew.stations) {
            container.appendChild(createStationBlock(station));
        }

    } catch (error) {
        reportError('экипаж станций', error);
        renderError(container, error);
        setText('crew-count', '');
    }
}

/**
 * Создаёт блок одной станции со списком её экипажа.
 *
 * @param {Object} station Сведения о станции и её экипаже.
 * @returns {HTMLElement} Готовый блок для вставки в панель.
 */
function createStationBlock(station) {
    const block = createElement('div', { className: 'crew-station' });

    const header = createElement('div', { className: 'crew-station-name' });
    header.appendChild(createElement('span', { textContent: station.name }));
    header.appendChild(createElement('span', { textContent: `${station.crew_count}` }));
    block.appendChild(header);

    for (const person of station.people) {
        block.appendChild(createCrewMember(person));
    }

    return block;
}

/**
 * Получает инициалы человека по его имени.
 *
 * Берутся первые буквы слов, из которых состоит имя. Для китайских
 * имён, где слова записываются слитно, берутся первые две буквы
 * фамилии: иначе инициал получился бы таким же, как у соседа по
 * списку.
 *
 * @param {string} fullName Имя человека.
 * @returns {string} Инициалы заглавными буквами либо пустая строка.
 */
function getInitials(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
        return '';
    }

    if (parts.length === 1) {
        // Одно слово: для китайских имён берём две буквы, для остальных одну.
        return parts[0].slice(0, 2).toUpperCase();
    }

    return parts.map((part) => part[0]).join('').toUpperCase();
}


/**
 * Показывает увеличенную фотографию при наведении на значок.
 *
 * Крупная копия размещается рядом со строкой экипажа. Если справа
 * места не хватает, картинка показывается слева, а у самой правой
 * строки сдвигается внутрь панели, чтобы не выходить за её край.
 *
 * @param {HTMLImageElement} photo Значок фотографии в строке.
 * @param {HTMLElement} name Имя человека в той же строке.
 * @param {Object} person Сведения о человеке.
 */
function attachLargePhotoOnHover(photo, name, person) {
    // Контейнер нужен, чтобы позиционировать картинку относительно
    // самой панели, а не окна: панель прокручивается, и координаты
    // страницы в этом случае неприменимы.
    const largePhoto = createElement('img', {
        className: 'crew-photo-large',
        src: person.photo_url,
        alt: person.name,
    });

    document.body.appendChild(largePhoto);

    function showLargePhoto(trigger) {
        const triggerRect = trigger.getBoundingClientRect();
        const margin = 10;
        const rightEdge = triggerRect.right;
        const fitsToRight = window.innerWidth - rightEdge > 190 + margin;

        largePhoto.style.left = fitsToRight
            ? `${rightEdge + margin}px`
            : `${triggerRect.left - 190 - margin}px`;
        largePhoto.style.top = `${triggerRect.top - margin}px`;
        largePhoto.classList.add('is-visible');
    }

    function hideLargePhoto() {
        largePhoto.classList.remove('is-visible');
    }

    // Наведение обрабатывается и на фотографии, и на имени: так крупная
    // копия раскрывается от любой части строки. Позиционирование каждый
    // раз считается от того элемента, на который навели курсор, поэтому
    // картинка всегда появляется рядом с ним.
    photo.addEventListener('mouseenter', () => showLargePhoto(photo));
    name.addEventListener('mouseenter', () => showLargePhoto(name));
    photo.addEventListener('mouseleave', hideLargePhoto);
    name.addEventListener('mouseleave', hideLargePhoto);

    // Если снимок не загрузился, крупная копия тоже не нужна.
    photo.addEventListener('error', () => {
        largePhoto.remove();
    }, { once: true });
}

/**
 * Создаёт строку с именем и фотографией члена экипажа.
 *
 * @param {Object} person Сведения о человеке.
 * @returns {HTMLElement} Готовая строка для вставки в панель.
 */
function createCrewMember(person) {
    const row = createElement('div', { className: 'crew-member' });
    const name = createElement('span', {
        className: 'crew-name',
        textContent: person.name,
    });

    if (person.photo_url) {
        // Фотография загружается с внешнего сервиса, поэтому для неё
        // явно указывается запрет на перехват ошибок: при недоступности
        // изображения страница не должна получать системные сообщения.
        const photo = createElement('img', {
            className: 'crew-photo',
            src: person.photo_url,
            alt: person.name,
            loading: 'lazy',
            referrerpolicy: 'no-referrer',
            onerror: 'this.style.visibility="hidden"',
        });
        photo.title = person.name;

        // По наведению показывается увеличенная копия фотографии.
        // Крупная картинка — это та же ссылка, а не отдельная загрузка,
        // поэтому браузер уже отдаёт файл из кэша и ничего не тормозит.
        attachLargePhotoOnHover(photo, name, person);
        row.appendChild(photo);
    } else {
        // Фотографии нет: показываются инициалы. Пустая рамка с точкой
        // читалась как сломанная картинка, а инициалы выглядят как
        // замысел, а не как ошибка загрузки.
        row.appendChild(createElement('div', {
            className: 'crew-photo crew-photo-placeholder',
            textContent: getInitials(person.name),
            title: person.name,
        }));
    }

    row.appendChild(name);

    return row;
}

/* ================================================================== */
/* Панель запусков                                                    */
/* ================================================================== */

/**
 * Переменная, хранящая время ближайшего запуска.
 *
 * Значение сохраняется вне функции отрисовки, чтобы обратный отсчёт
 * обновлялся каждую секунду без повторного обращения к источнику:
 * время запуска меняется редко, а счётчик должен идти непрерывно.
 *
 * @type {string|null}
 */
let nextLaunchTime = null;

/**
 * Загружает и отображает расписание запусков.
 *
 * @returns {Promise<void>} Разрешается после отрисовки панели.
 */
export async function updateLaunches() {
    const nextContainer = getElement('next-launch');
    const listContainer = getElement('launch-list');

    try {
        const launches = await fetchFromApi('/api/launches');
        const items = launches.launches ?? [];

        nextContainer.innerHTML = '';
        listContainer.innerHTML = '';

        if (items.length === 0) {
            nextContainer.appendChild(createElement('div', {
                className: 'module-error',
                textContent: 'Источник не вернул данных о запусках.',
            }));
            return;
        }

        // Ближайший запуск выводится крупной карточкой,
        // остальные — компактным списком.
        nextLaunchTime = items[0].net;
        nextContainer.appendChild(createNextLaunchCard(items[0]));

        for (const launch of items.slice(1, 9)) {
            listContainer.appendChild(createLaunchItem(launch));
        }

    } catch (error) {
        reportError('расписание запусков', error);
        renderError(nextContainer, error);
        nextLaunchTime = null;
    }
}

/**
 * Создаёт карточку ближайшего запуска с обратным отсчётом.
 *
 * @param {Object} launch Сведения о запуске.
 * @returns {HTMLElement} Готовый блок карточки.
 */
function createNextLaunchCard(launch) {
    const card = createElement('div');

    card.appendChild(createElement('div', {
        className: 'launch-name',
        textContent: launch.mission_name ?? launch.name,
    }));

    const meta = createElement('div', { className: 'launch-meta' });

    const rocketLine = `Ракета-носитель: ${launch.rocket_name ?? 'не указана'}`;
    meta.appendChild(createElement('div', { textContent: rocketLine }));

    if (launch.location_name || hasPadCoordinates(launch)) {
        const padRow = createElement('div');
        padRow.appendChild(createElement('span', {
            textContent: 'Площадка: ',
        }));

        // При известных координатах площадка показывается ссылкой:
        // щелчок переводит камеру к этой точке на карте.
        padRow.appendChild(createPadControl(launch));

        meta.appendChild(padRow);
    }

    // Точность указания времени показывается рядом с обратным отсчётом:
    // при низкой точности расчёт ведётся с оговоркой.
    const precisionLabels = {
        minute: 'точность до минуты',
        hour: 'точность до часа',
        day: 'точность до дня',
        quarter: 'точность до квартала',
    };
    const precisionLabel = precisionLabels[launch.net_precision];
    if (precisionLabel) {
        meta.appendChild(createElement('div', { textContent: precisionLabel }));
    }

    if (launch.has_probability) {
        meta.appendChild(createElement('div', {
            textContent: `Вероятность успеха: ${launch.probability}%`,
        }));
    }

    card.appendChild(meta);

    // Контейнер обратного отсчёта заполняется отдельной функцией,
    // которая вызывается каждую секунду.
    card.appendChild(createElement('div', {
        className: 'countdown',
        id: 'launch-countdown',
        textContent: '—',
    }));
    card.appendChild(createElement('div', {
        className: 'countdown-label',
        textContent: 'ДО ЗАПУСКА',
    }));

    return card;
}

/**
 * Создаёт компактную строку запуска в расписании.
 *
 * @param {Object} launch Сведения о запуске.
 * @returns {HTMLElement} Готовая строка для вставки в список.
 */
function createLaunchItem(launch) {
    // Нативный элемент раскрытия: щелчок по заголовку показывает
    // подробности, повторный щелчок скрывает их. Оформление и
    // клавиатурная навигация при этом остаются средствами браузера.
    const item = createElement('details', { className: 'launch-item' });

    const summary = createElement('summary');

    const head = createElement('div', { className: 'launch-item-head' });
    head.appendChild(createElement('span', {
        className: 'launch-item-chevron',
        textContent: '\u25b6',
    }));
    head.appendChild(createElement('span', {
        className: 'launch-item-name',
        textContent: launch.mission_name ?? launch.name,
    }));
    summary.appendChild(head);

    summary.appendChild(createElement('span', {
        className: 'launch-item-time',
        textContent: formatDateTime(launch.net),
    }));

    item.appendChild(summary);
    item.appendChild(buildLaunchDetails(launch));

    return item;
}

/**
 * Строит раскрывающийся блок с подробностями запуска.
 *
 * @param {Object} launch Сведения о запуске.
 * @returns {HTMLElement} Блок с подробностями.
 */
function buildLaunchDetails(launch) {
    const body = createElement('div', { className: 'launch-item-body' });

    const rows = [
        ['Ракета', launch.rocket_family ?? launch.rocket_name],
        ['Оператор', launch.rocket_provider],
        ['Успешных пусков', launch.rocket_success_rate !== null
            && launch.rocket_success_rate !== undefined
            ? `${formatNumber(launch.rocket_success_rate, 1)}%`
            : null],
        ['Окно запуска', launch.window_duration_minutes
            ? `${launch.window_duration_minutes} мин`
            : null],
        ['Вероятность', launch.has_probability ? `${launch.probability}%` : null],
        ['Трансляция', launch.webcast_live ? 'прямой эфир' : null],
    ];

    for (const [key, value] of rows) {
        if (!value) {
            continue;
        }

        // Дочерние элементы добавляются по отдельности: функция
        // создания элемента принимает только имя тега и свойства,
        // а третий аргумент был бы молча проигнорирован.
        const row = createElement('div', { className: 'launch-detail-row' });
        row.appendChild(createElement('span', {
            className: 'launch-detail-key',
            textContent: key,
        }));
        row.appendChild(createElement('span', {
            className: 'launch-detail-value',
            textContent: String(value),
        }));

        body.appendChild(row);
    }

    // Площадка выводится последней: она же служит ссылкой на карту.
    if (launch.pad_name || launch.location_name || hasPadCoordinates(launch)) {
        const padRow = createElement('div', { className: 'launch-detail-row' });
        padRow.appendChild(createElement('span', {
            className: 'launch-detail-key',
            textContent: 'Площадка',
        }));
        padRow.appendChild(createPadControl(launch));
        body.appendChild(padRow);
    }

    if (launch.mission_description) {
        body.appendChild(createElement('div', {
            className: 'launch-detail-description',
            textContent: launch.mission_description,
        }));
    }

    return body;
}

/**
 * Проверяет, известны ли координаты площадки запуска.
 *
 * @param {Object} launch Сведения о запуске.
 * @returns {boolean} Признак наличия координат.
 */
function hasPadCoordinates(launch) {
    return launch.pad_latitude !== null && launch.pad_latitude !== undefined
        && launch.pad_longitude !== null && launch.pad_longitude !== undefined;
}

/**
 * Создаёт элемент показа места запуска.
 *
 * Если координаты площадки известны, создаётся ссылка: щелчок по ней
 * переводит камеру к этой точке и оставляет на ней маркер. Сведения о
 * запросе передаются главному модулю через событие документа, поэтому
 * панели не зависят от сцены напрямую.
 *
 * @param {Object} launch Сведения о запуске.
 * @returns {HTMLElement} Ссылка либо текстовая подпись.
 */
function createPadControl(launch) {
    const label = launch.pad_name ?? launch.location_name ?? '—';

    if (!hasPadCoordinates(launch)) {
        return createElement('span', {
            className: 'launch-detail-value launch-pad-plain',
            textContent: label,
        });
    }

    const link = createElement('button', {
        type: 'button',
        className: 'launch-pad-link',
        textContent: label,
        title: 'Показать площадку на карте',
    });

    link.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('location:focus', {
            detail: {
                latitude: launch.pad_latitude,
                longitude: launch.pad_longitude,
                title: label,
            },
        }));
    });

    return link;
}

/**
 * Обновляет обратный отсчёт до ближайшего запуска.
 *
 * Функция вызывается каждую секунду и не обращается к источнику:
 * время запуска уже сохранено при загрузке расписания.
 */
export function updateCountdown() {
    const element = getElement('launch-countdown');
    if (!element || !nextLaunchTime) {
        return;
    }

    const launchMoment = new Date(nextLaunchTime).getTime();
    const remaining = launchMoment - Date.now();

    if (remaining <= 0) {
        element.textContent = 'ЗАПУСК';
        element.className = 'countdown countdown-imminent';
        return;
    }

    const parts = splitDuration(remaining);
    element.textContent = [
        parts.days > 0 ? `${parts.days} д` : null,
        `${padNumber(parts.hours)}:${padNumber(parts.minutes)}:${padNumber(parts.seconds)}`,
    ].filter(Boolean).join(' ');

    // Подсветка становится ярче по мере приближения запуска:
    // цвет привлекает внимание к событию заранее.
    element.className = 'countdown';
    if (parts.days === 0 && parts.hours < 1) {
        element.classList.add('countdown-imminent');
    } else if (parts.days === 0) {
        element.classList.add('countdown-soon');
    }
}

/* ================================================================== */
/* Панель астероидов                                                  */
/* ================================================================== */

/**
 * Загружает и отображает сведения об околоземных астероидах.
 *
 * @returns {Promise<void>} Разрешается после отрисовки панели.
 */
export async function updateAsteroids() {
    const summaryContainer = getElement('asteroid-summary');
    const listContainer = getElement('asteroid-list');

    try {
        const [nearEarth, hazardous] = await Promise.all([
            fetchFromApi('/api/asteroids'),
            fetchFromApi('/api/asteroids/hazardous'),
        ]);

        renderAsteroidSummary(summaryContainer, nearEarth, hazardous);
        renderAsteroidList(listContainer, hazardous);

    } catch (error) {
        reportError('околеземные астероиды', error);
        renderError(listContainer, error);
    }
}

/**
 * Строит сводку по астероидам.
 *
 * Выводятся три величины: сколько опасных объектов насчитывается
 * всего, сколько из них крупнее порога опасности и каков размер
 * крупнейшего из них.
 *
 * @param {HTMLElement} container Блок для сводки.
 * @param {Object} nearEarth Данные об околоземных астероидах.
 * @param {Object} hazardous Данные об опасных астероидах.
 */
function renderAsteroidSummary(container, nearEarth, hazardous) {
    container.innerHTML = '';

    const statistics = nearEarth.statistics ?? {};

    const items = [
        {
            value: formatNumber(statistics.objects_in_sample ?? 0, 0),
            label: 'в выборке',
        },
        {
            // Показывается общее число известных потенциально опасных
            // астероидов, а не размер выборки: выборка ограничена
            // тремя сотнями крупнейших объектов и ничего не говорит
            // о том, сколько опасных тел известно всего.
            value: formatNumber(
                hazardous.statistics?.total_objects_known
                ?? hazardous.statistics?.objects_in_sample
                ?? 0,
                0,
            ),
            label: 'опасных',
        },
        {
            value: formatDiameter(statistics.largest_diameter_km),
            label: 'крупнейший',
        },
    ];

    for (const item of items) {
        const block = createElement('div', { className: 'asteroid-stat' });
        block.appendChild(createElement('div', {
            className: 'asteroid-stat-value',
            textContent: item.value,
        }));
        block.appendChild(createElement('div', {
            className: 'asteroid-stat-label',
            textContent: item.label,
        }));
        container.appendChild(block);
    }
}

/**
 * Строит список потенциально опасных астероидов.
 *
 * Выводится ограниченное число объектов: полный перечень содержит
 * тысячи позиций и не помещается в панель, а для оценки порядка
 * величин достаточно первых нескольких.
 *
 * @param {HTMLElement} container Блок для списка.
 * @param {Object} hazardous Данные об опасных астероидах.
 */
function renderAsteroidList(container, hazardous) {
    container.innerHTML = '';

    const asteroids = (hazardous.asteroids ?? []).slice(0, 24);

    if (asteroids.length === 0) {
        container.appendChild(createElement('div', {
            className: 'module-error',
            textContent: 'Потенциально опасные астероиды не найдены.',
        }));
        return;
    }

    for (const asteroid of asteroids) {
        container.appendChild(createAsteroidItem(asteroid));
    }
}

/**
 * Создаёт строку со сведениями об одном астероиде.
 *
 * Названия классов орбиты переводятся на русский язык: аббревиатуры
 * источника (например, APO) без пояснения мало что означают
 * для читателя, не знакомого с классификацией.
 *
 * @param {Object} asteroid Сведения об астероиде.
 * @returns {HTMLElement} Готовая строка для вставки в список.
 */
function createAsteroidItem(asteroid) {
    // Обзорный список содержит до двух десятков объектов, а подробные
    // сведения запрашиваются у источника отдельно для каждого из них.
    // Поэтому строка сделана раскрывающейся, а данные загружаются
    // только при первом открытии: остальные объекты не опрашивают
    // источник впустую.
    const item = createElement('details', {
        className: 'asteroid-item asteroid-item-hazardous',
    });

    const summary = createElement('summary');

    const left = createElement('div');
    left.appendChild(createElement('div', {
        className: 'asteroid-name',
        textContent: asteroid.name ?? String(asteroid.designation),
    }));

    const classLabels = {
        IEO: 'внутренний к Земле',
        ATE: 'близкий к Земле',
        APO: 'пересекающий орбиту',
        AMO: 'сближающийся с Землёй',
    };
    left.appendChild(createElement('div', {
        className: 'asteroid-class',
        textContent: classLabels[asteroid.orbit_class] ?? asteroid.orbit_class ?? '',
    }));

    summary.appendChild(left);

    // Оценка диаметра помечается знаком приблизительности,
    // поскольку получена расчётом по звездной величине.
    const diameterText = formatDiameter(asteroid.diameter_km);
    summary.appendChild(createElement('div', {
        className: 'asteroid-diameter',
        textContent: asteroid.diameter_is_estimated ? `~${diameterText}` : diameterText,
    }));

    item.appendChild(summary);

    const body = createElement('div', { className: 'asteroid-body' });
    body.appendChild(createElement('div', {
        className: 'asteroid-loading',
        textContent: 'загрузка сведений\u2026',
    }));
    item.appendChild(body);

    // Подробности загружаются при первом открытии строки и дальше
    // остаются в ней: повторные щелчки уже не обращаются к источнику.
    let isLoaded = false;

    item.addEventListener('toggle', async () => {
        if (!item.open || isLoaded) {
            return;
        }

        isLoaded = true;
        body.innerHTML = '';
        body.appendChild(createElement('div', {
            className: 'asteroid-loading',
            textContent: 'загрузка сведений\u2026',
        }));

        try {
            const details = await fetchFromApi(
                `/api/asteroids/${encodeURIComponent(asteroid.designation)}`,
            );
            renderAsteroidDetails(body, details);
        } catch (error) {
            body.innerHTML = '';
            body.appendChild(createElement('div', {
                className: 'asteroid-loading asteroid-loading-error',
                textContent: error.message,
            }));
        }
    });

    return item;
}

/**
 * Выводит подробные сведения об астероиде.
 *
 * Показаны физические параметры тела и несколько ближайших сближений
 * с Землёй. Значения, которых у объекта нет, пропускаются: часть
 * тел измеряется лишь частично, и пустые строки в таком случае
 * только мешали бы.
 *
 * @param {HTMLElement} body Блок для вывода.
 * @param {Object} details Сведения об астероиде.
 */
function renderAsteroidDetails(body, details) {
    body.innerHTML = '';

    if (details.full_name) {
        body.appendChild(createElement('div', {
            className: 'asteroid-fullname',
            textContent: details.full_name,
        }));
    }

    const parameters = details.physical_parameters ?? {};

    const rows = [
        ['Диаметр', parameters.diameter_km !== undefined
            ? formatDiameter(parameters.diameter_km)
            : null],
        ['Спектральный класс', parameters.spectral_type],
        ['Альбедо', parameters.albedo !== undefined
            ? formatNumber(parameters.albedo, 3)
            : null],
        ['Оборот вокруг оси', parameters.rotation_hours !== undefined
            ? `${formatNumber(parameters.rotation_hours, 2)} ч`
            : null],
        ['Абсолютная величина', parameters.absolute_magnitude !== undefined
            ? formatNumber(parameters.absolute_magnitude, 2)
            : null],
    ];

    for (const [key, value] of rows) {
        if (!value) {
            continue;
        }
        // Дочерние элементы добавляются по отдельности: функция
        // создания элемента принимает только имя тега и свойства,
        // а третий аргумент был бы молча проигнорирован.
        const row = createElement('div', { className: 'launch-detail-row' });
        row.appendChild(createElement('span', {
            className: 'launch-detail-key',
            textContent: key,
        }));
        row.appendChild(createElement('span', {
            className: 'launch-detail-value',
            textContent: String(value),
        }));

        body.appendChild(row);
    }

    const approaches = details.close_approaches ?? [];

    if (approaches.length === 0) {
        body.appendChild(createElement('div', {
            className: 'asteroid-loading',
            textContent: 'сближения с Землёй не рассчитаны',
        }));
        return;
    }

    body.appendChild(createElement('div', {
        className: 'asteroid-subheading',
        textContent: 'СБЛИЖЕНИЯ С ЗЕМЛЁЙ ПО ДАТЕ',
    }));

    // Порядок приходит от сервера по расстоянию: от более близкого
    // сближения к более далёкому. Такой порядок отвечает на вопрос о
    // тесноте сближения, но для дат он выглядит случайным — подписи
    // «было» и «предстоит» после него чередуются произвольно. Поэтому
    // для показа даты сортируются отдельно, а копия массива нужна,
    // чтобы не менять данные, полученные от сервера.
    //
    // Даты приходят в формате ISO 8601, поэтому сравнение строк
    // совпадает с хронологическим.
    const approachesByDate = [...approaches].sort((first, second) => (
        first.date < second.date ? -1 : 1
    ));

    // Показываются первые три сближения по времени: их достаточно,
    // чтобы оценить характер сближения, и список остаётся компактным.
    for (const approach of approachesByDate.slice(0, 3)) {
        const row = createElement('div', { className: 'launch-detail-row' });
        row.appendChild(createElement('span', {
            className: 'launch-detail-key',
            textContent: approach.is_future ? 'предстоит' : 'было',
        }));

        const value = `${formatDate(approach.date)} \u00b7 `
            + `${formatMillionsKm(approach.distance_km)}`;

        row.appendChild(createElement('span', {
            className: 'launch-detail-value',
            textContent: value,
        }));

        body.appendChild(row);
    }
}

/**
 * Приводит дату сближения к виду «02.09.2057».
 *
 * Формат выбран коротким: сближения могут относиться к далёким
 * десятилетиям, поэтому год показывается полностью.
 *
 * @param {string} isoDate Дата в виде строки ISO 8601.
 * @returns {string} Подготовленная к показу дата.
 */
function formatDate(isoDate) {
    const moment = new Date(isoDate);

    if (Number.isNaN(moment.getTime())) {
        return '\u2014';
    }

    return padNumber(moment.getUTCDate()) + '.'
        + padNumber(moment.getUTCMonth() + 1) + '.'
        + moment.getUTCFullYear();
}

/**
 * Приводит расстояние сближения к виду «7,47 млн км».
 *
 * @param {number} distanceKm Расстояние в километрах.
 * @returns {string} Подготовленное к показу расстояние.
 */
function formatMillionsKm(distanceKm) {
    if (!Number.isFinite(distanceKm)) {
        return '\u2014';
    }

    return `${formatNumber(distanceKm / 1e6, 2)} млн км`;
}

/* ================================================================== */
/* Панель космической погоды                                           */
/* ================================================================== */

/**
 * Загружает и отображает состояние космической погоды.
 *
 * @returns {Promise<Object|null>} Текущий индекс активности, который
 *   используется для управления яркостью полярного сияния.
 */
export async function updateSpaceWeather() {
    const container = getElement('weather-current');

    try {
        const geomagnetic = await fetchFromApi('/api/space-weather/geomagnetic');
        const forecast = await fetchFromApi('/api/space-weather/forecast');

        renderGeomagneticState(container, geomagnetic, forecast);

        return geomagnetic.current_kp;

    } catch (error) {
        reportError('космическая погода', error);
        renderError(container, error);
        return null;
    }
}

/**
 * Строит блок текущего состояния геомагнитной активности.
 *
 * @param {HTMLElement} container Блок для содержимого.
 * @param {Object} geomagnetic Данные о текущей активности.
 * @param {Object} forecast Данные о прогнозе.
 */
function renderGeomagneticState(container, geomagnetic, forecast) {
    container.innerHTML = '';

    const level = geomagnetic.current_level ?? { level: 'G0', label: 'нет данных' };
    const kpValue = geomagnetic.current_kp;

    const value = createElement('div', { className: 'weather-kp', textContent: formatNumber(kpValue, 1) });

    // Подсветка зависит от силы возмущения: при спокойной обстановке
    // значение спокойного цвета, при буре — тревожного.
    if (kpValue !== null && kpValue !== undefined) {
        if (kpValue >= 5) {
            value.classList.add('weather-kp-severe');
        } else if (kpValue >= 4) {
            value.classList.add('weather-kp-moderate');
        }
    }
    container.appendChild(value);

    const details = createElement('div');

    details.appendChild(createElement('div', {
        className: 'weather-level',
        textContent: `${level.level} · ${level.label}`,
    }));

    details.appendChild(createElement('div', {
        className: 'weather-detail',
        textContent: `Среднее за сутки: ${formatNumber(geomagnetic.average_kp_24h, 2)} · ` +
            `максимум: ${formatNumber(geomagnetic.maximum_kp_24h, 1)}`,
    }));

    // Прогноз показывается отдельно: он позволяет заранее узнать
    // о приближении магнитной бури.
    if (forecast?.maximum_kp_expected) {
        const expectation = forecast.storm_expected
            ? 'ожидается магнитная буря'
            : 'бурь не ожидается';

        details.appendChild(createElement('div', {
            className: 'weather-detail',
            textContent: `Прогноз: до ${formatNumber(forecast.maximum_kp_expected, 1)} — ${expectation}`,
        }));
    }

    container.appendChild(details);
}
