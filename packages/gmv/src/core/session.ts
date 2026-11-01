// Сессия просмотра без DOM: выбранный пресет, архивы, текстуры, модель и анимации.
// Интерфейс (расширение, страница, другое приложение) подписывается на события и рисует результат.
import { tr } from './i18n';
import { baseName, extOf, toArrayBuffer } from './binary';
import { analyzeNormalMap, normalCandidates, type NormalPacking } from './normals';
import { composeSurface, surfaceCandidates, surfaceMaps } from './surface';
import { openFolder } from './archives/folder';
import type { AfterLoadContext, EngineMaps, FormatPlugin, GamePreset, LoadContext } from './plugin';
import type { Registry } from './registry';
import { TextureLibrary, type TextureSource } from './textures';
import { MotionOnlyError, type Archive, type ArchiveEntry, type BlobFile, type DecodedImage, type Mesh, type Model, type Motion, type VFile } from './types';

export interface SessionEvents {
  status: { text: string; error: boolean };
  preset: GamePreset;
  model: { model: Model; main: VFile; format: FormatPlugin };
  motions: Motion[];
  archives: Archive[];
  /** Набор доступных текстур изменился — стоит заново применить текстуры. */
  textures: void;
}
type Listener<T> = (payload: T) => void;

export interface TextureResult {
  meshIndex: number;
  image: DecodedImage | null;
  /** Подпись для списка мешей: «512×512», «нет файла», «ошибка: …». */
  label: string;
  ok: boolean;
  /** Путь найденного файла (для поиска карты нормалей рядом). */
  source?: string;
}

export interface SurfaceResult {
  meshIndex: number;
  /** Сведённая карта: R — AO, G — шероховатость, B — металличность, A — блик. */
  image: DecodedImage | null;
  label: string;
  ok: boolean;
}

export interface NormalResult {
  meshIndex: number;
  image: DecodedImage | null;
  packing: NormalPacking;
  label: string;
  ok: boolean;
}

export interface ArchiveItem { archive: Archive; entry: ArchiveEntry }

const MAX_SAME_DIR_MOTIONS = 80;

export class ViewerSession {
  readonly archives: Archive[] = [];
  readonly textures: TextureLibrary;
  preset: GamePreset;
  model: Model | null = null;
  format: FormatPlugin | null = null;
  main: VFile | null = null;
  readonly motions: Motion[] = [];
  /** Последняя неудачная загрузка (для кнопки «Скопировать диагностику»). */
  lastFailure: { file: VFile; format: string; error: string } | null = null;
  private readonly overrides = new Map<number, TextureSource>();
  /** Карты движка (resolveMaps) по имени текстуры меша. */
  private readonly mapsCache = new Map<string, Promise<EngineMaps | null>>();
  private engineMaps(mesh: Mesh): Promise<EngineMaps | null> {
    const fmt = this.format, model = this.model;
    if (!fmt?.resolveMaps || !model) return Promise.resolve(null);
    const key = `${mesh.texture}|${mesh.shader ?? ''}`;
    let p = this.mapsCache.get(key);
    if (!p) { p = fmt.resolveMaps(mesh, model, this.textures).catch((e) => { console.warn(e); return null; }); this.mapsCache.set(key, p); }
    return p;
  }
  private readonly listeners = new Map<keyof SessionEvents, Set<Listener<never>>>();

  constructor(readonly registry: Registry, presetId?: string | null) {
    if (!registry.games.length) throw new Error('gmv: в реестре нет ни одного пресета');
    this.preset = (presetId && registry.game(presetId)) || registry.games[0]!;
    this.textures = new TextureLibrary(registry, this.archives);
  }

