// Интерфейс расширения: движок = набор плагинов форматов, архивов, кодеков текстур и пресетов игр.
import type { Archive, BlobFile, DecodedImage, Mesh, Model, Motion, VFile } from './types';
import type { TextureLibrary, TextureSource } from './textures';

/** Степень готовности (для значка в интерфейсе). */
export type SupportStatus = 'stable' | 'beta' | 'bridge';

export interface LoadContext {
  /** Все файлы, выбранные вместе с основным (.mtl, .bin, .vvd…). */
  readonly files: readonly VFile[];
  /** Открытые архивы и папки. */
  readonly archives: readonly Archive[];
  /** Найти соседний файл: среди выбранных, затем в той же папке архива. */
  sibling(name: string): Promise<ArrayBuffer | null>;
  /** Прочитать файл архива по полному пути (первый найденный). */
  readPath(path: string): Promise<Uint8Array | null>;
}

export interface AfterLoadContext {
  readonly main: VFile;
  readonly model: Model;
  readonly textures: TextureLibrary;
  addMotions(list: Motion[], source: string): void;
  addTextureDictionary(file: VFile): Promise<void>;
}

export interface FormatPlugin {
  /** Уникальный id: '<движок>-<формат>', например 'xray-ogf'. */
  id: string;
  title: string;
  engine: string;
  /** Расширения без точки, нижний регистр. */
  extensions: string[];
  /** Файлы без расширения, которые открывает формат (по пути в архиве/папке), например «media/meshcache/…». */
  pathPattern?: RegExp;
  /** Расширения внешних анимаций, которые принимает модель этого формата. */
  motionExtensions?: string[];
  status?: SupportStatus;
  /**
   * Уверенность 0..1 по первым 256 байтам файла. 0 — точно не этот формат.
   * Не задано — формат определяется только по расширению.
   */
  sniff?(head: Uint8Array, name: string): number;
  load(main: VFile, ctx: LoadContext): Promise<Model>;
  /** Поиск текстуры меша по правилам движка (материалы .vmt/.mtr/.mtl…). */
  resolveTexture?(mesh: Mesh, model: Model, lib: TextureLibrary): Promise<TextureSource | null>;
  /**
   * Карты меша по правилам движка, если они не лежат отдельными файлами нормалей/PBR (Metro: «_bump» — высота и блик,
   * нормали считаются из высоты). Возвращает готовые картинки.
   */
  resolveMaps?(mesh: Mesh, model: Model, lib: TextureLibrary): Promise<EngineMaps | null>;
  /** Подгрузка сопутствующих файлов после загрузки (одноимённый .txd, анимации из папки…). */
  afterLoad?(ctx: AfterLoadContext): Promise<void>;
}

/** Карты, собранные движком: нормали (касательное пространство, Y как в DirectX) и PBR-поверхность (R AO, G шероховатость, B металл, A блик). */
export interface EngineMaps {
  normal?: { image: DecodedImage; packing?: 'rgb' | 'rg' | 'ag'; label?: string };
  surface?: { image: DecodedImage; label?: string };
}

export interface ArchivePlugin {
  id: string;
  title: string;
  engine: string;
  extensions: string[];
  /** Расширения файлов-спутников (.dir для IMG, части VPK), которые не открываются сами по себе. */
  companionExtensions?: string[];
  /** Открывать такие архивы автоматически, когда выбрана «Папка игры» (F.E.A.R. Online: десятки *.arch01 рядом с Game/). */
  openFromFolder?: boolean;
  sniff?(head: Uint8Array, name: string): number;
  /** null — файл является частью другого архива (например, *_001.vpk) и пропускается. */
  open(file: BlobFile, siblings: readonly BlobFile[]): Promise<Archive | null>;
}

/**
 * Поиск текстуры по имени материала через файлы материалов движка (.mtr, .mat…), независимо от формата модели.
 * Срабатывает, когда собственный поиск формата ничего не нашёл: например, .lwo/.ase из Doom 3 через assimp + .mtr из pk4.
 */
export interface MaterialResolver {
  id: string;
  resolve(mesh: Mesh, lib: TextureLibrary): Promise<TextureSource | null>;
}

export interface ImageCodec {
  id: string;
  extensions: string[];
  decode(buf: ArrayBuffer, name: string): DecodedImage | Promise<DecodedImage>;
}

