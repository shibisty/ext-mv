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
}

/** Ключи анимации assimp-стиля: [время, значение]. */
export type Keys<T> = Array<[number, T]>;
export interface NodeChannel {
  pos: Keys<number[]> | null;
  rot: Keys<number[]> | null;
  scl: Keys<number[]> | null;
}

interface MotionBase {
  name: string;
  /** Длительность, сек. */
  duration: number;
  /** Число кадров (для подписи в списке). */
  frames?: number;
  /** Откуда анимация: 'model' или имя файла. */
  source?: string;
}
/** Анимация узлов (assimp, NIF, MD5, PSA, Cast, GoldSrc). */
export interface NodeMotion extends MotionBase {
  kind: 'node';
  tps: number;
  chan: Map<number, NodeChannel>;
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

export interface Model {
  meshes: Mesh[];
  /** Экземпляры моделей внутри сцены (Metro level.bin). */
  instances?: InstancedScene;
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
  /** Направление зелёного канала карт нормалей игры: 'dx' (Y вниз, Direct3D — по умолчанию) или 'gl' (Y вверх). */
  normalY?: 'gl' | 'dx';
}

/** Ошибка «файл содержит только анимацию» — сессия попробует добавить его как анимацию. */
export class MotionOnlyError extends Error {
  readonly motionOnly = true;
}
