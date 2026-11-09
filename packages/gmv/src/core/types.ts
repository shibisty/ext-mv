// Публичные типы ядра gmv. Ядро не зависит от DOM: работает в странице, в Worker и в Node (тесты).

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // [w, x, y, z]

export interface Bounds {
  min: number[];
  max: number[];
}

/** Декодированная текстура: либо RGBA-пиксели, либо ImageBitmap (PNG/JPG через браузер). */
export interface DecodedImage {
  width: number;
  height: number;
  rgba?: Uint8Array;
  bitmap?: ImageBitmap;
  name?: string;
}

/** Источник байтов, который можно открыть как архив (File в браузере, Blob с именем в Node). */
export type BlobFile = Blob & { readonly name: string; readonly webkitRelativePath?: string };

/** «Файл-подобный» объект: обычный File, запись архива или уже декодированная текстура. */
export interface VFile {
  readonly name: string;
  /** Путь внутри архива / папки (нижний регистр, «/»). */
  readonly path?: string;
  readonly archive?: Archive;
  readonly webkitRelativePath?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Если задано — это уже декодированная картинка (например, из TXD). */
  readonly decoded?: DecodedImage;
}

export interface ArchiveEntry {
  path: string;
  size?: number;
}

export interface Archive {
  readonly name: string;
  /** id плагина архива: 'zip', 'bsa', 'folder'… */
  readonly kind: string;
  readonly version: number;
  readonly entries: ArchiveEntry[];
  /** Полный путь -> запись. */
  readonly index: Map<string, ArchiveEntry>;
  /** Путь без расширения -> запись текстуры. */
  readonly byKey: Map<string, ArchiveEntry>;
  /** Имя файла -> запись (для «Папки игры»). */
  readonly byBase?: Map<string, ArchiveEntry>;
  lookup(path: string): ArchiveEntry | null;
  read(entry: ArchiveEntry): Promise<Uint8Array>;
  fileOf(entry: ArchiveEntry): VFile;
  /** Исходный файл записи (только «Папка игры»): чтобы открыть лежащий в папке архив. */
  blobOf?(entry: ArchiveEntry): BlobFile | null;
  /** Текстура по точному пути из модели, даже если её нет в списке (архивы с именами-хешами: Far Cry 2). */
  findTexture?(path: string): ArchiveEntry | null;
}

/** Канал карты: путь/имя файла и номер канала (0 R, 1 G, 2 B, 3 A). */
export interface ChannelRef { map: string; channel: 0 | 1 | 2 | 3; image?: DecodedImage }
/**
 * Поверхность для PBR. Схема metal/rough (glTF, BeamNG, SnowRunner) или spec/gloss (Arma _smdi, MudRunner __s_d):
 * gloss = 1 − roughness, specular — сила блика неметалла.
 */
export interface SurfaceInfo {
  roughness?: ChannelRef;
  gloss?: ChannelRef;
  metallic?: ChannelRef;
  ao?: ChannelRef;
  specular?: ChannelRef;
  roughnessFactor?: number;
  metallicFactor?: number;
  /** Сила блика без карты (0..1; 0.5 ≈ F0 0.04). */
  specularFactor?: number;
  /** Откуда взято (для подписи): «BeamNG», «Arma _smdi»… */
  source?: string;
}

