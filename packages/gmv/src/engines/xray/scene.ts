// Сцена уровня X-Ray SDK 0.7 (ЗП): текстовые .level и части rawdata/levels/<уровень>/*.part (формат ini).
// scene_object.part: объекты [object_N] с reference_name (путь в rawdata/objects без .object), position, rotation, scale.
import { boundsOf } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import type { Mesh, Model, VFile } from '../../core/types';
import { objectMeshes, parseObject, type XrObjectMesh } from './object';

export type Ini = Map<string, Map<string, string>>;

/** Разбор ini X-Ray (секции, «ключ = значение», комментарии «;»). */
export function parseIni(text: string): Ini {
  const out: Ini = new Map();
  let cur: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]/.exec(line);
    if (sec) { cur = new Map(); out.set(sec[1]!.trim(), cur); continue; }
    const eq = line.indexOf('=');
    if (cur && eq > 0) cur.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

export interface SceneObjectRef { name: string; reference: string; position: number[]; rotation: number[]; scale: number[]; flags: number }

const vec = (s: string | undefined, d: number[]) => (s ? s.split(',').map((x) => +x.trim()) : d);

/** Объекты из scene_object.part. */
export function sceneObjects(ini: Ini): SceneObjectRef[] {
  const out: SceneObjectRef[] = [];
  for (const [name, sec] of ini) {
    if (!/^object_\d+$/.test(name) || !sec.get('reference_name')) continue;
    out.push({
      name: sec.get('name') ?? name, reference: sec.get('reference_name')!, flags: +(sec.get('flags') ?? 0),
      position: vec(sec.get('position'), [0, 0, 0]), rotation: vec(sec.get('rotation'), [0, 0, 0]), scale: vec(sec.get('scale'), [1, 1, 1]),
    });
  }
  return out;
}

/**
 * Матрица поворота объекта сцены (строки-векторы: v' = v·R). Проверено на labx8 (ЗП): вершины 40 из 40 повёрнутых объектов
 * сцены совпали с геометрией скомпилированного уровня точно при R = transpose(setHPB(y, x, z)); другие трактовки углов — нет.
 */
export function sceneRotation(rot: number[]): number[] {
  const h = rot[1]!, p = rot[0]!, b = rot[2]!;
  const sh = Math.sin(h), ch = Math.cos(h), sp = Math.sin(p), cp = Math.cos(p), sb = Math.sin(b), cb = Math.cos(b);
  const cc = ch * cb, cs = ch * sb, sc = sh * cb, ss = sh * sb;
  const m = [cc - sp * ss, cs + sp * sc, -cp * sh, -cp * sb, cp * cb, sp, sc + sp * cs, ss - sp * cc, cp * ch];
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

/** Вершины меша объекта в мир сцены: v·S·R + P (строки-векторы). */
export function placeMesh(m: XrObjectMesh, ref: SceneObjectRef): { pos: Float32Array; nor: Float32Array } {
  const R = sceneRotation(ref.rotation), [sx, sy, sz] = ref.scale as [number, number, number], [px, py, pz] = ref.position as [number, number, number];
  const n = m.pos.length / 3, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = m.pos[i * 3]! * sx, y = m.pos[i * 3 + 1]! * sy, z = m.pos[i * 3 + 2]! * sz;
    pos[i * 3] = x * R[0]! + y * R[3]! + z * R[6]! + px;
    pos[i * 3 + 1] = x * R[1]! + y * R[4]! + z * R[7]! + py;
    pos[i * 3 + 2] = x * R[2]! + y * R[5]! + z * R[8]! + pz;
    // нормаль: при неравномерном масштабе — через обратный масштаб
    const a = m.nor[i * 3]! / sx, b = m.nor[i * 3 + 1]! / sy, c = m.nor[i * 3 + 2]! / sz;
    let nx = a * R[0]! + b * R[3]! + c * R[6]!, ny = a * R[1]! + b * R[4]! + c * R[7]!, nz = a * R[2]! + b * R[5]! + c * R[8]!;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    nor[i * 3] = nx; nor[i * 3 + 1] = ny; nor[i * 3 + 2] = nz;
  }
  return { pos, nor };
}