  // ---------- события ----------
  on<K extends keyof SessionEvents>(type: K, fn: Listener<SessionEvents[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => set!.delete(fn as Listener<never>);
  }
  private emit<K extends keyof SessionEvents>(type: K, payload: SessionEvents[K]): void {
    for (const fn of this.listeners.get(type) ?? []) (fn as Listener<SessionEvents[K]>)(payload);
  }
  private status(text: string, error = false): void { this.emit('status', { text, error }); }

  // ---------- пресет ----------
  setPreset(id: string): GamePreset {
    const p = this.registry.game(id) ?? this.registry.games[0]!;
    this.preset = p;
    this.emit('preset', p);
    return p;
  }
  get modelExtensions(): string[] { return this.registry.presetExtensions(this.preset); }
  get motionExtensions(): string[] {
    const m = this.registry.presetMotionExtensions(this.preset);
    return this.preset.ui?.motionAny ? [...new Set([...m, ...this.modelExtensions])] : m;
  }

  // ---------- приём файлов ----------
  /** Разложить набор файлов: архивы, словари текстур, картинки, анимации, модель. */
  async addFiles(input: Iterable<BlobFile>): Promise<void> {
    const files = Array.from(input), reg = this.registry;
    const motionExts = this.registry.motionOnlyExtensions;
    const arc = files.filter((f) => reg.isArchive(f.name));
    const dict = files.filter((f) => !reg.isArchive(f.name) && reg.dictionaryFor(f.name));
    const img = files.filter((f) => !reg.isArchive(f.name) && reg.isImage(f.name));
    const mot = files.filter((f) => motionExts.includes(extOf(f.name)));
    const rest = files.filter((f) => !arc.includes(f) && !dict.includes(f) && !img.includes(f) && !mot.includes(f));
    if (arc.length) await this.addArchives(arc);
    for (const f of dict) await this.addTextureDictionary(f);
    if (img.length) this.addTextures(img);
    if (rest.length) await this.loadModel(rest);
    for (const f of mot) await this.loadMotions(f);
  }

  async addArchives(files: readonly BlobFile[]): Promise<void> {
    for (const f of files) {
      try {
        const plugin = await this.registry.archiveFor(f);
        if (!plugin) continue; // спутник (.dir) или неизвестный формат
        this.status(tr('session.readingArchive', { name: f.name }));
        const a = await plugin.open(f, files);
        if (a) this.archives.push(a);
      } catch (e) {
        console.error(e);
        this.status(tr('session.archiveError', { error: errMsg(e) }), true);
        return;
      }
    }
    this.archivesChanged(tr('session.archives', { n: this.archives.length }));
  }

  /** «Папка игры»: индексирует файлы без чтения. */
  addFolder(files: readonly BlobFile[]): Archive {
    const a = openFolder(files);
    this.archives.push(a);
    this.archivesChanged(tr('session.folder', { name: a.name, n: a.entries.length }));
    return a;
  }

  private archivesChanged(msg: string): void {
    this.textures.invalidate();
    this.status(msg);
    this.emit('archives', this.archives);
    this.emit('textures', undefined);
  }

  addTextures(files: readonly BlobFile[]): void {
    this.textures.addFiles(files.filter((f) => this.registry.isImage(f.name)));
    this.emit('textures', undefined);
  }

  async addTextureDictionary(file: VFile | BlobFile): Promise<void> {
    const plugin = this.registry.dictionaryFor(file.name);
    if (!plugin) return;
    try {
      const { textures, errors } = await plugin.parse(await file.arrayBuffer());
      for (const t of textures) this.textures.addDecoded(t.name, t, plugin.id);
      this.status(
        tr('session.dict', { id: plugin.id.toUpperCase(), name: file.name, n: textures.length }) + (errors.length ? tr('session.dictErrors', { n: errors.length, first: errors[0]! }) : ''),
        errors.length > 0 && !textures.length,
      );
      this.emit('textures', undefined);
    } catch (e) {
      console.error(e);
      this.status(tr('session.dictError', { id: plugin.id.toUpperCase(), error: errMsg(e) }), true);
    }
  }

  // ---------- модель ----------
  /** Выбрать основной файл (автоопределение) и загрузить модель. */
  async loadModel(files: ReadonlyArray<VFile | BlobFile>): Promise<Model | null> {
    let main: VFile | null = null, format: FormatPlugin | null = null, fallback: { file: VFile; format: FormatPlugin } | null = null;
    for (const f of files) {
      const d = await this.registry.detect(f, this.preset.formats);
      if (!d) continue;
      if (this.preset.formats.includes(d.format.id)) { main = f; format = d.format; break; }
      if (!fallback) fallback = { file: f, format: d.format };
    }
    if (!main && fallback) {
      main = fallback.file; format = fallback.format;
      const p = this.registry.presetForFormat(format.id, main.name);
      if (p) this.setPreset(p.id);
    }
    if (!main || !format) { this.status(tr('session.noModel'), true); return null; }
    this.status(tr('session.loading'));
    try {
      const model = await format.load(main, this.loadContext(files, main));
      model.normalY ??= this.registry.engine(format.engine)?.normalY ?? 'dx';
      this.model = model; this.format = format; this.main = main; this.lastFailure = null;
      this.overrides.clear();
      this.mapsCache.clear();
      this.motions.length = 0;
      this.motions.push(...model.motions.map((m) => ({ ...m, source: 'model' })));
      this.emit('model', { model, main, format });
      if (format.afterLoad) await format.afterLoad(this.afterLoadContext(main, model));
      this.emit('motions', this.motions);
      this.status(tr('session.loaded', { name: main.name }));
      return model;
    } catch (e) {
      if (e instanceof MotionOnlyError && this.model?.loadMotions) { await this.loadMotions(main); return this.model; }
      console.error(e);
      this.lastFailure = { file: main, format: format.id, error: errMsg(e) };
      this.status(tr('session.error', { error: errMsg(e) }), true);
      return null;
    }
  }

  private loadContext(files: ReadonlyArray<VFile | BlobFile>, main: VFile): LoadContext {
    const archives = this.archives;
    return {
      files,
      archives,
      async sibling(name) {
        const lower = name.toLowerCase();
        const f = files.find((x) => x.name.toLowerCase() === lower);
        if (f) return f.arrayBuffer();
        if (main.path) {
          const dir = main.path.replace(/[^/]*$/, '');
          for (const a of archives) { const e = a.lookup(dir + lower); if (e) return toArrayBuffer(await a.read(e)); }
        }
        return null;
      },
      async readPath(path) {
        for (const a of archives) { const e = a.lookup(path); if (e) return a.read(e); }
        return null;
      },
    };
  }

  private afterLoadContext(main: VFile, model: Model): AfterLoadContext {
    return {
      main,
      model,
      textures: this.textures,
      addMotions: (list, source) => { this.motions.push(...list.map((m) => ({ ...m, source }))); },
      addTextureDictionary: (file) => this.addTextureDictionary(file),
    };
  }

  /** Добавить внешние анимации к загруженной модели. */
  async loadMotions(file: VFile | BlobFile): Promise<Motion[]> {
    if (!this.model?.loadMotions) {
      this.status(tr('session.noMotionModel'), true);
      return [];
    }
    try {
      const list = await this.model.loadMotions(file);
      this.motions.push(...list.map((m) => ({ ...m, source: file.name })));
      this.emit('motions', this.motions);
      this.status(tr('session.motionsAdded', { n: list.length, name: file.name }));
      return list;
    } catch (e) {
      console.error(e);
      this.status(tr('session.motionError', { error: errMsg(e) }), true);
      return [];
    }
  }

  // ---------- текстуры ----------
  setTextureOverride(meshIndex: number, file: VFile | BlobFile): void { this.overrides.set(meshIndex, file); }

  /** Найти и декодировать текстуру меша. */
  /** Файл текстуры меша (тот же поиск, что у resolveTexture): для выгрузки исходных байтов, например DDS. */
  async textureSource(i: number): Promise<TextureSource | null> {
    const model = this.model, mesh = model?.meshes[i];
    if (!model || !mesh) return null;
    return this.findTextureSource(model, mesh, i);
  }

  private async findTextureSource(model: Model, mesh: Mesh, i: number): Promise<TextureSource | null> {
    let src: TextureSource | null = this.overrides.get(i) ?? null;
    if (!src && mesh.image) src = { name: 'embedded', decoded: mesh.image, arrayBuffer: async () => new ArrayBuffer(0) };
    if (!src) src = this.textures.find(mesh.texture);
    if (!src && this.format?.resolveTexture) {
      try { src = await this.format.resolveTexture(mesh, model, this.textures); } catch (e) { console.warn(e); }
    }
    // общие файлы материалов движков (.mtr, .mat) — для моделей любого формата
    for (const r of this.registry.materials) {
      if (src) break;
      try { src = await r.resolve(mesh, this.textures); } catch (e) { console.warn(e); }
    }
    if (!src && mesh.texture) src = this.sameFolderTexture(mesh.texture);
    return src;
  }

  async resolveTexture(i: number): Promise<TextureResult> {
    const model = this.model, mesh = model?.meshes[i];
    if (!model || !mesh) return { meshIndex: i, image: null, label: '', ok: false };
    const src = await this.findTextureSource(model, mesh, i);
    if (!src) return { meshIndex: i, image: null, label: mesh.texture ? tr('tex.noFile') : '', ok: false };
    try {
      const image = await this.textures.decode(src);
      return { meshIndex: i, image, label: `${image.width}×${image.height}`, ok: true, source: src.path ?? src.name };
    } catch (e) {
      return { meshIndex: i, image: null, label: tr('tex.error', { error: errMsg(e) }), ok: false };
    }
  }

  /**
   * Карта нормалей меша: встроенная → указанная моделью/материалом → по имени диффузной (_co→_nohq, __d→__n_d, _diff→_normal, _d→_n…).
   * Найденная картинка проверяется на «похожесть» на нормали и упаковку (RGB, RG/BC5, AG/DXT5nm).
   */
  async resolveNormal(i: number, diffuse?: string): Promise<NormalResult> {
    const mesh = this.model?.meshes[i], none: NormalResult = { meshIndex: i, image: null, packing: 'rgb', label: '', ok: false };
    if (!mesh) return none;
    const em = (await this.engineMaps(mesh))?.normal;
    if (em) return { meshIndex: i, image: em.image, packing: em.packing ?? 'rgb', label: em.label ?? `N ${em.image.width}×${em.image.height}`, ok: true };
    // явно заданные (встроенная, из материала) принимаются без проверки «похожести»; найденные по имени — проверяются
    const tried: Array<[() => TextureSource | null, boolean]> = [];
    if (mesh.normalImage) tried.push([() => ({ name: 'embedded', decoded: mesh.normalImage, arrayBuffer: async () => new ArrayBuffer(0) }), true]);
    if (mesh.normalMap) tried.push([() => this.textures.find(mesh.normalMap), true]);
    for (const base of [diffuse, mesh.texture]) for (const c of normalCandidates(base ?? '')) tried.push([() => this.textures.find(c), false]);
    const seen = new Set<string>();
    for (const [get, explicit] of tried) {
      const src = get();
      if (!src) continue;
      const key = src.path ?? src.name;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const image = await this.textures.decode(src);
        const a = analyzeNormalMap(image);
        if (!a.normal && !explicit) continue; // по имени нашлось не то
        return { meshIndex: i, image, packing: a.packing, label: `N ${image.width}×${image.height}${a.packing !== 'rgb' ? ' ' + a.packing.toUpperCase() : ''}`, ok: true };
      } catch { /* битый файл — пробуем следующий */ }
    }
    return mesh.normalMap ? { ...none, label: tr('tex.normalNoFile') } : none;
  }

