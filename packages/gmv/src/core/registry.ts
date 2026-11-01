// Реестр плагинов: движки -> форматы, архивы, кодеки, словари текстур, пресеты игр. Автоопределение формата.
import { extOf, readHead } from './binary';
import type { ArchivePlugin, EnginePlugin, ExporterPlugin, FormatPlugin, GamePreset, ImageCodec, MaterialResolver, TextureDictionaryPlugin } from './plugin';
import type { BlobFile, DecodedImage, Model, VFile } from './types';
import type { ImageDecoder } from './textures';

export interface Detection {
  format: FormatPlugin;
  /** 0..1 */
  confidence: number;
  /** Все кандидаты по убыванию уверенности (для выбора из 2–3 вариантов). */
  candidates: Array<{ format: FormatPlugin; confidence: number }>;
}

export class Registry implements ImageDecoder {
  readonly engines: EnginePlugin[] = [];
  readonly formats: FormatPlugin[] = [];
  readonly archives: ArchivePlugin[] = [];
  readonly codecs: ImageCodec[] = [];
  readonly dictionaries: TextureDictionaryPlugin[] = [];
  readonly games: GamePreset[] = [];
  readonly materials: MaterialResolver[] = [];
  readonly exporters: ExporterPlugin[] = [];

  constructor(engines: readonly EnginePlugin[] = []) {
    for (const e of engines) this.use(e);
  }

  /** Подключить движок. Повторное подключение с тем же id заменяет плагины. */
  use(engine: EnginePlugin): this {
    const old = this.engines.findIndex((e) => e.id === engine.id);
    if (old >= 0) this.remove(engine.id);
    this.engines.push(engine);
    const add = <T extends { id: string }>(list: T[], items: readonly T[] | undefined, kind: string) => {
      for (const it of items ?? []) {
        if (list.some((x) => x.id === it.id)) throw new Error(`gmv: ${kind} с id «${it.id}» уже зарегистрирован`);
        list.push(it);
      }
    };
    add(this.formats, engine.formats, 'формат');
    add(this.archives, engine.archives, 'архив');
    add(this.codecs, engine.codecs, 'кодек');
    add(this.dictionaries, engine.dictionaries, 'словарь');
    add(this.games, engine.games, 'пресет');
    add(this.materials, engine.materials, 'материалы');
    add(this.exporters, engine.exporters, 'экспорт');
    return this;
  }

  remove(engineId: string): void {
    const i = this.engines.findIndex((e) => e.id === engineId);
    if (i < 0) return;
    const e = this.engines[i]!;
    this.engines.splice(i, 1);
    const drop = <T>(list: T[], items: readonly T[] | undefined) => {
      for (const it of items ?? []) { const k = list.indexOf(it); if (k >= 0) list.splice(k, 1); }
    };
    drop(this.formats, e.formats);
    drop(this.archives, e.archives);
    drop(this.codecs, e.codecs);
    drop(this.dictionaries, e.dictionaries);
    drop(this.games, e.games);
    drop(this.materials, e.materials);
    drop(this.exporters, e.exporters);
  }

  /** Варианты выгрузки модели, открытой из движка sourceEngine: сначала предназначенные для него, затем общие. */
  exportersFor(model: Model, sourceEngine: string): Array<{ exporter: ExporterPlugin; recommended: boolean }> {
    return this.exporters
      .filter((x) => (!x.onlyFrom || x.from?.includes(sourceEngine)) && (!x.accepts || x.accepts(model)))
      .map((exporter) => ({ exporter, recommended: !!exporter.from?.includes(sourceEngine) }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended));
  }

  format(id: string): FormatPlugin | undefined { return this.formats.find((f) => f.id === id); }
  game(id: string): GamePreset | undefined { return this.games.find((g) => g.id === id); }
  engine(id: string): EnginePlugin | undefined { return this.engines.find((e) => e.id === id); }

  /** Расширения моделей пресета. */
  presetExtensions(p: GamePreset): string[] {
    if (p.extensions) return p.extensions;
    return [...new Set(p.formats.flatMap((id) => this.format(id)?.extensions ?? []))];
  }
  /** Расширения внешних анимаций пресета. */
  presetMotionExtensions(p: GamePreset): string[] {
    return [...new Set(p.formats.flatMap((id) => this.format(id)?.motionExtensions ?? []))];
  }
  /** Первый пресет, открывающий формат. */
  presetForFormat(formatId: string, fileName?: string): GamePreset | undefined {
    const ext = fileName ? extOf(fileName) : '';
    return (ext && this.games.find((g) => g.formats.includes(formatId) && this.presetExtensions(g).includes(ext))) || this.games.find((g) => g.formats.includes(formatId));
  }
  /** Расширения, которые бывают только у внешних анимаций (.omf, .psa, .md5anim), а не у моделей. */
  get motionOnlyExtensions(): string[] {
    const models = new Set(this.formats.flatMap((f) => f.extensions));
    return [...new Set(this.formats.flatMap((f) => f.motionExtensions ?? []))].filter((e) => !models.has(e));
  }
  get modelExtensions(): string[] {
    return [...new Set(this.formats.flatMap((f) => [...f.extensions, ...(f.motionExtensions ?? [])]))];
  }

