/**
 * Вспомогательные функции: форматирование значений и вычисление времени.
 *
 * Модуль собирает операции, которые нужны более чем одному блоку
 * интерфейса. Форматирование вынесено в отдельные функции по трём
 * причинам:
 *
 * 1. Единообразие отображения: одно и то же значение показывается
 *    одинаково во всех панелях, независимо от того, кто его выводит.
 * 2. Читаемость кода панелей: вместо конструктора со вложенными
 *    условиями вызывается именованная функция с понятным названием.
 * 3. Проверяемость: каждое правило отображения описано в одном месте.
 */

/**
 * Форматирует число с разделителем разрядов.
 *
 * Разделителем служит пробел, поскольку он не мешает читать
 * значение в моноширинном шрифте.
 *
 * @param {number} value Значение для форматирования.
 * @param {number} [decimals] Количество знаков после запятой.
 * @returns {string} Отформатированное значение либо прочерк, если
 *   значение отсутствует.
 */
export function formatNumber(value, decimals = 0) {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return '—';
    }
    return Number(value).toLocaleString('ru-RU', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

/**
 * Форматирует географическую координату с указанием полушария.
 *
 * Координаты без указания полушария неоднозначны: положительная
 * и отрицательная долготы относятся к разным половинам мира,
 * поэтому направление подписывается явно.
 *
 * @param {number} value Координата в градусах.
 * @param {'lat'|'lon'} kind Вид координаты: широта или долгота.
 * @returns {string} Подпись вида «51,6° с.ш.» либо прочерк.
 */
export function formatCoordinate(value, kind) {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return '—';
    }

    const isNegative = value < 0;
    const absoluteValue = Math.abs(value).toFixed(2).replace('.', ',');
    const hemisphere = kind === 'lat'
        ? (isNegative ? 'ю.ш.' : 'с.ш.')
        : (isNegative ? 'з.д.' : 'в.д.');

    return `${absoluteValue}° ${hemisphere}`;
}

/**
 * Форматирует момент времени в местном часовом поясе пользователя.
 *
 * @param {string} isoDateTime Строка времени в формате ISO 8601.
 * @param {Object} [options] Параметры отображения.
 * @param {boolean} [options.withSeconds] Показывать ли секунды.
 * @returns {string} Отформатированное время либо прочерк.
 */
export function formatDateTime(isoDateTime, options = {}) {
    if (!isoDateTime) {
        return '—';
    }

    const moment = new Date(isoDateTime);
    if (Number.isNaN(moment.getTime())) {
        return '—';
    }

    return moment.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: options.withSeconds ? '2-digit' : undefined,
        timeZoneName: 'short',
    });
}

/**
 * Разбивает промежуток времени на составные части.
 *
 * Функция возвращает результат в виде готовых строк, а не сырых
 * чисел, поскольку каждый разряд требует собственного названия
 * и собственного формата записи с ведущими нулями.
 *
 * @param {number} totalMilliseconds Промежуток в миллисекундах.
 * @returns {Object} Объект с полями `days`, `hours`, `minutes`,
 *   `seconds` и `isPast`.
 */
export function splitDuration(totalMilliseconds) {
    const isPast = totalMilliseconds < 0;
    const absoluteMilliseconds = Math.abs(totalMilliseconds);

    const totalSeconds = Math.floor(absoluteMilliseconds / 1000);

    return {
        isPast,
        days: Math.floor(totalSeconds / 86400),
        hours: Math.floor((totalSeconds % 86400) / 3600),
        minutes: Math.floor((totalSeconds % 3600) / 60),
        seconds: totalSeconds % 60,
    };
}

/**
 * Дополняет число ведущими нулями до указанной длины.
 *
 * @param {number} value Значение.
 * @param {number} length Требуемая длина строки.
 * @returns {string} Строка с ведущими нулями.
 */
export function padNumber(value, length = 2) {
    return String(value).padStart(length, '0');
}

/**
 * Форматирует размер астероида с выбором подходящей единицы.
 *
 * Диаметры астероидов различаются на порядки: от сотен метров
 * у небольших тел до сотен километров у крупнейших. Единица
 * выбирается по величине значения, чтобы подпись оставалась
 * короткой и понятной.
 *
 * @param {number} diameterKm Диаметр в километрах.
 * @returns {string} Размер с единицей измерения.
 */
export function formatDiameter(diameterKm) {
    if (!diameterKm) {
        return '—';
    }

    if (diameterKm < 1) {
        return `${formatNumber(diameterKm * 1000, 0)} м`;
    }
    return `${formatNumber(diameterKm, 2)} км`;
}

/**
 * Переводит название месяца в короткую форму.
 *
 * Названия месяцев на графиках подписываются по-русски, поэтому
 * используется массив, а не механизм локализации: набор месяцев
 * фиксирован и не зависит от языка системы пользователя.
 *
 * @param {string} period Строка периода вида «2025-04».
 * @returns {string} Подпись вида «апр 25».
 */
export function formatMonthPeriod(period) {
    if (!period) {
        return '';
    }

    const monthNames = [
        'янв', 'фев', 'мар', 'апр', 'май', 'июн',
        'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
    ];

    const [year, month] = period.split('-');
    const monthIndex = Number(month) - 1;

    if (monthIndex < 0 || monthIndex > 11) {
        return period;
    }

    return `${monthNames[monthIndex]} ${year.slice(2)}`;
}

/**
 * Получает доступ к элементу страницы по его идентификатору.
 *
 * @param {string} elementId Идентификатор элемента.
 * @returns {HTMLElement|null} Элемент либо `null`, если не найден.
 */
export function getElement(elementId) {
    return document.getElementById(elementId);
}

/**
 * Создаёт элемент с заданными свойствами.
 *
 * @param {string} tagName Имя создаваемого элемента.
 * @param {Object} [properties] Свойства элемента, включая текст
 *   и классы оформления.
 * @returns {HTMLElement} Созданный элемент.
 */
export function createElement(tagName, properties = {}) {
    const element = document.createElement(tagName);

    for (const [name, value] of Object.entries(properties)) {
        if (name === 'textContent') {
            element.textContent = value;
        } else if (name === 'className') {
            element.className = value;
        } else {
            element.setAttribute(name, value);
        }
    }

    return element;
}
