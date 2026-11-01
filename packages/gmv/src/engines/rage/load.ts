// Загрузка моделей GTA V: .ydr (drawable), .ydd (словарь drawable), .yft (фрагмент: машины, персонажи).
// Персонаж (папка с <ped>.yft и компонентами *_000_*.ydd): собирается из вариантов «000» каждого компонента.
import { boundsOf, sumTris, sumVerts } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import type { Archive, ArchiveEntry, Mesh, Model, VFile } from '../../core/types';
import { readDrawable, readDrawableDictionary, readFragmentDrawables, type DrawableInfo } from './drawable';
import { openResource, type Resource } from './rsc';
import { readTextureDictionary, type RageTexture } from './texture';

/** Встроенные текстуры (словарь в ShaderGroup) — в Mesh.image, чтобы не искать по файлам. */
function attachEmbedded(r: Resource, d: DrawableInfo, out: Map<string, RageTexture>) {
  if (d.embedded) for (const t of readTextureDictionary(r, d.embedded).textures) out.set(t.name.toLowerCase(), t);
  for (const m of d.meshes) {
    const t = out.get(m.texture.toLowerCase()); if (t) m.image = t;
    const n = m.normalMap ? out.get(m.normalMap.toLowerCase()) : undefined; if (n) m.normalImage = n;
  }
}

function finish(meshes: Mesh[], info: string[]): Model {
  if (!meshes.length) throw new Error('В ресурсе нет геометрии (LOD High пуст)');
  info[0] += `, мешей ${meshes.length}, вершин ${sumVerts(meshes)}, треугольников ${sumTris(meshes)}`;
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), defaultZUp: true, info };
}

export async function loadYdr(main: VFile): Promise<Model> {
  const r = await openResource(await main.arrayBuffer()), d = readDrawable(r, 0), emb = new Map<string, RageTexture>();
  attachEmbedded(r, d, emb);
  return finish(d.meshes, [`GTA V drawable ${main.name} (RSC7 v${r.version})`, ...(d.bones ? [`Костей: ${d.bones}`] : [])]);
}

export async function loadYdd(main: VFile): Promise<Model> {
  const r = await openResource(await main.arrayBuffer()), emb = new Map<string, RageTexture>(), meshes: Mesh[] = [];
  const list = readDrawableDictionary(r);
  for (const [i, e] of list.entries()) {
    const d = readDrawable(r, e.at, list.length > 1 ? `${i}·` : '');
    attachEmbedded(r, d, emb);
    meshes.push(...d.meshes);
  }
  return finish(meshes, [`GTA V словарь drawable ${main.name} (RSC7 v${r.version}), drawable: ${list.length}`]);
}

const COMPONENTS = ['head', 'berd', 'hair', 'uppr', 'lowr', 'hand', 'feet', 'teef', 'accs', 'task', 'decl', 'jbib'];

/** Файлы той же папки архива. */
function folderEntries(main: VFile): Array<[Archive, ArchiveEntry]> {
  if (!main.archive || !main.path) return [];
  const dir = main.path.replace(/[^/]*$/, ''), out: Array<[Archive, ArchiveEntry]> = [];
  for (const e of main.archive.entries) if (e.path.startsWith(dir)) out.push([main.archive, e]);
  return out;
}

export async function loadYft(main: VFile, ctx: LoadContext): Promise<Model> {
  const r = await openResource(await main.arrayBuffer()), emb = new Map<string, RageTexture>(), meshes: Mesh[] = [];
  const ds = readFragmentDrawables(r);
  for (const [i, at] of ds.entries()) {
    const d = readDrawable(r, at, ds.length > 1 ? `${i}·` : '');
    attachEmbedded(r, d, emb);
    meshes.push(...d.meshes);
    if (i === 0 && ds.length > 1) break; // остальные — повреждённые/отдельные детали: показываем основной вид
  }
  const info = [`GTA V фрагмент ${main.name} (RSC7 v${r.version})`];
  // у персонажа в .yft только скелет и заглушка в несколько вершин
  if (sumVerts(meshes) < 64) {
    meshes.length = 0;
    // персонаж: геометрия в компонентах рядом (папка «stream/<ped>/» или «<ped>/»)
    const base = main.name.replace(/\.yft$/i, '').toLowerCase();
    let files = folderEntries(main).filter(([, e]) => /\.ydd$/.test(e.path));
    const sub = (ctx.archives.flatMap((a) => a.entries.filter((e) => e.path.includes(`/${base}/`) && /\.ydd$/.test(e.path)).map((e) => [a, e] as [Archive, ArchiveEntry])));
    if (!files.length) files = sub;
    const used: string[] = [];
    for (const comp of COMPONENTS) {
      const hit = files.find(([, e]) => new RegExp(`(^|/)${comp}_000_[a-z]\\.ydd$`).test(e.path));
      if (!hit) continue;
      const rr = await openResource(await hit[0].fileOf(hit[1]).arrayBuffer());
      for (const e of readDrawableDictionary(rr)) {
        const d = readDrawable(rr, e.at, `${comp}·`);
        attachEmbedded(rr, d, emb);
        meshes.push(...d.meshes.filter((m) => m.vertexCount > 3)); // пустые компоненты — заглушка-треугольник
      }
      used.push(comp);
    }
    if (used.length) info.push(`Персонаж: компоненты ${used.join(', ')} (варианты 000). Остальные варианты — отдельными .ydd`);
  }
  return finish(meshes, info);
}

export async function parseYtd(buf: ArrayBuffer) {
  const r = await openResource(buf);
  return readTextureDictionary(r, 0);
}