export interface Mesh {
  name: string;
  /** Имя текстуры/материала, как записано в модели. */
  texture: string;
  shader?: string;
  /** Имя материала (assimp/HPL). */
  material?: string;
  vertexCount: number;
  pos: Float32Array;
  nor: Float32Array;
  uv: Float32Array;
  /** 4 индекса костей на вершину (float — для атрибутов WebGL). */
  bone: Float32Array;
  weight: Float32Array;
  indices: Uint16Array | Uint32Array;
  skinned: boolean;
  /** Цвет без текстуры (RenderWare). */
  color?: number[];
  /** Встроенная текстура (Quake MDL, GoldSrc). */
  image?: DecodedImage;
  /** Покадровая вершинная анимация: pos/nor меняются на месте. */
  dynamic?: boolean;
  frames?: { pos: Float32Array[]; nor: Float32Array[] };
  /** Кандидаты путей материалов (Source .vmt). */
  materialPaths?: string[];
  /** Номер подматериала (CryEngine). */
  matId?: number;
  /** Карта нормалей, как она записана в модели или материале (путь/имя); пусто — ищется по имени диффузной. */
  normalMap?: string;
  /** Встроенная карта нормалей. */
  normalImage?: DecodedImage;
  /** PBR-поверхность: шероховатость, металличность, AO, блик (карты и множители). */
  surface?: SurfaceInfo;
  /** Прозрачность по альфе текстуры «вырезанием» (решётки, листва, наклейки) — независимо от общего переключателя. */
  alphaTest?: boolean;
  /** Служебная геометрия (световые плоскости, экраны-рендер-цели): по умолчанию скрыта. */
  defaultHidden?: boolean;
  /** Второй набор UV — координаты в карте освещения (Model.lightmap). */
  uv2?: Float32Array;
  /** Прозрачность по вершинам (0..1): слой ландшафта поверх основы — рисуется после непрозрачных мешей, с наложением. */
  vertexAlpha?: Float32Array;
  /** Запечённое освещение по вершинам: RGB(A) байтами, 128 — без изменений (умножение ×2, как у Black Box). */
  vertexShade?: Uint8Array;
  /**
   * Карта слоёв ландшафта (номер слоя Model.terrainLayers на тексель, по UV меша 0..1): вблизи вместо одной цветовой
   * карты (image) рисуются повторяющиеся текстуры слоёв, подкрашенные ею.
   */
  terrainIndex?: { width: number; height: number; data: Uint8Array };
  /** Отражение и преломление по экрану (вода, преломляющее стекло Source): рисуется после сцены по её снимку. */
  screenFx?: ScreenFx;
}

/** Параметры экранной поверхности: вода (плоское отражение, преломление, туман по глубине) или стекло (преломление). */
export interface ScreenFx {
  kind: 'water' | 'glass';
  /** Плоскость поверхности в координатах модели: n·p = d (для отражения воды). */
  plane?: [number, number, number, number];
  /** Цвет преломления (то, что под водой / за стеклом) и отражения (у стекла — блик окружения $envmaptint), 0..1. */
  refractTint: number[];
  reflectTint?: number[];
  /** Сила искажения по карте нормалей: доля экрана. */
  refract: number;
  reflect?: number;
  /** Туман под водой: цвет 0..1, начало и конец в единицах модели. */
  fog?: { color: number[]; start: number; end: number };
  /** Сдвиг карты нормалей во времени (UV/сек). */
  scroll?: [number, number];
  /** Без поддержки: цвет и непрозрачность полупрозрачного слоя. */
  fallback: { color: number[]; opacity: number };
}

/** Слои поверхности ландшафта: текстуры одного размера и параметры показа. */
export interface TerrainLayers {
  /** Текстуры слоёв (одного размера, степень двойки). */
  images: DecodedImage[];
  /** Период повтора текстуры в единицах модели (по X и Z координат меша). */
  period: number[];
  /** 0..1: насколько слой подкрашивается цветовой картой меша. */
  tint: number[];
  /** Средний цвет текстуры слоя (0..1) — для подкраски. */
  mean: Array<[number, number, number]>;
  /** Дальность, на которой слои переходят в цветовую карту. */
  fade: number;
  /** Нормали слоёв (тот же размер, что images): RG — XY касательной нормали (DirectX), A — AO. */
  normals?: DecodedImage[];
  /** Средний масштаб: текстуры изменчивости (свой размер), период, сила, средний цвет. */
  middle?: DecodedImage[];
  midPeriod?: number[];
  midBlend?: number[];
  midMean?: Array<[number, number, number]>;
  /** Имена (для сведений). */
  names?: string[];
}

