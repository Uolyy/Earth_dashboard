/**
 * Графики панели интерфейса.
 *
 * Модуль содержит настройки оформления, общие для всех графиков,
 * и функции, создающие конкретные графики. Оформление вынесено
 * отдельно по той же причине, что и форматирование значений:
 * единообразие внешнего вида и отсутствие повторений.
 *
 * Выбор библиотеки
 * ----------------
 * Графики строятся средствами Chart.js, подключённой как обычный
 * сценарий. Библиотека загружена локально и не требует обращения
 * к внешней сети.
 *
 * Работа при отсутствии библиотеки
 * -------------------------------
 * Если по какой-либо причине Chart.js не загрузилась, графики не
 * создаются, а панели продолжают работать: функции этого модуля
 * проверяют наличие библиотеки и завершаются молча. Отсутствие
 * графика не должно мешать просмотру остальных сведений.
 */

import { fetchFromApi, reportError } from './api.js';
import { formatMonthPeriod, formatNumber } from './utils.js';

/**
 * Общие настройки оформления графиков.
 *
 * Значения согласованы с оформлением панели: тот же шрифт,
 * те же цвета, то же отсутствие рамок.
 */
const COMMON_OPTIONS = {
    responsive: true,
    maintainAspectRatio: false,
    // Анимация при обновлении данных отвлекает внимание и замедляет
    // восприятие изменений, поэтому она отключена.
    animation: false,
    interaction: {
        mode: 'index',
        intersect: false,
    },
    plugins: {
        legend: {
            display: false,
        },
        tooltip: {
            backgroundColor: 'rgba(8, 13, 24, 0.95)',
            borderColor: 'rgba(90, 170, 255, 0.3)',
            borderWidth: 1,
            titleColor: '#6ee7a8',
            bodyColor: '#cfe4f5',
            titleFont: { family: 'Consolas, monospace', size: 11 },
            bodyFont: { family: 'Consolas, monospace', size: 11 },
            padding: 8,
            displayColors: false,
        },
    },
    scales: {
        x: {
            grid: {
                color: 'rgba(90, 170, 255, 0.08)',
                drawTicks: false,
            },
            ticks: {
                color: '#6a8399',
                font: { family: 'Consolas, monospace', size: 9 },
                maxTicksLimit: 6,
            },
            border: { color: 'rgba(90, 170, 255, 0.15)' },
        },
        y: {
            grid: {
                color: 'rgba(90, 170, 255, 0.08)',
                drawTicks: false,
            },
            ticks: {
                color: '#6a8399',
                font: { family: 'Consolas, monospace', size: 9 },
                maxTicksLimit: 5,
            },
            border: { display: false },
        },
    },
};

/**
 * Проверяет, доступна ли библиотека построения графиков.
 *
 * @returns {boolean} Признак доступности библиотеки.
 */
function isChartLibraryAvailable() {
    return typeof window.Chart !== 'undefined';
}

/**
 * Строит график солнечного цикла.
 *
 * На графике сопоставляются два ряда: наблюдавшиеся значения числа
 * солнечных пятен и прогнозные значения для текущего цикла.
 * Сопоставление позволяет увидеть, насколько наблюдаемая активность
 * соответствует ожиданиям и на какой стадии находится цикл.
 *
 * @returns {Promise<void>} Разрешается после построения графика.
 */
