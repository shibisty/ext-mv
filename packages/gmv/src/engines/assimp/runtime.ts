// Загрузка assimpjs (WASM) и конвертация файлов в 'assjson'.
// В браузере по умолчанию подключается <script> из baseUrl (assimpjs-all.js / assimpjs.js рядом с .wasm);
// в Node и в своих сборках можно передать фабрику: configureAssimp({ factory: () => require('assimpjs')() }).
import { decodeText } from '../../core/binary';
import type { Model, VFile } from '../../core/types';
import { convertScene, type AssScene } from './convert';

export interface AssimpResult { IsSuccess(): boolean; FileCount(): number; GetErrorCode(): string; GetFile(i: number): { GetContent(): Uint8Array } }
export interface AssimpJs {
  FileList: new () => { AddFile(name: string, data: Uint8Array): void };
  ConvertFileList(list: InstanceType<AssimpJs['FileList']>, format: string): AssimpResult;
}
export interface AssimpOptions {
  /** Своя фабрика модуля (имеет приоритет). */
  factory?: () => Promise<AssimpJs>;
  /** Папка со скриптом и .wasm (по умолчанию — lib/ рядом со страницей). */
  baseUrl?: string;
  /** Имена скриптов по порядку попыток. */
  scripts?: string[];
}

type AssimpGlobal = (opts: { locateFile: (f: string) => string }) => Promise<AssimpJs>;
let options: AssimpOptions = {};
let pending: Promise<AssimpJs> | null = null;

export function configureAssimp(o: AssimpOptions): void {
  options = { ...options, ...o };
  pending = null;
}

export const ASSIMP_MISSING =
  'assimpjs не найден. Скопируйте assimpjs-all.js и assimpjs-all.wasm (или assimpjs.js/.wasm) из npm-пакета assimpjs/dist в папку lib/ и перезагрузите страницу.';

function loadScript(src: string): Promise<void> {
  return new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => ok();
    s.onerror = () => { s.remove(); fail(new Error('нет ' + src)); };
    document.head.append(s);
  });
}

export function getAssimp(): Promise<AssimpJs> {
  if (pending) return pending;
  pending = (async () => {
    if (options.factory) return options.factory();
    const g = globalThis as unknown as { assimpjs?: AssimpGlobal };
    const base = options.baseUrl ?? (typeof document !== 'undefined' ? new URL('lib/', document.baseURI).href : '');
    if (!g.assimpjs) {
      if (typeof document === 'undefined') throw new Error(ASSIMP_MISSING);
      let ok = false;
      for (const n of options.scripts ?? ['assimpjs-all.js', 'assimpjs.js']) {
        try { await loadScript(new URL(n, base).href); ok = true; break; } catch { /* пробуем следующий */ }
      }
      if (!ok || !g.assimpjs) throw new Error(ASSIMP_MISSING);
    }
    return g.assimpjs({ locateFile: (f) => new URL(f, base).href });
  })();
  pending.catch(() => { pending = null; });
  return pending;
}

/** Прочитать файлы через assimp (основной первым) и вернуть сцену assjson. */
export async function readScene(files: readonly VFile[], main: VFile): Promise<AssScene> {
  const ajs = await getAssimp();
  const fl = new ajs.FileList();
  for (const f of [main, ...files.filter((f) => f !== main)]) fl.AddFile(f.name, new Uint8Array(await f.arrayBuffer()));
  const res = ajs.ConvertFileList(fl, 'assjson');
  if (!res.IsSuccess() || res.FileCount() === 0) throw new Error('assimp не смог прочитать файл (' + res.GetErrorCode() + ')');
  return JSON.parse(decodeText(res.GetFile(0).GetContent())) as AssScene;
}

export async function loadWithAssimp(files: readonly VFile[], main: VFile): Promise<Model> {
  return convertScene(await readScene(files, main));
}