/** Запечённое освещение уровня (одна карта на модель): яркость в R, UV — Mesh.uv2. */
export interface Lightmap {
  width: number;
  height: number;
  /** Яркость, 1 байт на пиксель (или RGB, 3 байта, при rgb). */
  data: Uint8Array;
  /** Цветная карта (Source): RGB8. */
  rgb?: boolean;
  /** Множитель яркости при показе. */
  scale?: number;
  /**
   * Карты освещения по трём направлениям базиса рельефа Source (bump lightmaps), тот же формат и раскладка, что data:
   * свет смешивается по нормали из карты нормалей. У граней без рельефа — копия data.
   */
  bump?: [Uint8Array, Uint8Array, Uint8Array];
}

/** Ключи анимации assimp-стиля: [время, значение]. */
export type Keys<T> = Array<[number, T]>;
export interface NodeChannel {
  pos: Keys<number[]> | null;
  rot: Keys<number[]> | null;
  scl: Keys<number[]> | null;
  /** Аддитивная дорожка как смещение (перенос + поворот [w,x,y,z]) — применяется так, когда анимация — слой поверх другой. */
  add?: { pos: Keys<number[]> | null; rot: Keys<number[]> | null };
}

/** Слой поверх основной анимации узлов: аддитивные каналы складываются, остальные заменяют позу (в пределах маски). */
export interface NodeLayer {
  motion: NodeMotion;
  /** Постоянный кадр слоя (поза прицеливания — средний кадр сетки направлений); нет — играет по времени. */
  frame?: number;
  /** Номера узлов, которые слой может менять; нет — все. */
  mask?: ReadonlySet<number>;
  /** Только дополнять: узлы, у которых есть канал в основной анимации, слой не трогает (хват оружия у NPC — свой). */
  fill?: boolean;
  /**
   * Слой — сетка поз (кадр = строка·cols + столбец), например направления прицела: x — столбец, y — строка
   * (дробные: смешиваются 4 соседних кадра). Перекрывает frame.
   */
  grid?: { cols: number; rows: number; x: number; y: number };
}

interface MotionBase {
  name: string;
  /** Длительность, сек. */
  duration: number;
  /** Число кадров (для подписи в списке). */
  frames?: number;
  /** Откуда анимация: 'model' или имя файла. */
  source?: string;
  /** Анимация из длинного списка (Metro: тысячи файлов): данные читаются при выборе. */
  load?(): Promise<Motion>;
}
/** Анимация узлов (assimp, NIF, MD5, PSA, Cast, GoldSrc). */
export interface NodeMotion extends MotionBase {
  kind: 'node';
  tps: number;
  chan: Map<number, NodeChannel>;
  /** Слои поверх (прицеливание, дыхание). */
  layers?: NodeLayer[];
  /** Анимации, которые можно положить слоем (для выбора в интерфейсе; могут загружаться при выборе). */
  layerPool?: NodeMotion[];
  /** Имена из layerPool, подобранные слоем по умолчанию. */
  layerAuto?: string[];
  /**
   * Смешивание анимаций по параметрам (последовательности Source: направление движения): сетка cols×rows анимаций
   * (индекс — строка·cols + столбец), x/y — дробное положение; фаза общая — анимации разной длины идут в такт.
   */
  blend?: NodeBlend;
  /** Как класть эту анимацию слоем (кадр, маска) — задаёт движок. */
  asLayer?: (m: NodeMotion) => Omit<NodeLayer, 'motion'>;
}
export interface NodeBlend {
  motions: NodeMotion[];
  cols: number;
  rows: number;
  x: number;
  y: number;
  /** Параметры по осям (для подписи ползунка): имя и значения на краях сетки. */
  params?: Array<{ name: string; start: number; end: number }>;
}
/** Анимация X-Ray (OGF/OMF): квантованные кватернионы + позиции по кадрам. */
export interface XrayTrack {
  rot: Int16Array;
  trans: Float32Array;
  constT?: boolean;
}
export interface XrayMotion extends MotionBase {
  kind: 'xray';
  frames: number;
  /** Треки по номеру кости модели; пропуск — кость не анимируется (остаётся в bind-позе). */
  tracks: XrayTrack[];
  /** Часть тела (ноги, торс, голова) или «эффект», если анимация управляет не всем скелетом. */
  part?: string;
  /** Анимации других частей тела, играющие одновременно (ноги + торс): кости без своего трека берутся из них. */
  layers?: XrayMotion[];
}
/** Покадровая вершинная анимация (MD2/MD3/MDL). */
export interface VertexMotion extends MotionBase {
  kind: 'vertex';
  start: number;
  count: number;
  fps: number;
}
export type Motion = NodeMotion | XrayMotion | VertexMotion;