  /**
   * PBR-поверхность меша: из материала (mesh.surface) или упакованные карты по имени диффузной (_orm, _rma, _smdi…).
   * Карты сводятся в одну текстуру (composeSurface); нет карт, но есть множители — текстура 1×1.
   */
  async resolveSurface(i: number, diffuse?: string): Promise<SurfaceResult> {
    const mesh = this.model?.meshes[i], none: SurfaceResult = { meshIndex: i, image: null, label: '', ok: false };
    if (!mesh) return none;
    const es = (await this.engineMaps(mesh))?.surface;
    if (es) return { meshIndex: i, image: es.image, label: es.label ?? 'PBR', ok: true };
    const variants = [...(mesh.surface ? [mesh.surface] : []), ...surfaceCandidates(diffuse ?? '').concat(diffuse !== mesh.texture ? surfaceCandidates(mesh.texture) : [])];
    for (const [k, s] of variants.entries()) {
      const explicit = k === 0 && !!mesh.surface;
      const images = new Map<string, DecodedImage>();
      for (const map of surfaceMaps(s)) {
        const src = this.textures.find(map);
        if (!src) continue;
        try { images.set(map, await this.textures.decode(src)); } catch { /* битая карта — без неё */ }
      }
      const factors = s.roughnessFactor !== undefined || s.metallicFactor !== undefined || s.specularFactor !== undefined;
      if (!images.size && !(explicit && factors)) continue;
      const image = composeSurface(s, images);
      const parts = [s.metallic && 'M', (s.roughness || s.gloss) && 'R', s.ao && 'AO', s.specular && 'S'].filter(Boolean).join('·');
      return { meshIndex: i, image, label: `PBR${parts ? ' ' + parts : ''}${images.size ? '' : tr('tex.pbrFactors')}`, ok: true };
    }
    return none;
  }

