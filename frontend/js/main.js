/**
 * Главный модуль интерфейса.
 *
 * Назначение
 * ----------
 * Модуль связывает между собой трёхмерную сцену, панели и графики:
 * запускает сцену, организует регулярное обновление данных и
 * передаёт сведения между частями интерфейса.
 *
 * Порядок работы при запуске
 * --------------------------
 * 1. Создаётся трёхмерная сцена и запускается цикл отрисовки.
 *    Сцена показывает Землю даже до поступления данных.
 * 2. Параллельно загружаются текстуры Земли.
 * 3. Настраиваются регулярные обновления панелей. Каждая панель
 *    обновляется по своему расписанию: телеметрия — часто,
 *    расписание запусков — редко.
 * 4. Включается обратный отсчёт до запуска, обновляемый каждую секунду.
 *
 * Соглашение о частоте обновления
 * ------------------------------
 * Периодичность обновления каждого источника подобрана по скорости
 * изменения данных. Телеметрия меняется каждую секунду, состав
 * экипажа — несколько раз в год, а расписание запусков — иногда.
 * Одинаковая частота для всех источников означала бы либо
 * бесполезные частые запросы, либо устаревающие данные.
 */

import { fetchFromApi, reportError } from './api.js';
import { SpaceScene } from './scene.js';
import {
    updateAsteroids,
    updateCountdown,
    updateCrew,
    updateLaunches,
    updateSpaceWeather,
    updateTelemetry,
} from './panels.js';
import {
    renderSatellitesChart,
    renderSolarCycleChart,
} from './charts.js';
import { getElement } from './utils.js';

/**
 * Периодичность обновления телеметрии станции, в миллисекундах.
 * Положение станции меняется быстро, поэтому обновление выполняется
 * часто. Значение подобрано так, чтобы полоса пропускания не мешала
 * анимации станции на экране.
 */
const TELEMETRY_INTERVAL = 5000;

/**
 * Периодичность обновления траектории станции, в миллисекундах.
 * Траектория меняется медленно: пересчитывать её так же часто,
 * как телеметрию, не требуется.
 */
const TRACK_INTERVAL = 60000;

/**
 * Периодичность пересчёта положения станции по элементам орбиты,
 * в миллисекундах. Значение совпадает с периодом обновления
 * телеметрии, чтобы запасной источник успевал подхватить станцию
 * сразу после отказа основного.
 */
const POSITION_INTERVAL = 5000;

/**
 * Периодичность обновления расписания запусков, в миллисекундах.
 * Расписание меняется за дни до события, поэтому часового обновления
 * достаточно.
 */
const LAUNCHES_INTERVAL = 300000;

/**
 * Периодичность обновления списка экипажа, в миллисекундах.
 * Состав экипажа меняется по экспедициям, то есть несколько раз в год.
 */
const CREW_INTERVAL = 900000;

/**
 * Периодичность обновления сведений об астероидах, в миллисекундах.
 * Каталог обновляется медленно: новые объекты открываются постоянно,
 * но сведения о них появляются не мгновенно.
 */
const ASTEROIDS_INTERVAL = 1800000;

/**
 * Периодичность обновления сведений о космической погоде,
 * в миллисекундах. Активность меняется в течение суток,
 * поэтому обновление выполняется несколько раз в час.
 */
const SPACE_WEATHER_INTERVAL = 600000;

/**
 * Экземпляр трёхмерной сцены.
 *
 * @type {SpaceScene}
 */
let spaceScene = null;

/**
 * Признак того, что положение станции сейчас рассчитывается по
 * элементам орбиты, а не берётся из телеметрии источника.
 *
 * @type {boolean}
 */
let isOrbitPositionAvailable = false;

// Стартовый вид ставится один раз, после первого успешного запроса
// положения станции: до этого момента просто нечего наводить камеру.
let hasAppliedDefaultView = false;

/**
 * Запускает интерфейс.
 *
 * Функция выполняется один раз после загрузки страницы. Она создаёт
 * сцену, запускает отрисовку и настраивает обновление всех панелей.
 *
 * @returns {Promise<void>} Разрешается после запуска интерфейса.
 */