/** Найти файл по пути rawdata/… (в открытых папках/архивах путь может начинаться выше: editors/rawdata, sdk/editors/rawdata). */
async function readRaw(ctx: LoadContext, rel: string): Promise<Uint8Array | null> {
  const want = rel.toLowerCase().replace(/\\/g, '/');
  for (const a of ctx.archives) {
    const e = a.lookup(want) ?? a.entries.find((x) => x.path.endsWith('/' + want));
    if (e) return a.read(e);
  }
  return null;
}

/** Уровень SDK: .level + scene_object.part + объекты. Меши объединяются по текстуре и шейдеру. */
export async function loadSceneLevel(main: VFile, ctx: LoadContext): Promise<Model> {
  const level = parseIni(new TextDecoder('windows-1251').decode(await main.arrayBuffer()));
  const opts = level.get('level_options'), name = main.name.replace(/\.level$/i, '');
  const dir = (main.path ?? '').replace(/[^/]*$/, '');
  const partPath = `${dir}${name}/scene_object.part`;
  let part = await ctx.readPath(partPath).catch(() => null);
  if (!part) part = await readRaw(ctx, `rawdata/levels/${name}/scene_object.part`);
  if (!part) throw new Error(`Нет ${name}/scene_object.part рядом с ${main.name}: откройте папку SDK (editors/rawdata) целиком`);
  const refs = sceneObjects(parseIni(new TextDecoder('windows-1251').decode(part)));
  const cache = new Map<string, XrObjectMesh[] | null>(), missing = new Set<string>();
  const groups = new Map<string, { texture: string; shader: string; material?: string; pos: number[]; nor: number[]; uv: number[]; idx: number[] }>();
  let placed = 0;
  for (const ref of refs) {
    let list = cache.get(ref.reference);
    if (list === undefined) {
      const raw = await readRaw(ctx, `rawdata/objects/${ref.reference}.object`);
      try { list = raw ? objectMeshes(parseObject(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)) : null; } catch { list = null; }
      cache.set(ref.reference, list);
    }
    if (!list) { missing.add(ref.reference); continue; }
    placed++;
    for (const m of list) {
      const s = m.surface, key = `${s?.texture ?? ''}|${s?.eshader ?? ''}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { texture: s?.texture ?? '', shader: s?.eshader ?? '', material: s?.gamemtl, pos: [], nor: [], uv: [], idx: [] }));
      const { pos, nor } = placeMesh(m, ref), base = g.pos.length / 3;
      for (let i = 0; i < pos.length; i++) { g.pos.push(pos[i]!); g.nor.push(nor[i]!); }
      for (let i = 0; i < m.uv.length; i++) g.uv.push(m.uv[i]!);
      for (let i = 0; i < m.indices.length; i++) g.idx.push(m.indices[i]! + base);
    }
  }
  const meshes: Mesh[] = [...groups.values()].map((g) => {
    const n = g.pos.length / 3;
    return {
      name: `${g.texture || '(без текстуры)'} · ${g.shader}`, texture: g.texture, shader: g.shader, material: g.material, vertexCount: n,
      pos: Float32Array.from(g.pos), nor: Float32Array.from(g.nor), uv: Float32Array.from(g.uv),
      bone: new Float32Array(n * 4), weight: new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), indices: Uint32Array.from(g.idx), skinned: false,
    };
  });
  if (!meshes.length) throw new Error(`Объекты уровня не найдены (${missing.size} ссылок): откройте папку SDK с rawdata/objects`);
  const info = [`Уровень SDK: ${opts?.get('level_path') ?? name}, объектов ${refs.length}, показано ${placed}, мешей (по текстурам) ${meshes.length}`];
  if (missing.size) info.push(`Нет файлов объектов (${missing.size}): ${[...missing].slice(0, 6).join(', ')}${missing.size > 6 ? '…' : ''}`);
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: true, info };
}
