// Библиотека текстур: открытые архивы, отдельные файлы, словари (TXD) и кэш декодированных картинок.
import { decodeText, normPath, stripExt } from './binary';
import type { Archive, ArchiveEntry, BlobFile, DecodedImage, VFile } from './types';

/** Откуда брать текстуру: файл (декодируется по расширению) или уже декодированная картинка. */
export type TextureSource = VFile;

export interface ImageDecoder {
  decodeImage(file: VFile): Promise<DecodedImage>;
}

interface LooseTexture { file: BlobFile; key: string; base: string }

export class TextureLibrary {
  private readonly loose: LooseTexture[] = [];
  private readonly dict = new Map<string, VFile>();
  private readonly cache = new WeakMap<object, DecodedImage>();
  private memoMap = new Map<string, unknown>();

  constructor(
    private readonly decoder: ImageDecoder,
    /** Живой список архивов сессии. */
    readonly archives: readonly Archive[],
  ) {}

  /** Отдельные файлы текстур (ключи — путь без расширения и имя файла). */
  addFiles(files: readonly BlobFile[]): void {
    for (const f of files) {
      const key = stripExt(normPath(f.webkitRelativePath || f.name));
      this.loose.push({ file: f, key, base: key.split('/').pop()! });
    }
  }

  /** Текстура из словаря (TXD) по имени без расширения. */
  addDecoded(name: string, image: DecodedImage, origin = 'dict'): void {
    this.dict.set(name.toLowerCase(), { name: `${name}.${origin}`, decoded: image, arrayBuffer: async () => new ArrayBuffer(0) });
  }

  get looseCount(): number { return this.loose.length; }

  /**
   * Варианты ключа для имени из модели: нормализованный путь без расширения и его «хвосты».
   * «P:/Doom/base/textures/x/y.tga» (абсолютный путь художника) -> …, «base/textures/x/y», «textures/x/y», «x/y».
   */
  static candidates(name: string): string[] {
    const n = stripExt(normPath(name)).replace(/^[a-z]:\//, '').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    const parts = n.split('/'), out: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const k = parts.slice(i).join('/');
      if (i > 0 && parts[i - 1] === 'data') { out.unshift(k); continue; } // «Data\Textures\…» Bethesda — сразу без data/
      out.push(k);
    }
    return [...new Set(out)];
  }

  /** Найти текстуру по имени/пути из модели: словари -> архивы -> отдельные файлы; затем — по «хвостам» пути. */
  find(name: string | undefined | null): TextureSource | null {
    if (!name) return null;
    const cands = TextureLibrary.candidates(name), full = cands.includes(stripExt(normPath(name))) ? stripExt(normPath(name)) : cands[0]!;
    const base = full.split('/').pop()!;
    const d = this.dict.get(base);
    if (d) return d;
    for (const n of cands) {
      for (const a of this.archives) {
        const e = a.byKey.get(n) ?? a.byKey.get('textures/' + n) ?? a.byKey.get('models/' + n);
        if (e) return a.fileOf(e);
      }
      if (n.includes('/') || n === base) {
        const t = this.loose.find((x) => x.key === n) ?? this.loose.find((x) => x.key.endsWith('/' + n));
        if (t) return t.file;
      }
    }
    const t = this.loose.find((x) => x.base === base);
    if (t) return t.file;
    // архивы, где имена известны не все (хеши путей): по точному пути из модели
    for (const a of this.archives) { const e = a.findTexture?.(name); if (e) return a.fileOf(e); }
    // последний шанс: по имени файла в любом архиве (ZIP/PAK хранят только полные пути: prebuild/textures/pct/…)
    const hit = this.baseIndex().get(base);
    return hit ? hit[0].fileOf(hit[1]) : null;
  }

  /** Имя файла без расширения -> запись архива (первая встреченная), для поиска текстур без пути. */
  private baseIndex(): Map<string, [Archive, ArchiveEntry]> {
    const key = '\0baseIndex:' + this.archives.length;
    let m = this.memoMap.get(key) as Map<string, [Archive, ArchiveEntry]> | undefined;
    if (!m) {
      m = new Map();
      for (const a of this.archives)
        for (const [k, e] of a.byKey) { const b = k.slice(k.lastIndexOf('/') + 1); if (!m.has(b)) m.set(b, [a, e]); }
      this.memoMap.set(key, m);
    }
    return m;
  }

  /** Найти файл по пути во всех архивах (с запасным вариантом без префикса materials/). */
  findEntry(path: string): [Archive, ArchiveEntry] | null {
    for (const p of [path, path.replace(/^materials\//, '')])
      for (const a of this.archives) {
        const e = a.lookup(p);
        if (e) return [a, e];
      }
    return null;
  }

  /** Найти файл по имени (без папки) в индексах «Папки игры». */
  findByBase(base: string): [Archive, ArchiveEntry] | null {
    for (const a of this.archives) {
      const e = a.byBase?.get(base);
      if (e) return [a, e];
    }
    return null;
  }

  async readText(hit: [Archive, ArchiveEntry]): Promise<string> {
    return decodeText(await hit[0].read(hit[1]));
  }

  /** Кэш производных данных (разобранные материалы и т. п.), сбрасывается при смене архивов. */
  async memo<T>(key: string, make: () => Promise<T>): Promise<T> {
    if (this.memoMap.has(key)) return this.memoMap.get(key) as T;
    const v = await make();
    this.memoMap.set(key, v);
    return v;
  }

  invalidate(): void { this.memoMap = new Map(); }

  async decode(src: TextureSource): Promise<DecodedImage> {
    if (src.decoded) return src.decoded;
    let img = this.cache.get(src);
    if (!img) { img = await this.decoder.decodeImage(src); this.cache.set(src, img); }
    return img;
  }
}