  /**
   * Последняя попытка: картинка в папке модели. Имя совпадает с материалом, или «skin.*» (Quake II rerelease: md5/skin.png),
   * или это единственная картинка в папке (без карт *_glow/_n/_s/_normal/_spec).
   */
  private sameFolderTexture(texture: string): TextureSource | null {
    const main = this.main;
    if (!main?.archive || !main.path) return null;
    const dir = main.path.replace(/[^/]*$/, ''), want = baseName(texture).toLowerCase().replace(/\.[^.]+$/, '');
    const imgs = main.archive.entries.filter((e) => e.path.startsWith(dir) && !e.path.slice(dir.length).includes('/') && this.registry.isImage(e.path)
      && !/_(glow|n|s|normal|spec|local|bump|gloss|h)\.[^.]+$/.test(e.path));
    const stem = (p: string) => baseName(p).replace(/\.[^.]+$/, '');
    const pick = imgs.find((e) => stem(e.path) === want) ?? imgs.find((e) => stem(e.path) === 'skin') ?? (imgs.length === 1 ? imgs[0] : undefined);
    return pick ? main.archive.fileOf(pick) : null;
  }

  // ---------- содержимое архивов ----------
  /** Модели и анимации текущего пресета во всех архивах. */
  archiveModels(filter = '', limit = 400): { items: ArchiveItem[]; total: number } {
    const exts = [...this.modelExtensions, ...this.motionExtensions].map((x) => '.' + x), q = filter.trim().toLowerCase();
    const items: ArchiveItem[] = [];
    let total = 0;
    for (const archive of this.archives)
      for (const entry of archive.entries) {
        if (!exts.some((x) => entry.path.endsWith(x)) && !this.registry.isPathModel(entry.path, this.preset.formats)) continue;
        total++;
        if (items.length >= limit || (q && !entry.path.includes(q))) continue;
        items.push({ archive, entry });
      }
    return { items, total };
  }

  /** Открыть запись архива: анимацию — добавить, модель — загрузить. */
  async openEntry(item: ArchiveItem): Promise<void> {
    const f = item.archive.fileOf(item.entry), ext = extOf(item.entry.path);
    if (this.registry.presetMotionExtensions(this.preset).includes(ext) && !this.modelExtensions.includes(ext)) await this.loadMotions(f);
    else await this.loadModel([f]);
  }
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Анимации из той же папки архива, что и модель (Doom 3: *.md5anim рядом с *.md5mesh). */
export async function loadSameDirMotions(ctx: AfterLoadContext, ext: string): Promise<number> {
  const { main, model } = ctx;
  if (!main.archive || !main.path || !model.loadMotions) return 0;
  const dir = main.path.replace(/[^/]*$/, '');
  let n = 0;
  for (const e of main.archive.entries) {
    if (n >= MAX_SAME_DIR_MOTIONS) break;
    if (!e.path.startsWith(dir) || !e.path.endsWith('.' + ext) || e.path.slice(dir.length).includes('/')) continue;
    try {
      const f = main.archive.fileOf(e);
      ctx.addMotions(await model.loadMotions(f), f.name);
      n++;
    } catch (err) { console.warn(err); }
  }
  return n;
}