async function start() {
    spaceScene = new SpaceScene('space-canvas');
    spaceScene.start();

    // Текстуры загружаются параллельно с первым запросом данных:
    // ожидание завершения загрузки задержало бы появление панелей.
    spaceScene.loadEarth().catch((error) => {
        reportError('загрузка текстур Земли', error);
    });

    setupEventHandlers();
    startClock();
    startCountdown();

    // Панели обновляются независимо друг от друга. Отдельные функции
    // запускаются без ожидания друг друга, чтобы медленный источник
    // не задерживал появление остальных.
    refreshTelemetry();
    refreshPosition();
    refreshTracks();
    updateCrew();
    updateLaunches();
    updateAsteroids();
    refreshSpaceWeather();
    refreshSourcesStatus();
    renderSolarCycleChart();
    renderSatellitesChart();

    setInterval(refreshTelemetry, TELEMETRY_INTERVAL);
    setInterval(refreshPosition, POSITION_INTERVAL);
    setInterval(refreshTracks, TRACK_INTERVAL);
    setInterval(updateLaunches, LAUNCHES_INTERVAL);
    setInterval(updateCrew, CREW_INTERVAL);
    setInterval(updateAsteroids, ASTEROIDS_INTERVAL);
    setInterval(refreshSpaceWeather, SPACE_WEATHER_INTERVAL);
    setInterval(refreshSourcesStatus, SPACE_WEATHER_INTERVAL);
}

/**
 * Настраивает обработчики действий пользователя.
 */
function setupEventHandlers() {
    const focusButton = getElement('focus-button');

    if (focusButton) {
        focusButton.addEventListener('click', () => {
            const isAlreadyFocused = focusButton.dataset.focused === 'true';

            // Повторное нажатие возвращает камеру к обзору планеты,
            // что удобнее отдельной второй кнопки.
            if (isAlreadyFocused) {
                spaceScene.resetCamera();
            } else {
                spaceScene.focusOnStation();
                updateTargetCaption('МКС \u00b7 NORAD 25544');
            }

            focusButton.dataset.focused = isAlreadyFocused ? 'false' : 'true';
        });
    }

    // Показ места запуска. Панель сообщает о нём через событие
    // документа, благодаря чему панели не зависят от сцены напрямую.
    document.addEventListener('location:focus', (event) => {
        const detail = event.detail ?? {};

        if (detail.latitude === undefined || detail.longitude === undefined) {
            return;
        }

        spaceScene.focusOnLocation(detail.latitude, detail.longitude);
        updateTargetCaption(`ПЛОЩАДКА \u00b7 ${detail.title ?? 'место запуска'}`);

        // Камера смотрит не на станцию, поэтому кнопка возврата
        // к ней сбрасывается.
        if (focusButton) {
            focusButton.dataset.focused = 'false';
        }
    });

    // Вращение сцены мышью должно отключать слежение за целью:
    // иначе камера продолжает возвращаться к ней, мешая осмотру.
    const canvas = document.getElementById('space-canvas');
    if (canvas) {
        canvas.addEventListener('pointerdown', () => {
            spaceScene.isTrackingStation = false;
            spaceScene.focusPoint = null;

            if (focusButton) {
                focusButton.dataset.focused = 'false';
            }
        });
    }
}

/**
 * Обновляет подпись текущей цели в угловой надписи интерфейса.
 *
 * @param {string} caption Текст подписи.
 */
function updateTargetCaption(caption) {
    const target = getElement('hud-target');
    if (!target) {
        return;
    }

    const subtitle = target.querySelector('.hud-sub');
    if (subtitle) {
        subtitle.textContent = caption;
    }
}

/**
 * Запускает обновление показателей времени в углу экрана.
 */
function startClock() {
    const update = () => {
        const clockElement = getElement('hud-clock');
        if (!clockElement) {
            return;
        }

        // Время показывается в местном часовом поясе пользователя
        // с указанием даты: часовой пояс наблюдателя важен
        // для оценки времени прохода станции.
        clockElement.textContent = new Date().toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    };

    update();
    setInterval(update, 1000);
}

/**
 * Запускает обратный отсчёт до ближайшего запуска.
 */
function startCountdown() {
    updateCountdown();
    // Счётчик обновляется каждую секунду: секунды в нём значимы.
    setInterval(updateCountdown, 1000);
}