  /** Модель по шаблону пути (MeshCache без расширения, classes/trucks/*.xml); formats — ограничить форматами пресета. */
  isPathModel(path: string, formats?: readonly string[]): boolean {
    return this.formats.some((f) => f.pathPattern?.test(path) && (!formats || formats.includes(f.id)));
  }

  archiveExtensions(): string[] {
    return [...new Set(this.archives.flatMap((a) => [...a.extensions, ...(a.companionExtensions ?? [])]))];
  }
  isArchive(name: string): boolean { return this.archiveExtensions().includes(extOf(name)); }
  dictionaryFor(name: string): TextureDictionaryPlugin | undefined {
    const ext = extOf(name);
    return this.dictionaries.find((d) => d.extensions.includes(ext));
  }
  codecFor(name: string): ImageCodec | undefined {
    const ext = extOf(name);
    return this.codecs.find((c) => c.extensions.includes(ext));
  }
  /** Картинка ли это (по расширению): кодеки плагинов + форматы браузера. */
  isImage(name: string): boolean {
    return !!this.codecFor(name) || /\.(png|jpe?g|bmp|webp|gif)$/i.test(name);
  }

  /** Плагин архива для файла: по расширению, при неоднозначности — по сигнатуре. */
  async archiveFor(file: BlobFile): Promise<ArchivePlugin | null> {
    const ext = extOf(file.name), cands = this.archives.filter((a) => a.extensions.includes(ext));
    if (cands.length <= 1) return cands[0] ?? null;
    const head = await readHead(file, 64);
    let best: ArchivePlugin | null = null, score = -1;
    for (const a of cands) {
      const s = a.sniff ? a.sniff(head, file.name) : 0.1;
      if (s > score) { score = s; best = a; }
    }
    // сигнатура не узнана: ZIP читается с конца файла (каталог), поэтому он — запасной вариант, как в v11
    return score > 0 ? best : cands.find((a) => a.id === 'zip') ?? null;
  }

  /**
   * Определить формат модели: кандидаты по расширению, уточнение по сигнатуре,
   * бонус форматам предпочитаемого пресета. Без расширения — перебор всех сигнатур.
   */
  async detect(file: VFile | BlobFile, prefer: readonly string[] = []): Promise<Detection | null> {
    const ext = extOf(file.name);
    let cands = this.formats.filter((f) => f.extensions.includes(ext));
    const byMagicOnly = !cands.length;
    if (byMagicOnly) cands = this.formats.filter((f) => f.sniff);
    if (!cands.length) return null;
    // сигнатуру проверяем всегда, когда кандидат её умеет: иначе текстовый Doom 3 .skin уходит в CryEngine .skin
    const needHead = byMagicOnly || cands.some((c) => c.sniff);
    const head = needHead ? await readHead(file, 256) : null;
    const scored = cands
      .map((format) => {
        let c = byMagicOnly ? 0 : 0.5;
        if (head && format.sniff) {
          const s = format.sniff(head, file.name);
          if (s <= 0) return { format, confidence: 0 };
          c += (byMagicOnly ? 1 : 0.5) * s;
        }
        if (prefer.includes(format.id)) c += 0.25;
        return { format, confidence: Math.min(1, c) };
      })
      .filter((x) => x.confidence > (byMagicOnly ? 0.6 : 0))
      .sort((a, b) => b.confidence - a.confidence);
    if (!scored.length) return null;
    return { format: scored[0]!.format, confidence: scored[0]!.confidence, candidates: scored };
  }

  /** Декодировать картинку: кодеки плагинов, затем createImageBitmap браузера. */
  async decodeImage(file: VFile): Promise<DecodedImage> {
    if (file.decoded) return file.decoded;
    const buf = await file.arrayBuffer(), codec = this.codecFor(file.name);
    if (codec) return codec.decode(buf, file.name);
    if (typeof createImageBitmap !== 'function') throw new Error(`нет декодера для ${file.name}`);
    const bitmap = await createImageBitmap(new Blob([buf]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    return { bitmap, width: bitmap.width, height: bitmap.height };
  }
}