export async function renderSolarCycleChart() {
    if (!isChartLibraryAvailable()) {
        return;
    }

    const canvas = document.getElementById('chart-solar-cycle');
    if (!canvas) {
        return;
    }

    try {
        const solarCycle = await fetchFromApi('/api/space-weather/solar-cycle');

        const observedLabels = solarCycle.observed.map((point) => point.period);
        const observedValues = solarCycle.observed.map((point) => point.sunspot_number);
        const predictedValues = solarCycle.predicted.map((point) => point.predicted_mid);

        // Наблюдения и прогноз относятся к разным промежуткам времени,
        // поэтому ряды выравниваются по общему перечню подписей:
        // отсутствующие значения оставляются пустыми.
        const allPeriods = [...new Set([
            ...observedLabels,
            ...solarCycle.predicted.map((point) => point.period),
        ])].sort();

        const observedByPeriod = new Map(
            solarCycle.observed.map((point) => [point.period, point.sunspot_number]),
        );
        const predictedByPeriod = new Map(
            solarCycle.predicted.map((point) => [point.period, point.predicted_mid]),
        );

        new window.Chart(canvas, {
            type: 'line',
            data: {
                labels: allPeriods.map(formatMonthPeriod),
                datasets: [
                    {
                        label: 'наблюдения',
                        data: allPeriods.map((period) => observedByPeriod.get(period) ?? null),
                        borderColor: '#5ad1ff',
                        backgroundColor: 'rgba(90, 209, 255, 0.12)',
                        borderWidth: 1.5,
                        pointRadius: 0,
                        fill: true,
                        tension: 0.3,
                    },
                    {
                        label: 'прогноз',
                        data: allPeriods.map((period) => predictedByPeriod.get(period) ?? null),
                        borderColor: '#ffb454',
                        borderWidth: 1.5,
                        borderDash: [4, 3],
                        pointRadius: 0,
                        fill: false,
                        tension: 0.3,
                    },
                ],
            },
            options: {
                ...COMMON_OPTIONS,
                scales: {
                    ...COMMON_OPTIONS.scales,
                    y: {
                        ...COMMON_OPTIONS.scales.y,
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'число пятен',
                            color: '#6a8399',
                            font: { family: 'Consolas, monospace', size: 9 },
                        },
                    },
                },
            },
        });

    } catch (error) {
        reportError('график солнечного цикла', error);
    }
}

/**
 * Строит график распределения спутников по группам.
 *
 * График показывает, сколько аппаратов насчитывается в каждой
 * группировке: спутники связи, научные и военные аппараты,
 * метеорологические спутники. Распределение позволяет увидеть,
 * какие задачи сейчас решаются активнее других.
 *
 * @returns {Promise<void>} Разрешается после построения графика.
 */
export async function renderSatellitesChart() {
    if (!isChartLibraryAvailable()) {
        return;
    }

    const canvas = document.getElementById('chart-satellites');
    if (!canvas) {
        return;
    }

    try {
        const satellites = await fetchFromApi('/api/satellites');
        const groups = satellites.groups ?? [];

        if (groups.length === 0) {
            return;
        }

        // Цвета распределяются по кругу: насыщенных оттенков,
        // различимых на тёмном фоне.
        const palette = [
            '#5ad1ff', '#6ee7a8', '#ffb454', '#ff7b9c',
            '#b98cff', '#4dd4c8', '#f2d16b', '#8fb3ff',
        ];

        new window.Chart(canvas, {
            type: 'bar',
            data: {
                labels: groups.map((group) => group.label),
                datasets: [{
                    label: 'спутников',
                    data: groups.map((group) => group.satellite_count),
                    backgroundColor: groups.map(
                        (group, index) => palette[index % palette.length] + '99',
                    ),
                    borderColor: groups.map(
                        (group, index) => palette[index % palette.length],
                    ),
                    borderWidth: 1,
                    borderRadius: 2,
                }],
            },
            options: {
                ...COMMON_OPTIONS,
                indexAxis: 'y',
                plugins: {
                    ...COMMON_OPTIONS.plugins,
                    tooltip: {
                        ...COMMON_OPTIONS.plugins.tooltip,
                        callbacks: {
                            // Значения округляются до целых: группы
                            // насчитываются целыми аппаратами.
                            label: (context) =>
                                `${formatNumber(context.parsed.x, 0)} спутников`,
                        },
                    },
                },
                scales: {
                    x: {
                        ...COMMON_OPTIONS.scales.y,
                        beginAtZero: true,
                    },
                    y: {
                        ...COMMON_OPTIONS.scales.x,
                        grid: { display: false },
                    },
                },
            },
        });

    } catch (error) {
        reportError('график спутников', error);
    }
}