/**
 * Обновляет телеметрию станции и её положение на сцене.
 *
 * Функция запрашивает телеметрию, передаёт положение станции
 * в трёхмерную сцену и обновляет область обзора.
 *
 * @returns {Promise<void>} Разрешается после обновления.
 */
async function refreshTelemetry() {
    const telemetry = await updateTelemetry();
    if (!telemetry) {
        return;
    }

    // Положение станции на сцене задаёт расчёт по элементам орбиты:
    // он учитывает движение аппарата между опросами источника.
    // Телеметрия источника применяется только как запасной вариант,
    // когда элементы орбиты получить не удалось.
    //
    // Одновременно оба источника не используются намеренно. Они
    // могут расходиться на тысячи километров, и станция тогда
    // скакала бы между двумя точками, срываясь с траектории.
    if (!isOrbitPositionAvailable) {
        spaceScene.setStationPosition(telemetry.latitude, telemetry.longitude);
    }

    spaceScene.setFootprint(telemetry.footprint_km);
}

/**
 * Запрашивает положение станции, рассчитанное по элементам орбиты.
 *
 * Расчёт по элементам орбиты даёт более гладкое движение,
 * чем телеметрия источника, поскольку учитывает положение
 * с точностью до секунды, а не обновляется дискретно.
 *
 * @returns {Promise<void>} Разрешается после обновления.
 */
async function refreshPosition() {
    try {
        const position = await fetchFromApi('/api/orbit/position');
        isOrbitPositionAvailable = true;
        spaceScene.setStationPosition(position.latitude, position.longitude);

        // При первом успешном ответе положение станции известно, и камеру
        // можно поставить над ней. Дальше вид не меняется: смена цели
        // целиком принадлежит пользователю.
        if (!hasAppliedDefaultView) {
            hasAppliedDefaultView = true;
            spaceScene.applyDefaultView();
        }
    } catch (error) {
        // Отказ элементов орбиты не оставляет сцену без станции:
        // дальше её положение обновляет телеметрия источника.
        isOrbitPositionAvailable = false;
        reportError('положение МКС по элементам орбиты', error);
    }
}

/**
 * Загружает траекторию станции и отображает её на сцене.
 *
 * @returns {Promise<void>} Разрешается после обновления.
 */
async function refreshTracks() {
    try {
        const track = await fetchFromApi('/api/orbit/track?minutes_ahead=90&step_seconds=60');
        spaceScene.setOrbitTracks(track.past_track, track.future_track);
    } catch (error) {
        reportError('траектория МКС', error);
    }
}

/**
 * Обновляет сведения о космической погоде и яркость сияния.
 *
 * Яркость полярного сияния в сцене связана с индексом геомагнитной
 * активности: при высоком индексе сияние становится заметнее.
 * Связь отражает реальную зависимость: при магнитных бурях сияния
 * наблюдаются на более низких широтах и выглядят ярче обычного.
 *
 * @returns {Promise<void>} Разрешается после обновления.
 */
async function refreshSpaceWeather() {
    const kpIndex = await updateSpaceWeather();
    spaceScene.setAuroraIntensity(kpIndex);
}

/**
 * Проверяет доступность источников данных и обновляет индикатор.
 *
 * @returns {Promise<void>} Разрешается после проверки.
 */
async function refreshSourcesStatus() {
    try {
        const status = await fetchFromApi('/api/status');

        const statusElement = getElement('hud-sources-status');
        if (statusElement) {
            statusElement.textContent =
                `${status.available_count} / ${status.total_count} доступно`;
        }

        setConnectionState(status.available_count > 0);

    } catch (error) {
        reportError('проверка источников', error);
        setConnectionState(false);
    }
}

/**
 * Отражает состояние соединения в индикаторе интерфейса.
 *
 * @param {boolean} isOnline Признак доступности хотя бы одного источника.
 */
function setConnectionState(isOnline) {
    const indicator = getElement('connection-status');
    if (!indicator) {
        return;
    }

    indicator.classList.toggle('is-online', isOnline);

    const textElement = indicator.querySelector('.status-text');
    if (textElement) {
        textElement.textContent = isOnline ? 'связь установлена' : 'нет связи';
    }
}

start();
