/**
 * Трёхмерная сцена: Земля, станция, орбита, звёздный фон.
 *
 * Общая идея модуля
 * -----------------
 * Модуль создаёт сцену средствами WebGL-библиотеки three.js и
 * поддерживает в ней следующие объекты:
 *
 * * Земля с текстурой, ночной стороной и атмосферным свечением.
 * * Модель станции, построенную из простых геометрических фигур.
 * * Траекторию станции: пройденную часть сплошной линией и
 *   прогнозную пунктиром.
 * * Область обзора станции — круг на поверхности Земли, из которого
 *   станция видна невооружённым глазом.
 * * Звёздное поле и полярное сияние, яркость которого зависит
 *   от геомагнитной активности.
 *
 * Соглашения о масштабе
 * ---------------------
 * Размеры в сцене выражены в радиусах Земли: одна условная единица
 * равна одной радиусной единице планеты. Такой выбор позволяет
 * использовать координаты, приходящие от сервера в километрах,
 * без пересчёта: значение просто делится на радиус Земли.
 *
 * Соглашение об осях
 * --------------------
 * Полярная ось сцены — это Y, а не Z. Выбор полярной оси определяется
 * не удобством, а тем, как three.js наносит равнопромежуточную карту
 * Земли на сферу: ось Y здесь в точности совпадает с осью вращения
 * планеты на текстуре. Ось X направлена к нулевому меридиану, ось Z —
 * к западу.
 *
 * Соглашения о вращении
 * ---------------------
 * Сцена вращается вокруг оси Земли с той же угловой скоростью,
 * с которой вращается сама планета. Благодаря этому станция
 * визуально «висит» над одной и той же точкой поверхности,
 * как и происходит в действительности: наблюдатель на станции
 * видит Землю неподвижной под собой. Координаты станции при этом
 * задаются в системе, связанной с поверхностью планеты.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Радиус Земли в километрах. Должен совпадать с серверным значением. */
const EARTH_RADIUS_KM = 6371;

/** Наклон земной оси в градусах. */
const EARTH_AXIAL_TILT_DEGREES = 23.44;

/**
 * Географическая широта ореола полярного сияния, в градусах.
 * Сияния наблюдаются в области примерно от 65 до 72 градусов
 * северной и южной широты, то есть вокруг магнитного полюса.
 */
const AURORA_LATITUDE_DEGREES = 67;

/**
 * Полная ширина полосы сияния в градусах. Поясняет разброс
 * частиц внутри ореола: они распределены по некоторой толщине,
 * а не лежат на одной линии.
 */
const AURORA_BAND_DEGREES = 7;

/**
 * Радиус сферы, на которой рисуется область обзора станции,
 * в долях радиуса Земли. Значение чуть больше единицы, чтобы
 * кольцо не проваливалось сквозь поверхность планеты из-за
 * погрешности разбиения сферы на полигоны.
 */
const FOOTPRINT_SURFACE_FRACTION = 1.008;

/**
 * Высота станции над поверхностью Земли в долях радиуса Земли.
 *
 * Величина применяется и к станции, и к её траектории. Это важно:
 * обе части должны лежать на одной и той же высоте, иначе станция
 * нарисована выше собственной траектории и не касается её.
 *
 * Прежние значения различались: станция бралась на 1,07, а траектория
 * на 1,035. Разница 0,035 — это 223 километра, то есть станция
 * висела над собственной траекторией на двести с лишним километров.
 *
 * Значение выбрано по реальной высоте МКС около 420 километров:
 * 420 / 6371 даёт примерно 0,066. Небольшой запас сверху нужен,
 * чтобы линия не проваливалась сквозь поверхность из-за погрешности
 * разбиения сферы на полигоны.
 */
const ORBIT_RADIUS = 1.07;

/**
 * Как часто пересчитывается граница между пройденной и прогнозной
 * частями траектории, в миллисекундах.
 *
 * Промежуток подобран так, чтобы граница шла за станцией почти
 * без запаздывания, но без лишней работы: между обновлениями
 * граница смещается примерно на 15 километров, что на экране
 * незаметно.
 */
const TRACK_SPLIT_INTERVAL = 2000;

/**
 * Переводит географические координаты в точку на поверхности сферы.
 *
 * Согласование с текстурой
 * ------------------------
 * Формула должна в точности совпадать с тем, как библиотека three.js
 * наносит равнопромежуточную карту Земли на сферу. Иначе любые
 * географические объекты — станция, траектория, площадка запуска,
 * сияние — окажутся не над теми местами, которые нарисованы на
 * картинке.
 *
 * three.js размещает на сфере северный полюс на оси Y, а нулевой
 * меридиан — на оси X. Поэтому ось Y здесь является полярной,
 * ось X направлена к нулевому меридиану, а ось Z — к западу.
 * Именно такая разметка используется во всём модуле: ось вращения
 * Земли, ось сияний и ось Земли в расчётах касательной — все они
 * задаются через ось Y.
 *
 * Раньше здесь ось Z считалась полярной. Из-за этого всё нанесённое
 * на сферу поворачивалось относительно карты на 90 градусов:
 * например, Vandenberg (34,6° с.ш., 120,6° з.д.) попадал
 * на 45° ю.ш. и 126° з.д., то есть в Южный океан.
 *
 * @param {number} latitudeDegrees Географическая широта в градусах.
 * @param {number} longitudeDegrees Географическая долгота в градусах.
 * @param {number} [radius] Радиус сферы в условных единицах.
 * @returns {THREE.Vector3} Координаты точки в системе сцены.
 */
export function geoToVector3(latitudeDegrees, longitudeDegrees, radius = 1) {
    const latitudeRadians = THREE.MathUtils.degToRad(latitudeDegrees);
    const longitudeRadians = THREE.MathUtils.degToRad(longitudeDegrees);

    // Радиус-вектор точки имеет единичную длину при radius = 1:
    // точка лежит ровно на поверхности сферы.
    const x = radius * Math.cos(latitudeRadians) * Math.cos(longitudeRadians);
    const y = radius * Math.sin(latitudeRadians);
    const z = -radius * Math.cos(latitudeRadians) * Math.sin(longitudeRadians);

    return new THREE.Vector3(x, y, z);
}

/**
 * Вычисляет положение Солнца относительно Земли.
 *
 * Положение определяется приближённо, по календарной дате: солнечная
 * долгота смещается примерно на один градус в сутки относительно точки
 * весеннего равноденствия, а наклон оси Земли задаёт сезонное
 * изменение широты Солнца. Такое приближение достаточно для
 * визуализации: расхождение с истинным положением измеряется
 * долями градуса и на восприятие не влияет.
 *
 * @param {Date} moment Момент времени, для которого определяется
 *   положение Солнца.
 * @returns {THREE.Vector3} Единичный вектор, направленный от центра
 *   Земли к Солнцу, в системе координат, связанной с осью вращения.
 */