export interface TextureDictionaryResult {
  textures: Array<DecodedImage & { name: string }>;
  errors: string[];
}
/** Файл-словарь текстур (RenderWare .txd). */
export interface TextureDictionaryPlugin {
  id: string;
  extensions: string[];
  parse(buf: ArrayBuffer): TextureDictionaryResult | Promise<TextureDictionaryResult>;
}

/** Настройки интерфейса для пресета игры. */
export interface PresetUi {
  /** Показать кнопку «Открыть архив…». */
  archives?: boolean;
  archiveExts?: string[];
  archiveLabel?: string;
  /** Кнопка внешней анимации. */
  motionLabel?: string;
  /** Внешняя анимация имеет то же расширение, что и модель (.cast). */
  motionAny?: boolean;
  /** Переключатель «Z вверх». */
  zUp?: boolean;
  /** Переключатель «инвертировать вращение». */
  invertQuat?: boolean;
}

export interface GamePreset {
  id: string;
  /** Группа в списке: «Игры», «Форматы (assimp)»… */
  group: string;
  title: string;
  engine: string;
  /** id форматов, которые открывает пресет. */
  formats: string[];
  /** Ограничить расширения моделей (по умолчанию — все расширения форматов). */
  extensions?: string[];
  hint?: string;
  status?: SupportStatus;
  ui?: PresetUi;
  /** Файлы-маркеры игры для автоопределения по папке. */
  markers?: string[];
}

/** Поле настроек экспорта (рисуется в окне экспорта). */
export interface ExportField {
  id: string;
  label: string;
  type: 'text' | 'number' | 'checkbox' | 'select';
  /** Значение по умолчанию; функция — по модели и имени файла. */
  default?: string | number | boolean | ((model: Model, baseName: string) => string | number | boolean);
  placeholder?: string;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  step?: number;
  /** Показывать поле только для таких моделей (например, «объекты ссылками» — у сцен с экземплярами). */
  when?(model: Model): boolean;
}
export type ExportValues = Record<string, string | number | boolean>;

/** Текстура меша для писателя: исходный DDS (копируется как есть) или декодированная картинка. */
export interface ExportTexture { name: string; dds?: Uint8Array; image?: DecodedImage | null }

export interface ExportContext {
  /** Пресет и движок, из которых открыта модель. */
  preset: GamePreset;
  sourceEngine: string;
  /** Имя исходного файла без расширения. */
  baseName: string;
  /** Скрытые пользователем меши. */
  hidden: ReadonlySet<number>;
  texture(meshIndex: number): Promise<ExportTexture | null>;
}
export interface ExportResult {
  files: Map<string, Uint8Array>;
  report: string[];
  /** Имя архива для скачивания (без .zip). */
  name: string;
}

/** Куда можно выгрузить загруженную модель: целевой движок/формат и его настройки. */
export interface ExporterPlugin {
  id: string;
  /** Короткое название («X-Ray SDK 0.7 (ЗП)»). */
  title: string;
  /** Что получится и как этим пользоваться. */
  description: string;
  /** Целевой движок (id) или формат («obj»). */
  target: string;
  /**
   * Движки-источники, для которых выгрузка предназначена; не задано — подходит любая модель.
   * Совпадение с движком открытой модели поднимает вариант в начало списка.
   */
  from?: string[];
  /** Только из перечисленных движков (иначе вариант не показывается). */
  onlyFrom?: boolean;
  fields: ExportField[];
  accepts?(model: Model): boolean;
  run(model: Model, values: ExportValues, ctx: ExportContext): Promise<ExportResult>;
}

export interface EnginePlugin {
  id: string;
  title: string;
  formats?: FormatPlugin[];
  /** Выгрузка в формат этого движка. */
  exporters?: ExporterPlugin[];
  archives?: ArchivePlugin[];
  codecs?: ImageCodec[];
  dictionaries?: TextureDictionaryPlugin[];
  materials?: MaterialResolver[];
  games?: GamePreset[];
  /** Направление зелёного канала карт нормалей движка: 'gl' (Y вверх: id Tech, OpenGL-игры) или 'dx' (по умолчанию). */
  normalY?: 'gl' | 'dx';
}

/** Помощник для объявления движка с проверкой типов. */
export const defineEngine = (e: EnginePlugin): EnginePlugin => e;