/** Скелет, который умеет считать позу. Матрицы — column-major Float32, 16 на кость. */
export interface SkeletonRuntime {
  readonly n: number;
  readonly parent: number[];
  readonly skin: Float32Array;
  readonly worldV: Float32Array[];
  readonly skinV: Float32Array[];
  pose(motion: Motion | null, time: number, loop: boolean, invert?: boolean): void;
}

/** Сцена из повторяющихся моделей (объекты уровня): для экспорта ссылками вместо слитой геометрии. */
export interface InstancedScene {
  /** Номера мешей модели, собранных из экземпляров (при экспорте заменяются ссылками). */
  meshes: number[];
  /** Прототипы: части с номером меша модели, по которому берутся текстура и материал. */
  protos: Array<{ name: string; parts: Array<{ mesh: number; pos: Float32Array; nor: Float32Array; uv: Float32Array; indices: Uint32Array }> }>;
  /** Поза — матрица 4×4 по строкам (вектор-строка × M, перенос в последней строке), в координатах модели. */
  placements: InstancePlacement[];
}

/** Где лежит часть экземпляра в слитом меше: номер меша, вершины и индексы. */
export interface PlacementRange { mesh: number; part: number; vStart: number; vCount: number; iStart: number; iCount: number }

export interface InstancePlacement {
  proto: number;
  name: string;
  pose: number[];
  /** Группа в слоях сцены (класс объекта: STATICPROP, O_ENTITY…). */
  group?: string;
  /** Скрыт пользователем: не рисуется и не выгружается. */
  hidden?: boolean;
  /** Части в слитых мешах (для скрытия, подсветки, выбора и поворота). */
  ranges?: PlacementRange[];
}

/** Выбор для пересборки модели: id, подпись, варианты и текущее значение. */
export interface ModelOption { id: string; label: string; values: Array<{ id: string; label: string }>; value: string }

export interface Model {
  meshes: Mesh[];
  /** Экземпляры моделей внутри сцены (Metro level.bin). */
  instances?: InstancedScene;
  /** Карта освещения уровня (Metro level.lmap_pc). */
  lightmap?: Lightmap;
  /** Слои поверхности ландшафта (Mesh.terrainIndex). */
  terrainLayers?: TerrainLayers;
  skeleton: SkeletonRuntime | null;
  motions: Motion[];
  bounds: Bounds;
  /** Левосторонняя система (X-Ray): отразить Z при показе. */
  flipZ?: boolean;
  defaultZUp?: boolean;
  cameraYaw?: number;
  /** Строки для панели «Сведения». */
  info: string[];
  /** Вершинная анимация: обновить pos/nor мешей на время t. */
  animate?(motion: Motion | null, t: number, loop: boolean): void;
  /** Подбор знака кватернионов для анимации. */
  detectInvert?(motion: Motion): boolean;
  /** Загрузка внешних анимаций (.omf/.psa/.md5anim/.cast). */
  loadMotions?(file: VFile): Promise<Motion[]>;
  /** Произвольные данные для резолверов текстур (имя .mtl и т. п.). */
  meta?: Record<string, unknown>;
  /**
   * Настройки вида, которые формат умеет пересобрать (диски, винил, цвет окраски NFS World): список выборов с текущим
   * значением. Смена значения — повторная загрузка с LoadContext.options (камера сохраняется).
   */
  options?: ModelOption[];
  /** Направление зелёного канала карт нормалей игры: 'dx' (Y вниз, Direct3D — по умолчанию) или 'gl' (Y вверх). */
  normalY?: 'gl' | 'dx';
}

/** Ошибка «файл содержит только анимацию» — сессия попробует добавить его как анимацию. */
export class MotionOnlyError extends Error {
  readonly motionOnly = true;
}