export function calculateSunDirection(moment) {
    // Число дней, прошедших с начала года, определяет положение Солнца
    // относительно точки весеннего равноденствия и его склонение.
    const startOfYear = Date.UTC(moment.getUTCFullYear(), 0, 1);
    const dayOfYear = Math.floor((moment.getTime() - startOfYear) / 86400000);

    // Склонение Солнца меняется с периодом в год: максимально
    // в летнее солнцестояние и обращается в нуль в равноденствия.
    const seasonalPhase = THREE.MathUtils.degToRad(360 * (dayOfYear - 81) / 365.25);
    const subsolarLatitude = EARTH_AXIAL_TILT_DEGREES * Math.sin(seasonalPhase);

    // Долгота, на которой Солнце стоит в зените, меняется в течение
    // суток: Земля поворачивается вокруг своей оси, а Солнце остаётся
    // практически на месте. В полдень по всемирному времени зенит
    // приходится на нулевой меридиан, в полночь — на противоположный.
    // Именно эта величина определяет положение терминатора.
    const utcHours = moment.getUTCHours()
        + moment.getUTCMinutes() / 60
        + moment.getUTCSeconds() / 3600;

    // Уравнение времени — разница между истинным и средним солнечным
    // временем. Поправка на неё смещает терминатор на несколько
    // градусов и убирает заметный перекос линии рассвета.
    const meanAnomaly = THREE.MathUtils.degToRad(360 * (dayOfYear - 81) / 364);
    const equationOfTimeMinutes =
        9.87 * Math.sin(2 * meanAnomaly)
        - 7.53 * Math.cos(meanAnomaly)
        - 1.5 * Math.sin(meanAnomaly);

    const subsolarLongitude = -15 * (utcHours - 12) + equationOfTimeMinutes / 4;

    // Результат задаётся в связанной с поверхностью Земли системе
    // координат: та же система используется для текстуры планеты,
    // положения станции и траектории. Благодаря этому терминатор
    // остаётся согласованным с изображением Земли при любом времени.
    return geoToVector3(subsolarLatitude, subsolarLongitude, 1);
}

/**
 * Коэффициент увеличения модели станции.
 *
 * Пояснение о масштабе
 * --------------------
 * В сцене радиус Земли равен одной условной единице. Настоящая
 * станция имеет длину около 109 метров, то есть менее двух
 * десятитысячных долей радиуса Земли. В таком масштабе станция
 * не различима: она занимает на экране доли пикселя даже
 * при максимальном приближении.
 *
 * Поэтому модель увеличена. Коэффициент подбран так, чтобы станция
 * была отчётливо видна при общем виде планеты и оставалась
 * узнаваемой вблизи. Искажение пропорций относительно реальности
 * является осознанным приёмом визуализации: тот же приём
 * применяется, например, при изображении размеров Солнца
 * в сравнении с Землёй.
 *
 * Точные размеры и положение станции доступны в панели телеметрии
 * и на графиках, где масштаб не искажается.
 */
const STATION_MODEL_SCALE = 0.5;

/**
 * Отношение радиуса сферы-указателя к расстоянию от камеры.
 *
 * Указатель должен оставаться одинаково заметным при любом
 * приближении, поэтому его размер не задаётся в единицах сцены,
 * а пересчитывается по расстоянию до камеры. Значение подобрано так,
 * чтобы метка занимала около шести процентов высоты экрана.
 */
const STATION_MARKER_ANGULAR_RATIO = 0.012;

/**
 * Радиус сферы-указателя в масштабе модели, до общего увеличения.
 */
const STATION_MARKER_BASE_RADIUS = 0.026;

/**
 * Расстояние от центра Земли до камеры при переводе взгляда
 * на станцию, в условных единицах сцены.
 *
 * Радиус Земли равен одной единице, станция находится на высоте
 * около 1,05. Указанное значение больше радиуса планеты, поэтому
 * камера остаётся снаружи: иначе она оказалась бы внутри Земли
 * и наблюдала бы лишь изнанку поверхности.
 *
 * Камера встаёт строго на продолжении радиус-вектора станции,
 * то есть камера, станция и центр Земли оказываются на одной прямой,
 * а линия взгляда перпендикулярна поверхности планеты. Благодаря
 * этому станция всегда видна и никогда не закрывается диском Земли.
 *
 * Значение намеренно велико (раньше было 1.45, затем 1.6): чем ближе
 * камера к планете, тем сильнее на мониторах с высоким разрешением
 * растягивается текстура поверхности и заметнее её размытие. Если после
 * центрирования захотелось ближе, планету всегда можно приблизить
 * колесиком мыши вручную.
 */
const STATION_FOCUS_DISTANCE = 2.0;

/**
 * Переключатель способа перемещения камеры при смене цели.
 *
 * Если `true`, камера переходит к новой цели по дуге над поверхностью
 * планеты: направление на цель поворачивается вокруг центра Земли, а
 * расстояние до центра меняется отдельно. Камера обходит Землю снаружи,
 * как спутник на орбите.
 *
 * Если `false`, камера движется по прямой от текущей точки к нужной,
 * как это делал прежний код. При переходе на противоположную сторону
 * планеты камера при этом проходит сквозь Землю. Ошибка заметна только
 * на мгновение, поэтому её легко пропустить, но выглядит странно.
 *
 * Переключатель оставлен намеренно: способ выбран на глаз, и если
 * обход по дуге покажется неудобным, вернуть прямое движение можно
 * одной строкой, без правки остальной логики.
 */
const CAMERA_FOLLOWS_SURFACE = true;

/**
 * Переключатель вида, который показывается при открытии страницы.
 *
 * Если `true`, камера при загрузке встаёт над подспутниковой точкой
 * станции: видно сразу и Землю, и саму МКС над ней.
 *
 * Если `false`, камера остаётся там, где стояла изначально, и смотрит
 * в центр планеты. Видна всегда одна и та же половина Земли, а
 * континент под ней медленно уплывает, потому что планета вращается.
 *
 * Переключатель оставлен намеренно: что удобнее при первом взгляде на
 * дашборд, то и должно быть поведением по умолчанию.
 */
const DEFAULT_VIEW_FOLLOWS_STATION = true;

/**
 * На сколько поднять камеру над станцией при загрузке страницы.
 *
 * Расстояние больше, чем при слежении за станцией: при первом взгляде
 * нужно видеть планету целиком и место, где находится МКС, а не
 * отдельную конструкцию вблизи.
 */
const DEFAULT_VIEW_DISTANCE = 2.3;

/**
 * Расстояние от центра Земли до камеры при показе точки на поверхности.
 *
 * Значение меньше, чем при переводе к станции: рассматривается участок
 * поверхности, поэтому камере требуется более близкое положение.
 * Оно остаётся больше радиуса планеты, чтобы камера не оказалась
 * под её поверхностью. Раньше значение было 1.3, затем 1.45: вблизи
 * текстура планеты на экранах с высокой плотностью пикселей выглядит
 * размытой. При желании участок поверхности приближается колесиком.
 */
const LOCATION_FOCUS_DISTANCE = 2.0;

/**
 * Отношение радиуса маркера площадки к расстоянию от камеры.
 *
 * Маркер задаётся не в мировых единицах, а пропорционально
 * расстоянию до камеры. Иначе он выглядел бы по-разному в зависимости
 * от приближения: при общем виде был бы невидим, а при наведении камеры
 * на площадку занимал бы треть экрана.
 */
const LOCATION_MARKER_ANGULAR_RATIO = 0.012;

/**
 * Внутренний и внешний радиусы кольца-маркера площадки, в единицах
 * модели. Отношение между ними задаёт толщину кольца.
 */
const LOCATION_MARKER_INNER_RADIUS = 0.018;
const LOCATION_MARKER_OUTER_RADIUS = 0.028;

/**
 * Создаёт модель станции из простых геометрических фигур.
 *
 * Модель намеренно состоит из элементарных фигур: цилиндров,
 * панелей и прямоугольников. Такой подход избавляет от необходимости
 * загружать готовую трёхмерную модель и позволяет описать взаимное
 * расположение частей конструкции непосредственно в коде.
 *
 * @returns {THREE.Group} Группа объектов, образующих станцию.
 */
