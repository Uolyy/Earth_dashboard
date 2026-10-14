/**
 * Модуль обращения к собственному серверу приложения.
 *
 * Зачем нужен отдельный модуль
 * ----------------------------
 * Все обращения к серверу выполняются через функции этого модуля.
 * Такое решение позволяет собрать в одном месте три вещи, которые
 * иначе пришлось бы повторять
 * в каждом месте интерфейса:
 *
 * 1. Разбор единой оболочки ответа: сервер возвращает признак успеха,
 *    сами данные и сведения о том, были ли они получены из кэша.
 * 2. Обработку недоступности источника. Внешние сервисы периодически
 *    недоступны, поэтому интерфейс должен продолжать работать, а панель,
 *    чей источник не отвечает, показывает соответствующее сообщение.
 * 3. Повторные попытки с нарастающей паузой: кратковременный сбой сети
 *    не должен приводить к потере данных панели.
 *
 * Формат ответа сервера
 * ---------------------
 *     {
 *       "ok": true,
 *       "data": <полезная нагрузка>,
 *       "from_cache": false,
 *       "served_at": "2026-01-01T00:00:00+00:00"
 *     }
 *
 * При недоступности источника:
 *
 *     {
 *       "ok": false,
 *       "error": {
 *         "service": "имя источника",
 *         "message": "описание",
 *         "hint": "пояснение для пользователя"
 *       }
 *     }
 */

/** Базовый адрес сервера приложения. */
const API_BASE = '';

/**
 * Ожидание перед повторной попыткой.
 *
 * Значение растёт с каждой попыткой: при кратковременном сбое это
 * позволяет быстро восстановиться, а при длительном — не создавать
 * дополнительную нагрузку на источник.
 *
 * @param {number} attempt Номер попытки, начиная с единицы.
 * @returns {Promise<void>} Разрешается по прошествии паузы.
 */
function waitBeforeRetry(attempt) {
    const delayMilliseconds = 600 * Math.pow(2, attempt - 1);
    return new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
}

/**
 * Запрашивает данные у сервера приложения.
 *
 * @param {string} path Адрес маршрута, например '/api/iss'.
 * @param {Object} [options] Дополнительные параметры запроса.
 * @param {number} [options.retries] Сколько раз повторять при сбое.
 * @returns {Promise<any>} Данные из поля `data` ответа сервера.
 * @throws {Error} Исключение с описанием недоступности источника.
 */
export async function fetchFromApi(path, options = {}) {
    const retries = options.retries ?? 2;
    let lastError = null;

    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        try {
            const response = await fetch(`${API_BASE}${path}`, {
                headers: { 'Accept': 'application/json' },
            });

            const payload = await response.json();

            if (!payload.ok) {
                // Сервер корректно сообщил о недоступности источника.
                // Повторять такой запрос бессмысленно: причина находится
                // на стороне источника, а не в канале связи.
                const error = new Error(
                    payload.error?.message ?? 'Источник данных недоступен',
                );
                error.serviceName = payload.error?.service;
                error.isSourceFailure = true;
                throw error;
            }

            return payload.data;

        } catch (error) {
            // Ошибка источника повторяться не будет: запрос адресован
            // на сторону источника, а не на инфраструктуру приложения.
            if (error.isSourceFailure) {
                throw error;
            }

            lastError = error;
            if (attempt <= retries) {
                await waitBeforeRetry(attempt);
            }
        }
    }

    throw new Error(
        `Не удалось получить данные по адресу ${path}: ${lastError?.message ?? 'неизвестная причина'}`,
    );
}

/**
 * Показывает в указанном блоке сообщение о недоступности источника.
 *
 * Функция не удаляет прежнее содержимое блока целиком, а заменяет его
 * сообщением: это позволяет панели сохранить свою структуру
 * и показать пользователю, что именно перестало работать.
 *
 * @param {HTMLElement} container Блок, в котором отображается сообщение.
 * @param {Error} error Исключение, описывающее сбой.
 */
export function renderError(container, error) {
    if (!container) {
        return;
    }

    const serviceName = error.serviceName ?? 'источник данных';
    const message = document.createElement('div');
    message.className = 'module-error';

    // Сообщение строится через textContent, а не через innerHTML:
    // текст ошибки приходит из внешнего источника и не должен
    // интерпретироваться как разметка.
    const title = document.createElement('strong');
    title.textContent = `Источник «${serviceName}» недоступен.`;
    message.appendChild(title);

    const description = document.createElement('div');
    description.textContent = error.message ?? '';
    description.style.marginTop = '4px';
    message.appendChild(description);

    container.innerHTML = '';
    container.appendChild(message);
}

/**
 * Сообщает об ошибке через консоль, не прерывая работу интерфейса.
 *
 * @param {string} context Пояснение, где именно возникла ошибка.
 * @param {Error} error Само исключение.
 */
export function reportError(context, error) {
    console.warn(`[${context}]`, error?.message ?? error);
}