function createStationModel() {
    const station = new THREE.Group();

    // Основной модуль станции: цилиндр вдоль продольной оси.
    const moduleMaterial = new THREE.MeshStandardMaterial({
        color: 0xc8ccd4,
        roughness: 0.55,
        metalness: 0.6,
    });

    const mainModule = new THREE.Mesh(
        new THREE.CylinderGeometry(0.006, 0.006, 0.03, 16),
        moduleMaterial,
    );
    mainModule.rotation.z = Math.PI / 2;
    station.add(mainModule);

    // Солнечные панели: плоские прямоугольники по обеим сторонам.
    const panelMaterial = new THREE.MeshStandardMaterial({
        color: 0x1a3d6b,
        roughness: 0.35,
        metalness: 0.8,
        emissive: 0x0a1a33,
        emissiveIntensity: 0.35,
        // Панели отражают свет с двух сторон, поэтому материал
        // объявляется двусторонним.
        side: THREE.DoubleSide,
    });

    for (const direction of [1, -1]) {
        const panel = new THREE.Mesh(
            new THREE.BoxGeometry(0.024, 0.0015, 0.011),
            panelMaterial,
        );
        panel.position.x = direction * 0.027;
        station.add(panel);

        // Соединительная конструкция между модулем и панелью.
        const arm = new THREE.Mesh(
            new THREE.CylinderGeometry(0.0006, 0.0006, 0.012, 6),
            moduleMaterial,
        );
        arm.rotation.z = Math.PI / 2;
        arm.position.x = direction * 0.019;
        station.add(arm);
    }

    // Фотомодули на обоих концах цилиндра.
    const sensorMaterial = new THREE.MeshStandardMaterial({
        color: 0x8a9099,
        roughness: 0.4,
        metalness: 0.7,
    });

    for (const direction of [1, -1]) {
        const sensor = new THREE.Mesh(
            new THREE.CylinderGeometry(0.0035, 0.0035, 0.002, 12),
            sensorMaterial,
        );
        sensor.rotation.z = Math.PI / 2;
        sensor.position.x = direction * 0.016;
        station.add(sensor);
    }

    // Светящаяся сфера вокруг станции. Она выполняет роль указателя:
    // даже когда сама конструкция выглядит мелкой, метка позволяет
    // безошибочно определить положение аппарата на диске Земли.
    // Сфера не отбрасывает тени и не влияет на освещение сцены.
    const markerMaterial = new THREE.MeshBasicMaterial({
        color: 0x6ee7a8,
        transparent: true,
        opacity: 0.55,
    });

    const marker = new THREE.Mesh(
        new THREE.SphereGeometry(STATION_MARKER_BASE_RADIUS, 20, 20),
        markerMaterial,
    );
    station.add(marker);

    // Вся группа увеличивается: коэффициент применяется после того,
    // как все части модели созданы в едином масштабе.
    station.scale.setScalar(STATION_MODEL_SCALE);

    // Ссылка на сферу-указатель сохраняется в данных группы:
    // при движении камеры её размер пересчитывается, чтобы метка
    // оставалась заметной и при общем виде, и при близком.
    station.userData.marker = marker;
    station.userData.markerBaseRadius =
        STATION_MARKER_BASE_RADIUS * STATION_MODEL_SCALE;

    return station;
}

/**
 * Создаёт звёздное поле.
 *
 * Звёзды распределяются по сфере, окружающей сцену. Яркость
 * определяется случайной величиной: однородная яркость всех звёзд
 * выглядела бы неестественно плоско.
 *
 * @param {number} starCount Количество звёзд.
 * @returns {THREE.Points} Объект, отображающий звёздное поле.
 */
function createStarField(starCount) {
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);

    for (let index = 0; index < starCount; index += 1) {
        // Точка на сфере выбирается равномерно: долгота распределяется
        // равномерно, а широта — через преобразование, обеспечивающее
        // одинаковую плотность по всей поверхности сферы.
        const longitude = Math.random() * Math.PI * 2;
        const latitude = Math.acos(2 * Math.random() - 1);
        const distance = 260 + Math.random() * 40;

        positions[index * 3] = distance * Math.sin(latitude) * Math.cos(longitude);
        positions[index * 3 + 1] = distance * Math.sin(latitude) * Math.sin(longitude);
        positions[index * 3 + 2] = distance * Math.cos(latitude);

        // Цвет звезды смещается от белого к тёплому или холодному,
        // что придаёт полю естественный вид.
        const warmth = Math.random();
        colors[index * 3] = 0.75 + warmth * 0.25;
        colors[index * 3 + 1] = 0.78 + Math.random() * 0.18;
        colors[index * 3 + 2] = 0.85 + (1 - warmth) * 0.15;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 0.5,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
    });

    return new THREE.Points(geometry, material);
}

/**
 * Класс, управляющий трёхмерной сценой.
 *
 * Экземпляр класса создаётся один раз и обслуживает всю отрисовку.
 * Наружу класс предоставляет только несколько методов, которые
 * вызывает основной модуль интерфейса: установка положения станции,
 * обновление траектории и перевод камеры.
 */
export class SpaceScene {
    /**
     * @param {string} canvasId Идентификатор элемента полотна.
     */
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            // Предпочтение высокой производительности подсказывает
            // браузеру, что сцена требует ресурсов: полезно на слабых
            // устройствах для выбора менее насыщенных настроек.
            powerPreference: 'high-performance',
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.scene = new THREE.Scene();

        this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
        this.camera.position.set(0, 1.4, 3.2);

        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.06;
        this.controls.minDistance = 0.35;
        this.controls.maxDistance = 12;

        // Как только пользователь начинает управлять камерой,
        // автоматическое слежение прекращается: иначе интерполяция
        // немедленно вернула бы камеру к прежней цели.
        this.controls.addEventListener('start', () => {
            this.isTrackingStation = false;
            this.focusPoint = null;
        });

        // Источник направленного света удалён от центра сцены,
        // чтобы соответствовать солнечному освещению.
        this.sunLight = new THREE.DirectionalLight(0xffffff, 3.2);
        // Источник света принадлежит вращающейся группе Земли, а не
        // мировой сцене. В системе, связанной с поверхностью планеты,
        // положение Солнца задаётся долготой подсолнечной точки. Если
        // оставить свет в мировой системе, он не повернётся вместе с
        // текстурой Земли, и терминатор уедет от реального времени.
        this.earthGroup = new THREE.Group();
        this.earthGroup.add(this.sunLight);

        // Мягкое заполняющее освещение предотвращает полной темноты
        // на ночной стороне, где видны огни городов.
        this.ambientLight = new THREE.AmbientLight(0x2a3f5f, 0.6);
        this.scene.add(this.ambientLight);

        this.scene.add(this.earthGroup);

        this.starField = createStarField(6000);
        this.scene.add(this.starField);

        this.aurora = null;
        this.station = null;
        this.stationMarker = null;
        this.stationMarkerBaseRadius = STATION_MARKER_BASE_RADIUS;
        this.orbitLines = null;
        // Отсчёты траектории и последнее положение границы между
        // пройденной и прогнозной частями. Граница нужна для того,
        // чтобы не перестраивать линии, пока она почти не сдвинулась.
        this.trackSamples = [];
        this.trackBoundaryPosition = null;
        this.lastTrackSplitTime = 0;
        this.footprint = null;
        this.footprintMarker = null;
        this.footprintGroup = null;
        this.stationNeedle = null;

        this.stationPosition = new THREE.Vector3(1.05, 0, 0);
        this.cameraTarget = new THREE.Vector3(0, 0, 0);
        this.isTrackingStation = false;

        // Точка на поверхности Земли, на которую наведена камера.
        // Задаётся в связанной с планетой системе координат, поэтому
        // поворачивается вместе с ней.
        this.focusPoint = null;
        this.focusDistance = STATION_FOCUS_DISTANCE;
        this.locationMarker = null;

        // Угловая скорость вращения Земли: один оборот за звёздные сутки,
        // то есть за 23 часа 56 минут 4 секунды.
        this.earthRotationSpeed = (Math.PI * 2) / 86164;

        this.clock = new THREE.Clock();
        this.lastSunUpdate = 0;

        this.handleResize = this.handleResize.bind(this);
        this.animate = this.animate.bind(this);

        window.addEventListener('resize', this.handleResize);
        this.handleResize();
    }

    /**
     * Загружает текстуры Земли и создаёт её модель.
     *
     * Функция выполняется один раз при запуске интерфейса.
     * Текстуры загружаются из локальной директории: проект не зависит
     * от внешних сетей доставки содержимого.
     *
     * @returns {Promise<void>} Разрешается после загрузки текстур.
     */
    async loadEarth() {
        const textureLoader = new THREE.TextureLoader();

        const [dayTexture, nightTexture] = await Promise.all([
            textureLoader.loadAsync('/assets/earth-blue-marble.jpg'),
            textureLoader.loadAsync('/assets/earth-night.jpg'),
        ]);

        dayTexture.colorSpace = THREE.SRGBColorSpace;
        nightTexture.colorSpace = THREE.SRGBColorSpace;

        // Основная сфера: дневная текстура на освещённой стороне.
        const earthMesh = new THREE.Mesh(
            new THREE.SphereGeometry(1, 64, 64),
            new THREE.MeshStandardMaterial({
                map: dayTexture,
                roughness: 0.9,
                metalness: 0.05,
            }),
        );
        this.earthGroup.add(earthMesh);

        // Ночная сторона. Огни городов светятся сами по себе,
        // поэтому этот слой не зависит от освещения сцены, а смешивается
        // с основным изображением в режиме сложения.
        const nightMesh = new THREE.Mesh(
            new THREE.SphereGeometry(1.005, 64, 64),
            new THREE.MeshBasicMaterial({
                map: nightTexture,
                blending: THREE.AdditiveBlending,
                transparent: true,
                opacity: 0.75,
            }),
        );
        this.earthGroup.add(nightMesh);

        // Атмосферное свечение по краю диска Земли.
        const atmosphereMesh = new THREE.Mesh(
            new THREE.SphereGeometry(1.06, 48, 48),
            new THREE.ShaderMaterial({
                vertexShader: `
                    varying vec3 vNormal;
                    void main() {
                        vNormal = normalize(normalMatrix * normal);
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    varying vec3 vNormal;
                    void main() {
                        // Яркость свечения определяется тем, насколько
                        // данная точка обращена к наблюдателю: у края диска
                        // нормаль перпендикулярна направлению взгляда,
                        // и свечение становится заметным.
                        float rim = 0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0));
                        float intensity = pow(max(rim, 0.0), 2.6);
                        gl_FragColor = vec4(0.25, 0.55, 1.0, 1.0) * intensity;
                    }
                `,
                side: THREE.BackSide,
                blending: THREE.AdditiveBlending,
                transparent: true,
            }),
        );
        this.earthGroup.add(atmosphereMesh);

        this.aurora = this.createAurora();
        this.earthGroup.add(this.aurora);

        this.updateSunPosition(new Date());
    }

    /**
     * Создаёт полярное сияние над полюсами Земли.
     *
     * Сияние представляется кольцом из светящихся частиц,
     * распределённых вокруг магнитной оси планеты. Его яркость
     * зависит от геомагнитной активности: при спокойной обстановке
     * сияние едва заметно, во время магнитной бури становится ярким.
     *
     * @returns {THREE.Points} Объект, отображающий сияние.
     */
    createAurora() {
        const particleCount = 4000;
        const positions = new Float32Array(particleCount * 3);
        const colors = new Float32Array(particleCount * 3);

        for (let index = 0; index < particleCount; index += 1) {
            // Кольцо располагается вокруг магнитной оси на широте
            // около 67 градусов: в этой области сияния наблюдаются
            // наиболее часто.
            //
            // Широта задаётся в градусах и переводится в радианы, как
            // того требует формула сферических координат. Раньше здесь
            // стояло значение 0,055 радиана, то есть 3 градуса: кольцо
            // уходило к экватору и выглядело полосой поперёк Земли
            // вместо ореола у полюсов.
            const polarAngle = Math.random() * Math.PI * 2;
            const axialAngle = THREE.MathUtils.degToRad(
                AURORA_LATITUDE_DEGREES + (Math.random() - 0.5) * AURORA_BAND_DEGREES,
            );
            const surfaceRadius = 0.985 + Math.random() * 0.03;
            const radial = surfaceRadius * Math.cos(axialAngle);

            // Ось кольца совпадает с осью вращения Земли, то есть с
            // осью Y. Именно поэтому широта пишется во вторую
            // координату: ось Z отведена под долготу.
            //
            // Раньше широта попадала в Z, а ось кольца считалась
            // повёрнутой на 90 градусов. Из-за этого ореал оказывался
            // не у полюса, а на экваторе — визуально над Мексикой.
            positions[index * 3] = radial * Math.cos(polarAngle);
            positions[index * 3 + 1] = surfaceRadius * Math.sin(axialAngle);
            positions[index * 3 + 2] = -radial * Math.sin(polarAngle);

            // Цвет плавно меняется от зелёного к фиолетовому по мере
            // удаления от поверхности: так выглядит сияние в реальности.
            const height = Math.random();
            colors[index * 3] = 0.15 + height * 0.55;
            colors[index * 3 + 1] = 0.9 - height * 0.25;
            colors[index * 3 + 2] = 0.35 + height * 0.4;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const material = new THREE.PointsMaterial({
            size: 0.012,
            vertexColors: true,
            transparent: true,
            opacity: 0.4,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });

        return new THREE.Points(geometry, material);
    }

    /**
     * Устанавливает яркость полярного сияния.
     *
     * @param {number} kpIndex Индекс геомагнитной активности от 0 до 9.
     */
    setAuroraIntensity(kpIndex) {
        if (!this.aurora || kpIndex === null || kpIndex === undefined) {
            return;
        }

        // При спокойной обстановке сияние едва заметно, при максимальной
        // активности его яркость возрастает в несколько раз.
        const normalizedActivity = Math.min(Math.max(kpIndex / 9, 0), 1);
        this.aurora.material.opacity = 0.18 + normalizedActivity * 0.72;
        this.aurora.scale.setScalar(1 + normalizedActivity * 0.04);
    }

    /**
     * Обновляет положение станции и её ориентацию.
     *
     * Модель станции ориентируется вдоль движения: продольная ось
     * направлена по касательной к поверхности в точке нахождения
     * станции, что соответствует реальному положению аппарата.
     *
     * @param {number} latitudeDegrees Географическая широта станции.
     * @param {number} longitudeDegrees Географическая долгота станции.
     * @returns {THREE.Vector3} Положение станции в системе сцены.
     */
    setStationPosition(latitudeDegrees, longitudeDegrees) {
        // Радиус задаётся с учётом высоты станции над поверхностью.
        // Тот же радиус применяется к траектории, поэтому станция
        // всегда лежит ровно на нарисованной линии.
        const position = geoToVector3(
            latitudeDegrees, longitudeDegrees, ORBIT_RADIUS,
        );
        this.stationPosition.copy(position);

        if (!this.station) {
            this.station = createStationModel();
            this.stationMarker = this.station.userData.marker;
            this.stationMarkerBaseRadius = this.station.userData.markerBaseRadius;
            this.earthGroup.add(this.station);
        }

        this.station.position.copy(position);

        // Отрезок, соединяющий станцию с подповерхностной точкой.
        // Он служит указателем: положение аппарата над поверхностью
        // становится очевидным даже при виде сверху, когда сама
        // станция закрыта диском Земли.
        if (!this.stationNeedle) {
            const needleGeometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 1, 0),
            ]);
            const needleMaterial = new THREE.LineBasicMaterial({
                color: 0x6ee7a8,
                transparent: true,
                opacity: 0.7,
            });
            this.stationNeedle = new THREE.Line(needleGeometry, needleMaterial);
            this.earthGroup.add(this.stationNeedle);
        }

        // Отрезок направлен к центру Земли: при таком направлении
        // он всегда оказывается перпендикулярным поверхности планеты.
        this.stationNeedle.position.copy(position).normalize();
        this.stationNeedle.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            position.clone().normalize().negate(),
        );
        // Длина отрезка равна разности радиусов: от поверхности Земли
        // до положения станции.
        this.stationNeedle.scale.setScalar(position.length() - 1.0);

        // Ориентация: продольная ось модели направляется по касательной
        // к поверхности. Касательная перпендикулярна радиус-вектору
        // и оси вращения Земли, поэтому находится их векторное
        // произведение.
        const upVector = position.clone().normalize();
        const axisOfEarth = new THREE.Vector3(0, 1, 0);
        const tangent = new THREE.Vector3()
            .crossVectors(axisOfEarth, upVector)
            .normalize();

        this.station.quaternion.setFromUnitVectors(
            new THREE.Vector3(1, 0, 0),
            tangent,
        );

        return position;
    }

    /**
     * Строит линии траектории станции.
     *
     * Пройденная часть пути отображается сплошной линией,
     * прогнозная — пунктиром. Такое различие позволяет отличить
     * фактическое положение станции от вычисленного прогноза.
     *
     * Замечание о запаздывании
     * ------------------------
     * Точки траектории приходят с метками времени, и граница между
     * сплошной и пунктирной частями вычисляется по текущему моменту,
     * а не берётся из ответа сервера. Если бы граница фиксировалась
     * в момент запроса, то пунктир превращался бы в сплошную линию
     * с заметным опозданием: до следующего обновления траектории
     * прошло бы целиком 60 секунд, а за это время станция смещается
     * примерно на 460 километров.
     *
     * @param {Array<{latitude: number, longitude: number}>} pastTrack
     *   Точки пройденной траектории.
     * @param {Array<{latitude: number, longitude: number}>} futureTrack
     *   Точки прогнозной траектории.
     */
    setOrbitTracks(pastTrack, futureTrack) {
        // Прежние линии удаляются вместе с их ресурсами: иначе
        // при каждом обновлении расходуется память графического
        // процессора, что со временем приводит к его исчерпанию.
        this.disposeOrbitLines();

        // Обе части траектории складываются в один ряд, упорядоченный
        // по времени. Ряд хранится целиком, а граница между сплошной
        // и пунктирной частями вычисляется отдельно в updateTrackSplit.
        //
        // Так граница следует за текущим временем и не отстаёт от
        // станции, как это было бы при фиксации момента запроса.
        const samples = [];

        for (const point of [...(pastTrack ?? []), ...(futureTrack ?? [])]) {
            const moment = Date.parse(point.time);

            if (!Number.isFinite(moment)) {
                continue;
            }

            // На стыке двух частей находится одна и та же точка:
            // она приходит и в конце прошлого, и в начале будущего
            // ряда. Повтор пропускается, иначе линия получила бы
            // лишний отрезок нулевой длины.
            const previous = samples[samples.length - 1];
            if (previous && Math.abs(previous.time - moment) < 1000) {
                continue;
            }

            samples.push({
                time: moment,
                position: geoToVector3(point.latitude, point.longitude, ORBIT_RADIUS),
            });
        }

        samples.sort((first, second) => first.time - second.time);
        this.trackSamples = samples;

        this.orbitLines = new THREE.Group();
        this.earthGroup.add(this.orbitLines);

        this.updateTrackSplit(Date.now());
    }

    /**
     * Удаляет линии траектории вместе с их ресурсами.
     */
    disposeOrbitLines() {
        if (!this.orbitLines) {
            return;
        }

        this.earthGroup.remove(this.orbitLines);
        this.orbitLines.traverse((object) => {
            if (object.geometry) {
                object.geometry.dispose();
            }
            if (object.material) {
                object.material.dispose();
            }
        });

        this.orbitLines = null;
    }

    /**
     * Перестраивает границу между пройденной и прогнозной траекторией.
     *
     * Граница ставится в текущий момент времени. Сама точка границы не
     * совпадает ни с одной из полученных точек: она вставляется между
     * двумя соседними отсчётами, поэтому линия стыкуется ровно на
     * станции, а не на ближайшем отсчёте, отстоящем на полминуты.
     *
     * Функция вызывается регулярно из цикла отрисовки, поэтому
     * перестраивает линии не всегда, а лишь при заметном изменении
     * границы.
     */
    updateTrackSplit(currentTime) {
        const samples = this.trackSamples;

        if (!samples || samples.length < 2) {
            return;
        }

        // Граница не должна смещаться чаще, чем на мелкий шаг:
        // иначе строки геометрии переписывались бы на каждом кадре.
        const boundary = this.findTrackBoundary(samples, currentTime);

        if (this.trackBoundaryPosition
            && this.trackBoundaryPosition.distanceTo(boundary.position) < 0.0015) {
            return;
        }

        this.trackBoundaryPosition = boundary.position.clone();

        const pastPoints = [];
        const futurePoints = [];

        for (const sample of samples) {
            if (sample.time <= currentTime) {
                pastPoints.push(sample.position);
            } else {
                futurePoints.push(sample.position);
            }
        }

        // Точка границы принадлежит обеим линиям: сплошная на ней
        // заканчивается, пунктирная из неё начинается. Без этого
        // между линиями появлялся бы разрыв.
        if (pastPoints.length > 0) {
            pastPoints.push(boundary.position);
        }

        if (futurePoints.length > 0) {
            futurePoints.unshift(boundary.position);
        }

        this.clearTrackLines();

        if (pastPoints.length > 1) {
            this.orbitLines.add(
                this.createTrackLine(pastPoints, 0x5ad1ff, 0.85, false),
            );
        }

        if (futurePoints.length > 1) {
            // Прогнозная линия рисуется бледнее и пунктиром.
            this.orbitLines.add(
                this.createTrackLine(futurePoints, 0x3a8fb8, 0.5, true),
            );
        }
    }

    /**
     * Удаляет линии траектории, не трогая саму группу.
     *
     * Отдельный метод нужен потому, что при перестроении границы
     * группа остаётся на месте: её удаление и добавление заново
     * заставляло бы three.js заново обходить дерево сцены.
     */
    clearTrackLines() {
        if (!this.orbitLines) {
            return;
        }

        for (const line of [...this.orbitLines.children]) {
            this.orbitLines.remove(line);
            line.geometry.dispose();
            line.material.dispose();
        }
    }

    /**
     * Находит точку траектории для указанного момента времени.
     *
     * Точки отсчёта идут с равномерным шагом, поэтому нужная точка
     * лежит между двумя соседними отсчётами. Искомое положение
     * получается пропорциональным смещением между ними.
     *
     * @param {Array<{time: number, position: THREE.Vector3}>} samples
     *   Отсчёты траектории, упорядоченные по времени.
     * @param {number} currentTime Момент времени в миллисекундах.
     * @returns {{position: THREE.Vector3, index: number}} Точка
     *   границы и индекс отсчёта, на котором она стоит.
     */
    findTrackBoundary(samples, currentTime) {
        const lastIndex = samples.length - 1;

        if (currentTime <= samples[0].time) {
            return { position: samples[0].position.clone(), index: 0 };
        }

        if (currentTime >= samples[lastIndex].time) {
            return { position: samples[lastIndex].position.clone(), index: lastIndex };
        }

        // Отсчёты идут с постоянным шагом, поэтому нужный находится
        // делением на длину шага, без перебора ряда.
        const step = (samples[lastIndex].time - samples[0].time) / lastIndex;
        const approximateIndex = Math.floor(
            (currentTime - samples[0].time) / step,
        );

        // Оценка округляется, поэтому границу приходится уточнять.
        // Сдвиг ограничен несколькими отсчётами.
        let index = THREE.MathUtils.clamp(approximateIndex, 0, lastIndex - 1);

        while (index < lastIndex && samples[index + 1].time < currentTime) {
            index += 1;
        }

        while (index > 0 && samples[index].time > currentTime) {
            index -= 1;
        }

        const previous = samples[index];
        const next = samples[index + 1];
        const span = next.time - previous.time;
        const fraction = span > 0
            ? THREE.MathUtils.clamp((currentTime - previous.time) / span, 0, 1)
            : 0;

        return {
            position: previous.position.clone().lerp(next.position, fraction),
            index,
        };
    }

    /**
     * Создаёт линию по набору точек.
     *
     * @param {THREE.Vector3[]} points Точки линии.
     * @param {number} color Цвет линии.
     * @param {number} opacity Прозрачность линии.
     * @param {boolean} isDashed Признак пунктирной линии.
     * @returns {THREE.Line} Объект линии.
     */
    createTrackLine(points, color, opacity, isDashed) {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);

        const material = isDashed
            ? new THREE.LineDashedMaterial({
                color,
                transparent: true,
                opacity,
                dashSize: 0.02,
                gapSize: 0.014,
            })
            : new THREE.LineBasicMaterial({ color, transparent: true, opacity });

        const line = new THREE.Line(geometry, material);

        if (isDashed) {
            // Пунктир вычисляется библиотекой на основе длин отрезков,
            // поэтому расстояния должны быть заданы явно.
            line.computeLineDistances();
        }

        return line;
    }

    /**
     * Отображает область обзора станции.
     *
     * Область обзора — круг на поверхности Земли, из которого
     * станция видна невооружённым глазом. Радиус этого круга
     * зависит от высоты станции и составляет около 2270 километров,
     * то есть примерно треть радиуса Земли. Источник отдаёт это
     * значение как диаметр, поэтому сервер делит его пополам
     * до того, как радиус попадает сюда.
     *
     * @param {number} footprintKm Радиус области обзора в километрах.
     */
    setFootprint(footprintKm) {
        if (!footprintKm) {
            if (this.footprintGroup) {
                this.footprintGroup.visible = false;
            }
            return;
        }

        if (!this.footprintGroup) {
            // Группа содержит саму окружность и её подповерхностную
            // копию. Подповерхностная копия нужна для случая, когда
            // камера оказывается по ту сторону планеты: без неё
            // область обзора пропадала бы целиком, хотя станция всё
            // ещё видна.
            this.footprint = this.createFootprintRing();
            this.footprint.geometry.dispose();

            // Копия показывается сквозь планету: для линии параметр
            // side не действует, поэтому обратная сторона для неё
            // неотличима от прямой. Видимость обеспечивается
            // отключением проверки глубины.
            this.footprintMarker = this.createFootprintRing();
            this.footprintMarker.geometry.dispose();
            this.footprintMarker.material.opacity = 0.14;
            this.footprintMarker.material.depthTest = false;
            this.footprintMarker.renderOrder = 1;

            this.footprintGroup = new THREE.Group();
            this.footprintGroup.add(this.footprint);
            this.footprintGroup.add(this.footprintMarker);
            this.earthGroup.add(this.footprintGroup);
        }

        this.footprintGroup.visible = true;

        // Угол, под которым из центра Земли видна граница области
        // обзора. Радиус задан в километрах, поэтому переводится
        // в угол делением на радиус Земли.
        const footprintAngle = THREE.MathUtils.degToRad(
            THREE.MathUtils.clamp(footprintKm / EARTH_RADIUS_KM * 180 / Math.PI, 1, 89),
        );

        // Окружность строится по сфере вокруг подспутниковой точки
        // станции. Плоское кольцо в касательной плоскости здесь
        // не годилось: при взгляде сбоку оно выходило за силуэт
        // Земли, потому что прямая не совпадает с дугой окружности
        // на сфере.
        const ringPoints = this.buildFootprintPoints(footprintAngle);

        this.footprint.geometry.dispose();
        this.footprint.geometry = new THREE.BufferGeometry().setFromPoints(ringPoints);

        this.footprintMarker.geometry.dispose();
        this.footprintMarker.geometry = new THREE.BufferGeometry().setFromPoints(ringPoints);
    }

    /**
     * Строит точки окружности, очерчивающей область обзора.
     *
     * Окружность лежит на поверхности сферы радиуса Земли и
     * проходит вокруг подспутниковой точки станции.
     *
     * @param {number} footprintAngle Угол радиуса области обзора,
     *   заданный в радианах.
     * @returns {THREE.Vector3[]} Точки окружности в связанной
     *   с поверхностью планеты системе координат.
     */
    buildFootprintPoints(footprintAngle) {
        // Подспутниковая точка: положение станции без учёта высоты.
        const center = this.stationPosition.clone().normalize();

        // Оси для построения окружности: одна направлена к полюсу,
        // другая перпендикулярна ей и центру. Векторное произведение
        // даёт третью ось, по которой отсчитывается угол вокруг
        // центра.
        const northAxis = new THREE.Vector3(0, 1, 0);
        let firstAxis = new THREE.Vector3().crossVectors(center, northAxis);

        // Если станция оказалась точно над полюсом, векторное
        // произведение вырождается в ноль, и ось приходится задать
        // произвольно.
        if (firstAxis.lengthSq() < 1e-12) {
            firstAxis = new THREE.Vector3(1, 0, 0);
        }
        firstAxis.normalize();

        const secondAxis = new THREE.Vector3()
            .crossVectors(center, firstAxis)
            .normalize();

        const points = [];
        const pointCount = 96;

        for (let index = 0; index < pointCount; index += 1) {
            const azimuth = (index / pointCount) * Math.PI * 2;

            // Точка на сфере, отстоящая от центра на угол
            // footprintAngle, раскладывается на две составляющие:
            // вдоль радиус-вектора центра и поперёк его.
            //
            // Обе составляющие обязательны. Без множителя cos
            // длина точки получается больше радиуса Земли, и
            // кольцо всплывало над планетой отдельным кольцом.
            const perpendicular = firstAxis.clone()
                .multiplyScalar(Math.cos(azimuth))
                .add(secondAxis.clone().multiplyScalar(Math.sin(azimuth)));

            points.push(center.clone()
                .multiplyScalar(Math.cos(footprintAngle))
                .add(perpendicular.multiplyScalar(Math.sin(footprintAngle)))
                .multiplyScalar(FOOTPRINT_SURFACE_FRACTION));
        }

        return points;
    }

    /**
     * Создаёт кольцо, обозначающее область обзора.
     *
     * @returns {THREE.LineLoop} Ломаная линия с замкнутой окружностью.
     */
    createFootprintRing() {
        // Граница области обзора рисуется линией, проходящей через
        // заранее рассчитанные точки на поверхности сферы. Число
        // точек достаточно велико, чтобы окружность выглядела
        // ровной даже при сильном увеличении.
        //
        // Начальная геометрия пустая и заменяется в setFootprint:
        // её положение зависит от текущего положения станции.
        const geometry = new THREE.BufferGeometry();
        const material = new THREE.LineBasicMaterial({
            color: 0x6ee7a8,
            transparent: true,
            opacity: 0.42,
            depthWrite: false,
        });

        return new THREE.LineLoop(geometry, material);
    }

    /**
     * Подгоняет размер маркера площадки под расстояние до камеры.
     *
     * Маркер должен оставаться одинаково заметным при любом
     * приближении, поэтому его размер пересчитывается по расстоянию
     * до камеры: на экране кольцо сохраняет постоянный размер.
     */
    updateLocationMarkerSize() {
        if (!this.locationMarker) {
            return;
        }

        const distanceToCamera = this.camera.position.distanceTo(
            this.locationMarkerWorldPosition(),
        );
        const desiredRadius = distanceToCamera * LOCATION_MARKER_ANGULAR_RATIO;

        // Масштаб узла складывается с масштабом родителя, поэтому
        // здесь указывается отношение к радиусу в масштабе модели.
        this.locationMarker.scale.setScalar(
            desiredRadius / this.locationMarkerBaseRadius,
        );
    }

    /**
     * Возвращает положение маркера площадки в мировой системе.
     *
     * Маркер принадлежит вращающейся группе Земли, поэтому перед
     * расчётом расстояния его координаты переводятся в мировую
     * систему поворотом группы.
     *
     * @returns {THREE.Vector3} Положение маркера в мировой системе.
     */
    locationMarkerWorldPosition() {
        return this.locationMarker.position.clone()
            .applyQuaternion(this.earthGroup.quaternion);
    }

    /**
     * Подгоняет размер указателя станции под текущее расстояние
     * до камеры.
     *
     * Метка, заданная в единицах сцены, при приближении камеры
     * вырастала бы настолько, что закрывала бы саму станцию, а при
     * отдалении становилась бы неразличимой. Поэтому её радиус
     * пропорционален расстоянию до камеры: на экране метка сохраняет
     * постоянный размер.
     *
     * @param {THREE.Vector3} stationWorldPosition Положение станции
     *   в мировой системе координат.
     */
    updateStationMarkerSize(stationWorldPosition) {
        if (!this.stationMarker || !this.station) {
            return;
        }

        const distanceToCamera =
            this.camera.position.distanceTo(stationWorldPosition);
        const desiredRadius = distanceToCamera * STATION_MARKER_ANGULAR_RATIO;

        // Масштаб узла складывается с масштабом родителя, поэтому
        // здесь указывается отношение к радиусу в масштабе модели.
        this.stationMarker.scale.setScalar(
            desiredRadius / this.stationMarkerBaseRadius,
        );
    }

    /**
     * Возвращает положение станции в мировой системе координат.
     *
     * Положение станции хранится в системе, связанной с поверхностью
     * Земли, поэтому перед передачей камере его необходимо повернуть
     * на угол, на который в данный момент повёрнута планета. Без
     * такого пересчёта камера нацеливалась бы на другую точку сферы.
     *
     * @returns {THREE.Vector3} Положение станции в мировой системе.
     */
    getStationWorldPosition() {
        return this.stationPosition.clone().applyQuaternion(this.earthGroup.quaternion);
    }

    /**
     * Переводит камеру к станции.
     *
     * Камера перемещается плавно: положение и цель взгляда
     * интерполируются в ходе анимации, что воспринимается
     * естественнее мгновенного перехода.
     *
     * Камера встаёт строго над станцией, на продолжении радиус-вектора:
     * камера, станция и центр Земли оказываются на одной прямой, а линия
     * взгляда перпендикулярна поверхности планеты. Поэтому станция всегда
     * остаётся перед камерой и не закрывается диском Земли, даже если
     * до перевода камера находилась по другую сторону планеты.
     *
     * Слежение продолжается и после перехода: станция движется по орбите
     * и вращается вместе с Землёй, поэтому цель каждый кадр вычисляется
     * заново.
     */
    focusOnStation() {
        this.isTrackingStation = true;
        this.focusPoint = null;
        this.focusDistance = STATION_FOCUS_DISTANCE;
        this.removeLocationMarker();
    }

    /**
     * Переводит камеру к произвольной точке поверхности Земли.
     *
     * Используется для показа места запуска: космодром отмечается
     * маркером, а камера встаёт строго над ним — так же, как при
     * переводе к станции, но с меньшего расстояния, поскольку
     * рассматривается участок поверхности, а не аппарат на орбите.
     *
     * @param {number} latitudeDegrees Географическая широта точки.
     * @param {number} longitudeDegrees Географическая долгота точки.
     */
    focusOnLocation(latitudeDegrees, longitudeDegrees) {
        this.isTrackingStation = false;
        this.focusDistance = LOCATION_FOCUS_DISTANCE;

        // Точка задаётся с небольшим смещением наружу, чтобы маркер
        // не утопал в поверхности планеты из-за накопления ошибок
        // округления при отрисовке.
        this.focusPoint = geoToVector3(latitudeDegrees, longitudeDegrees, 1.001);

        this.showLocationMarker(latitudeDegrees, longitudeDegrees);
    }

    /**
     * Показывает маркер в точке на поверхности Земли.
     *
     * @param {number} latitudeDegrees Географическая широта точки.
     * @param {number} longitudeDegrees Географическая долгота точки.
     */
    showLocationMarker(latitudeDegrees, longitudeDegrees) {
        this.removeLocationMarker();

        // Кольцо строится в плоскости, перпендикулярной радиус-вектору
        // точки, то есть как раз по касательной к поверхности сферы.
        const markerGeometry = new THREE.RingGeometry(
            LOCATION_MARKER_INNER_RADIUS,
            LOCATION_MARKER_OUTER_RADIUS,
            48,
        );
        const markerMaterial = new THREE.MeshBasicMaterial({
            color: 0xffb454,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
        });

        this.locationMarker = new THREE.Mesh(markerGeometry, markerMaterial);
        this.locationMarker.renderOrder = 10;
        this.locationMarker.position.copy(
            geoToVector3(latitudeDegrees, longitudeDegrees, 1.004),
        );

        // Маркер масштабируется вместе с остальными объектами группы
        // Земли, поэтому его размер задаётся в единицах модели, а не
        // сцены. Иначе при повороте планеты он менялся бы.
        this.locationMarkerBaseRadius = LOCATION_MARKER_OUTER_RADIUS;

        // Плоскость кольца по умолчанию перпендикулярна оси Z.
        // Поворотом совмещаем её с касательной к сфере в данной точке.
        const surfaceNormal = this.locationMarker.position.clone().normalize();
        this.locationMarker.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 0, 1),
            surfaceNormal,
        );

        this.earthGroup.add(this.locationMarker);
    }

    /**
     * Убирает маркер места запуска, если он был показан.
     */
    removeLocationMarker() {
        if (!this.locationMarker) {
            return;
        }

        this.earthGroup.remove(this.locationMarker);
        this.locationMarker.geometry.dispose();
        this.locationMarker.material.dispose();
        this.locationMarker = null;
    }

    /**
     * Ставит стартовый вид над станцией.
     *
     * Вызывается один раз при первой загрузке страницы, когда положение
     * станции уже известно. Камера встаёт над подспутниковой точкой на
     * большем расстоянии, чем при слежении, чтобы в кадр попали и планета,
     * и станция.
     *
     * Положение сразу выставляется нужным, без перехода: при загрузке
     * страницы анимация перехода неуместна, к моменту просмотра камера
     * уже должна стоять на месте.
     */
    applyDefaultView() {
        if (!DEFAULT_VIEW_FOLLOWS_STATION) {
            return;
        }

        this.isTrackingStation = false;
        this.focusPoint = null;
        this.focusDistance = DEFAULT_VIEW_DISTANCE;

        const worldTarget = this.getStationWorldPosition();
        const cameraPosition = worldTarget.clone().setLength(DEFAULT_VIEW_DISTANCE);

        this.camera.position.copy(cameraPosition);
        this.cameraTarget.copy(worldTarget);
        this.controls.target.copy(this.cameraTarget);
    }

    /**
     * Перемещает камеру к цели по дуге над поверхностью планеты.
     *
     * Обычное движение по прямой не годится: если цель находится на
     * противоположной стороне Земли, отрезок между камерой и целью
     * проходит через планету, и камера на мгновение оказывается внутри.
     * Поэтому здесь отдельно обрабатываются направление и расстояние:
     *
     * * направление поворачивается вокруг оси, проходящей через центр
     *   Земли и перпендикулярную плоскости между текущим и новым
     *   направлениями — это и есть движение по дуге;
     * * расстояние до центра Земли меняется обычным сглаживанием,
     *   оставаясь всё время снаружи планеты.
     *
     * @param {THREE.Vector3} worldTarget Положение цели в мировой системе.
     * @param {number} interpolationFactor Доля перехода за текущий кадр.
     */
    moveCameraAlongSurface(worldTarget, interpolationFactor) {
        const currentDirection = this.camera.position.clone().normalize();
        const targetDirection = worldTarget.clone().normalize();

        if (currentDirection.dot(targetDirection) < 0.999999) {
            // Ось поворота перпендикулярна обеим направлениям, поэтому
            // поворот вокруг неё переводит одно направление в другое по
            // кратчайшей дуге, не проходящую через полюсов планеты.
            const rotationAxis = currentDirection.clone()
                .cross(targetDirection)
                .normalize();

            if (rotationAxis.lengthSq() > 0.5) {
                const currentAngle = currentDirection.angleTo(targetDirection);
                const rotation = new THREE.Quaternion().setFromAxisAngle(
                    rotationAxis, currentAngle * interpolationFactor,
                );

                currentDirection.applyQuaternion(rotation);
            }
        }

        // Расстояние до центра меняется отдельно от направления и не
        // опускается ниже радиуса Земли: камера остаётся снаружи.
        const currentDistance = this.camera.position.length();
        const safeDistance = Math.max(this.focusDistance, 1.05);
        const newDistance = currentDistance
            + (safeDistance - currentDistance) * interpolationFactor;

        this.camera.position.copy(currentDirection.setLength(newDistance));

        // Цель взгляда тоже перемещается по дуге, иначе камера обошла бы
        // планету, а смотрела бы всё равно сквозь неё.
        const targetCurrent = this.cameraTarget.clone().normalize();
        const targetDesired = worldTarget.clone().normalize();

        if (targetCurrent.dot(targetDesired) < 0.999999) {
            const targetAxis = targetCurrent.clone().cross(targetDesired).normalize();
            if (targetAxis.lengthSq() > 0.5) {
                const targetAngle = targetCurrent.angleTo(targetDesired);
                const targetRotation = new THREE.Quaternion().setFromAxisAngle(
                    targetAxis, targetAngle * interpolationFactor,
                );
                targetCurrent.applyQuaternion(targetRotation);
            }
        }

        const targetDistance = worldTarget.length();
        this.cameraTarget.copy(
            targetCurrent.setLength(targetDistance),
        );
    }

    /**
     * Возвращает камеру к обзору всей планеты.
     */
    resetCamera() {
        this.isTrackingStation = false;
        this.focusPoint = null;
        this.focusDistance = STATION_FOCUS_DISTANCE;
        this.removeLocationMarker();
        this.cameraTarget.set(0, 0, 0);
        this.controls.target.copy(this.cameraTarget);
    }

    /**
     * Обновляет положение источника освещения.
     *
     * @param {Date} moment Момент времени, для которого определяется
     *   положение Солнца.
     */
    updateSunPosition(moment) {
        const sunDirection = calculateSunDirection(moment);
        this.sunLight.position.copy(sunDirection).multiplyScalar(50);
    }

    /**
     * Подгоняет размер полотна под размер окна браузера.
     *
     * Без этой подгонки изображение растягивается при изменении
     * размеров окна или при отображении на экране иного разрешения.
     */
    handleResize() {
        const width = this.canvas.clientWidth || window.innerWidth;
        const height = this.canvas.clientHeight || window.innerHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height, false);
    }

    /**
     * Выполняет один кадр анимации.
     *
     * Функция вызывается автоматически средствами three.js на каждом
     * кадре. Здесь выполняется всё, что зависит от времени: вращение
     * Земли, движение станции и обновление освещения.
     */
    animate() {
        const deltaSeconds = this.clock.getDelta();

        // Земля вращается вокруг своей оси. Поскольку сцена вращается
        // вместе с ней, станция, заданная в координатах, связанных
        // с поверхностью, остаётся над той же точкой планеты.
        // Вращение идёт вокруг полярной оси сцены, то есть вокруг Y.
        this.earthGroup.rotation.y += this.earthRotationSpeed * deltaSeconds;

        // Граница между пройденной и прогнозной траекторией движется
        // за текущим временем. Без этого пунктирная часть успевала бы
        // превратиться в сплошную с заметным опозданием.
        if (this.clock.elapsedTime - this.lastTrackSplitTime > TRACK_SPLIT_INTERVAL / 1000) {
            this.lastTrackSplitTime = this.clock.elapsedTime;
            this.updateTrackSplit(Date.now());
        }

        // Положение Солнца меняется медленно, поэтому достаточно
        // обновлять его раз в несколько секунд.
        if (this.clock.elapsedTime - this.lastSunUpdate > 5) {
            this.lastSunUpdate = this.clock.elapsedTime;
            this.updateSunPosition(new Date());
        }

        // Слежение за целью. Целью может быть станция, движущаяся
        // по орбите, либо неподвижная точка поверхности планеты.
        const trackedLocalPoint = this.isTrackingStation
            ? this.stationPosition
            : this.focusPoint;

        if (trackedLocalPoint) {
            // Положение цели пересчитывается каждый кадр: планета
            // вращается, а значит меняется и точка в мировой системе.
            const worldTarget = trackedLocalPoint.clone()
                .applyQuaternion(this.earthGroup.quaternion);

            // Коэффициент интерполяции задаётся степенной функцией от
            // времени кадра, поэтому скорость перехода не зависит
            // от частоты отрисовки.
            const interpolationFactor = (1 - Math.pow(0.001, deltaSeconds)) * 0.5;

            if (CAMERA_FOLLOWS_SURFACE) {
                this.moveCameraAlongSurface(worldTarget, interpolationFactor);
            } else {
                // Камера располагается на том же луче из центра Земли,
                // что и цель, но дальше от центра. Такое построение
                // гарантирует перпендикулярность линии взгляда поверхности.
                const desiredCameraPosition = worldTarget.clone()
                    .setLength(this.focusDistance);

                this.camera.position.lerp(
                    desiredCameraPosition, interpolationFactor,
                );
                this.cameraTarget.lerp(worldTarget, interpolationFactor);
            }

            this.controls.target.copy(this.cameraTarget);
        }

        // Указатель станции подгоняется под расстояние до камеры
        // при любом положении камеры, а не только при слежении.
        this.updateStationMarkerSize(this.getStationWorldPosition());
        this.updateLocationMarkerSize();

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    /**
     * Запускает цикл отрисовки.
     */
    start() {
        this.renderer.setAnimationLoop(this.animate);
    }

}
