// Уровни Survarium: projects/<уровень>/<режим>/client_project — двоичный конфиг.
//   render_visuals — статика: [model_name — папка models/<имя>.model, position f32×3, rotation — углы f32×3 (радианы), scale f32×3];
//   client_objects — объекты редактора по game_object_type: skeleton_visual (models/<имя>.skinned_model — показываются в bind-позе),
//     vegetation (слои травы, см. parseVeg), light, particle (метки), wire_set (провода: points от position), прочее не показывается.
// Модели собираются как в просмотре модели (части LOD0 из settings, материалы) и расставляются экземплярами
// (слои «Объекты» — по папкам моделей, трава — по слоям растительности).
import { normPath } from '../../core/binary';
import { boundsOf } from '../../core/geometry';
import { compose } from '../../core/math';
import type { LoadContext } from '../../core/plugin';
import type { InstancedScene, Mesh, Model, PlacementRange, VFile } from '../../core/types';
import { eulerQuat } from './anim';
import { LEVEL_MARK } from './db';
import { modelMeshes, parseVostokConfig, tbl, type CfgTable, type CfgValue } from './model';

/**
 * Углы объекта — та же функция, что у костей (anim.ts: R = Rz(−z)·Ry(−y)·Rx(−x)): проверено по заборам уровней —
 * у объектов с углом Y = ±π/2 углы X и Z равны (вырожденный случай с Y посередине), и забор должен стоять вертикально.
 */
export const levelQuat = (r: readonly number[]) => eulerQuat(r[0]!, r[1]!, r[2]!);

export interface LevelVisual { model: string; pos: number[]; rot: number[]; scale: number[] }

const vec3 = (v: CfgValue | undefined, d: number) => (Array.isArray(v) && v.length >= 3 ? (v as number[]).slice(0, 3).map((x) => (typeof x === 'number' ? x : d)) : [d, d, d]);
const arr = (v: CfgValue | undefined): CfgValue[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const num = (v: CfgValue | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: CfgValue | undefined) => (typeof v === 'string' ? v : '');

export function levelVisuals(u: Uint8Array): { name: string; visuals: LevelVisual[] } {
  const root = parseVostokConfig(u);
  const list = root.render_visuals;
  if (!Array.isArray(list)) throw new Error('client_project: нет render_visuals');
  const visuals: LevelVisual[] = [];
  for (const v of list) {
    const t = tbl(v);
    const model = t?.model_name;
    if (typeof model !== 'string' || !model) continue;
    visuals.push({ model: normPath(model), pos: vec3(t!.position, 0), rot: vec3(t!.rotation, 0), scale: vec3(t!.scale, 1) });
  }
  return { name: typeof root.project_name === 'string' ? root.project_name : '', visuals };
}

/**
 * Слой растительности (vegetation/*.veg): чанки [u32 тип, u32 размер]:
 *   78 — маска клеток (u32 размер после распаковки = size_x·size_z·16, u32 2048, u32 0, 8 байт, поток LZMA2) — 4×4 байта на клетку;
 *   88 — позиции экземпляров f32×3 (уже на земле, в координатах уровня); 89 — нормали земли в этих точках f32×3.
 * Модель, поворот и масштаб экземпляра игра выбирает сама (model_def с вероятностями, random_dir, random_scale, use_face_normal).
 */
export function parseVeg(u: Uint8Array): { pos: Float32Array; nor: Float32Array | null } {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let pos: Float32Array | null = null, nor: Float32Array | null = null;
  for (let p = 0; p + 8 <= u.length;) {
    const t = dv.getUint32(p, true), s = dv.getUint32(p + 4, true), b = p + 8;
    if (b + s > u.length) throw new Error('.veg: чанк выходит за конец файла');
    if (t === 88 || t === 89) {
      const a = new Float32Array(Math.floor(s / 12) * 3);
      for (let i = 0; i < a.length; i++) a[i] = dv.getFloat32(b + i * 4, true);
      if (t === 88) pos = a; else nor = a;
    }
    p = b + s;
  }
  if (!pos) throw new Error('.veg: нет позиций (чанк 88)');
  return { pos, nor: nor && nor.length === pos.length ? nor : null };
}

export interface VegLayer { name: string; file: string; models: Array<{ name: string; p: number; scale: number }>; randomDir: boolean; randomScale: number; faceNormal: boolean; visible: boolean }

export function vegLayers(objects: CfgValue[]): VegLayer[] {
  const out: VegLayer[] = [];
  for (const o of objects) {
    const t = tbl(o);
    if (t?.game_object_type !== 'vegetation' || t.is_enabled === 0) continue;
    for (const l of arr(t.layers)) {
      const L = tbl(l);
      if (!L || !str(L.filename)) continue;
      const models = arr(L.model_def).map(tbl).filter((d): d is CfgTable => !!d && !!str(d.name))
        .map((d) => ({ name: normPath(str(d.name)), p: Math.max(0, num(d.probability, 1)), scale: num(d.scale, 1) }));
      if (!models.length) continue;
      out.push({ name: str(L.name) || str(L.filename), file: normPath(str(L.filename)), models, randomDir: num(L.random_dir, 1) !== 0, randomScale: num(L.random_scale, 0), faceNormal: num(L.use_face_normal, 0) !== 0, visible: num(L.visible, 1) !== 0 });
    }
  }
  return out;
}

/** Детерминированный случайный поток (mulberry32): трава одинакова при каждом открытии. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };

const qmul = (a: number[], b: number[]) => [
  a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]! - a[3]! * b[3]!,
  a[0]! * b[1]! + a[1]! * b[0]! + a[2]! * b[3]! - a[3]! * b[2]!,
  a[0]! * b[2]! - a[1]! * b[3]! + a[2]! * b[0]! + a[3]! * b[1]!,
  a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]! + a[3]! * b[0]!,
];
/** Поворот, переводящий ось Y в n. */
function alignY(nx: number, ny: number, nz: number): number[] {
  const l = Math.hypot(nx, ny, nz);
  if (!l) return [1, 0, 0, 0];
  nx /= l; ny /= l; nz /= l;
  if (ny < -0.999999) return [0, 1, 0, 0];
  // ось = Y × n = (nz, 0, −nx), q = [1 + ny, ось] нормированный
  const q = [1 + ny, nz, 0, -nx], m = Math.hypot(...q);
  return q.map((v) => v / m);
}

/** Экземпляры слоя: модель по вероятностям, поворот вокруг Y (и по нормали земли), масштаб model_def.scale·(1 ± random_scale). */
export function vegInstances(layer: VegLayer, pos: Float32Array, nor: Float32Array | null): Array<{ model: number; M: Float64Array }> {
  const r = rng(hashStr(layer.file)), sum = layer.models.reduce((s, m) => s + m.p, 0), out: Array<{ model: number; M: Float64Array }> = [];
  for (let i = 0; i < pos.length / 3; i++) {
    let k = 0;
    if (layer.models.length > 1) {
      if (sum > 0) { let x = r() * sum; while (k < layer.models.length - 1 && (x -= layer.models[k]!.p) >= 0) k++; while (k > 0 && layer.models[k]!.p === 0) k--; }
      else k = Math.floor(r() * layer.models.length);
    }
    const m = layer.models[k]!, a = layer.randomDir ? r() * Math.PI * 2 : 0, sc = m.scale * (1 + (r() * 2 - 1) * layer.randomScale);
    let q = [Math.cos(a / 2), 0, Math.sin(a / 2), 0];
    if (layer.faceNormal && nor) q = qmul(alignY(nor[i * 3]!, nor[i * 3 + 1]!, nor[i * 3 + 2]!), q);
    const M = new Float64Array(16);
    compose([pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!], q, [sc, sc, sc], M);
    out.push({ model: k, M });
  }
  return out;
}

/** Метка-ромб (свет, частицы): 6 вершин, 8 граней. */
function markerMesh(name: string, size: number, color: number[]): Mesh {
  const s = size, P = [s, 0, 0, -s, 0, 0, 0, s, 0, 0, -s, 0, 0, 0, s, 0, 0, -s];
  const I = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
  const pos = Float32Array.from(P), nor = Float32Array.from(P.map((v) => Math.sign(v)));
  return { name, texture: '', vertexCount: 6, pos, nor, uv: new Float32Array(12), bone: new Float32Array(0), weight: new Float32Array(0), indices: Uint16Array.from(I), skinned: false, color };
}

/** Провод: ломаная points (от position объекта), крест из двух полос шириной wire_width. */
export function wireMesh(points: number[][], width: number): Mesh | null {
  if (points.length < 2) return null;
  const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [], h = Math.max(width, 0.01) / 2;
  for (const [ox, oy] of [[h, 0], [0, h]] as const) {
    const base = P.length / 3;
    points.forEach((p, i) => {
      P.push(p[0]! - ox, p[1]! - oy, p[2]!, p[0]! + ox, p[1]! + oy, p[2]!);
      N.push(oy ? 1 : 0, ox ? 1 : 0, 0, oy ? 1 : 0, ox ? 1 : 0, 0);
      U.push(0, i, 1, i);
      if (i) { const v = base + i * 2; I.push(v - 2, v - 1, v, v - 1, v + 1, v, v - 2, v, v - 1, v - 1, v, v + 1); }
    });
  }
  return { name: 'wire', texture: '', vertexCount: P.length / 3, pos: Float32Array.from(P), nor: Float32Array.from(N), uv: Float32Array.from(U), bone: new Float32Array(0), weight: new Float32Array(0), indices: Uint32Array.from(I), skinned: false, color: [0.08, 0.08, 0.08] };
}

interface Group { index: number; key: string; name: string; proto: Mesh; hidden: boolean; nV: number; nI: number; items: Array<{ p: Mesh; M: ArrayLike<number>; flip: boolean }> }

/** Сборка сцены: экземпляры складываются в общие меши по материалу; массивы выделяются один раз в конце. */
class LevelBuilder {
  readonly groups = new Map<string, Group>();
  readonly scene: InstancedScene = { meshes: [], protos: [], placements: [] };
  private readonly protoParts: number[][] = [];
  tris = 0;

  private group(key: string, name: string, p: Mesh, hidden: boolean): Group {
    let g = this.groups.get(key);
    if (!g) { g = { index: this.groups.size, key, name, proto: p, hidden, nV: 0, nI: 0, items: [] }; this.groups.set(key, g); }
    return g;
  }

  /** Прототип: части модели; kind — префикс ключа групп (трава отдельно от статики, чтобы её можно было скрыть). */
  proto(name: string, parts: Mesh[], kind: string, label: (p: Mesh) => string, hidden = false): number {
    const gs = parts.map((p) => this.group(`${kind}|${p.texture}|${p.material ?? ''}|${p.color?.join(',') ?? ''}`, label(p), p, hidden));
    this.protoParts.push(gs.map((g) => g.index));
    this.scene.protos.push({ name, parts: parts.map((p, i) => ({ mesh: gs[i]!.index, pos: p.pos, nor: p.nor, uv: p.uv, indices: Uint32Array.from(p.indices) })) });
    this.groupsByIndex = null;
    return this.scene.protos.length - 1;
  }

  private groupsByIndex: Group[] | null = null;

  place(pi: number, parts: Mesh[], M: ArrayLike<number>, name: string, layer: string): void {
    const byIndex = (this.groupsByIndex ??= [...this.groups.values()]);
    const det = M[0]! * (M[5]! * M[10]! - M[6]! * M[9]!) - M[1]! * (M[4]! * M[10]! - M[6]! * M[8]!) + M[2]! * (M[4]! * M[9]! - M[5]! * M[8]!);
    const ranges: PlacementRange[] = [];
    this.protoParts[pi]!.forEach((gi, partIndex) => {
      const g = byIndex[gi]!, p = parts[partIndex]!;
      ranges.push({ mesh: gi, part: partIndex, vStart: g.nV, vCount: p.vertexCount, iStart: g.nI, iCount: p.indices.length });
      g.items.push({ p, M, flip: det < 0 });
      g.nV += p.vertexCount; g.nI += p.indices.length;
      this.tris += p.indices.length / 3;
    });
    this.scene.placements.push({ proto: pi, name, pose: Array.from(M), group: layer, ranges });
  }

  build(): Mesh[] {
    const meshes: Mesh[] = [];
    for (const g of this.groups.values()) {
      const pos = new Float32Array(g.nV * 3), nor = new Float32Array(g.nV * 3), uv = new Float32Array(g.nV * 2);
      const indices = g.nV > 65535 ? new Uint32Array(g.nI) : new Uint16Array(g.nI);
      let v0 = 0, i0 = 0;
      for (const { p, M, flip } of g.items) {
        const n = p.vertexCount;
        for (let i = 0; i < n; i++) {
          const x = p.pos[i * 3]!, y = p.pos[i * 3 + 1]!, z = p.pos[i * 3 + 2]!, o = (v0 + i) * 3;
          pos[o] = x * M[0]! + y * M[4]! + z * M[8]! + M[12]!; pos[o + 1] = x * M[1]! + y * M[5]! + z * M[9]! + M[13]!; pos[o + 2] = x * M[2]! + y * M[6]! + z * M[10]! + M[14]!;
          const nx = p.nor[i * 3]!, ny = p.nor[i * 3 + 1]!, nz = p.nor[i * 3 + 2]!;
          const ax = nx * M[0]! + ny * M[4]! + nz * M[8]!, ay = nx * M[1]! + ny * M[5]! + nz * M[9]!, az = nx * M[2]! + ny * M[6]! + nz * M[10]!, l = Math.hypot(ax, ay, az) || 1;
          nor[o] = ax / l; nor[o + 1] = ay / l; nor[o + 2] = az / l;
          uv[(v0 + i) * 2] = p.uv[i * 2]!; uv[(v0 + i) * 2 + 1] = p.uv[i * 2 + 1]!;
        }
        const idx = p.indices;
        for (let i = 0; i + 2 < idx.length; i += 3) {
          indices[i0 + i] = v0 + idx[i]!;
          indices[i0 + i + 1] = v0 + idx[flip ? i + 2 : i + 1]!;
          indices[i0 + i + 2] = v0 + idx[flip ? i + 1 : i + 2]!;
        }
        v0 += n; i0 += idx.length;
      }
      g.items = [];
      const P = g.proto;
      meshes.push({
        name: g.name, texture: P.texture, material: P.material, normalMap: P.normalMap, surface: P.surface, color: P.color, alphaTest: P.alphaTest,
        vertexCount: g.nV, pos, nor, uv, bone: new Float32Array(0), weight: new Float32Array(0), indices, skinned: false, ...(g.hidden ? { defaultHidden: true } : {}),
      });
    }
    this.scene.meshes = meshes.map((_, i) => i);
    return meshes;
  }
}

/** Трава: уровень LOD и предел треугольников на уровень. */
const GRASS_LOD = 1, GRASS_BUDGET = 1_500_000;

const baseName = (p: Mesh) => p.material?.split('/').pop() || p.texture.split('/').pop() || '?';

export async function loadVostokLevel(text: string, main: VFile, ctx: LoadContext): Promise<Model> {
  const path = normPath(text.slice(LEVEL_MARK.length).trim());
  const arc = main.archive ?? ctx.archives.find((a) => a.lookup(path));
  const e = arc?.lookup(path);
  if (!arc || !e) throw new Error('Уровень Survarium открывается только из архивов resources.*.db');
  const u = await arc.read(e);
  const { name, visuals } = levelVisuals(u);
  const objects = arr(parseVostokConfig(u).client_objects);
  const B = new LevelBuilder();
  const missing = new Set<string>(), matMissing = new Set<string>();
  const cache = new Map<string, { pi: number; parts: Mesh[] } | null>();

  /** Прототип модели по имени (models/<имя>.model или .skinned_model). */
  const protoOf = async (model: string, kinds: string[], kind: string, label: (p: Mesh) => string, lod = 0): Promise<{ pi: number; parts: Mesh[] } | null> => {
    const key = `${kind}|${lod}|${model}`;
    if (cache.has(key)) return cache.get(key)!;
    let res: { pi: number; parts: Mesh[] } | null = null;
    for (const ext of kinds) {
      const dir = `models/${model}.${ext}`;
      if (!arc.lookup(dir)) continue;
      try {
        const r = await modelMeshes(arc, dir, null, null, lod);
        for (const m of r.missing) matMissing.add(m);
        if (r.meshes.length) res = { pi: B.proto(model, r.meshes, kind, label), parts: r.meshes };
      } catch { /* не прочитана */ }
      break;
    }
    if (!res) missing.add(model);
    cache.set(key, res);
    return res;
  };
  const folder = (m: string) => m.split('/').slice(0, -1).join('/') || 'models';
  const poseOf = (pos: number[], rot: number[], scale: number[]) => { const M = new Float64Array(16); compose(pos, levelQuat(rot), scale, M); return M; };

  // статика
  let statics = 0;
  for (const v of visuals) {
    const pr = await protoOf(v.model, ['model', 'skinned_model'], 'static', baseName);
    if (!pr) continue;
    B.place(pr.pi, pr.parts, poseOf(v.pos, v.rot, v.scale), v.model.split('/').pop()!, folder(v.model));
    statics++;
  }

  // объекты редактора
  let skel = 0, wires = 0;
  const lights: Array<{ name: string; pos: number[] }> = [], particles: Array<{ name: string; pos: number[] }> = [];
  for (const o of objects) {
    const t = tbl(o);
    if (!t || t.is_enabled === 0) continue;
    const type = str(t.game_object_type), pos = vec3(t.position, 0), rot = vec3(t.rotation, 0), scale = vec3(t.scale, 1);
    if (type === 'skeleton_visual' && str(t.model_name)) {
      const model = normPath(str(t.model_name));
      const pr = await protoOf(model, ['skinned_model', 'model'], 'static', baseName);
      if (!pr) continue;
      B.place(pr.pi, pr.parts, poseOf(pos, rot, scale), str(t.name) || model.split('/').pop()!, `skeleton_visual/${folder(model)}`);
      skel++;
    } else if (type === 'light') lights.push({ name: str(t.name) || 'light', pos });
    else if (type === 'particle') particles.push({ name: str(t.particle_name) || str(t.name) || 'particle', pos });
    else if (type === 'wire_set') {
      const pts = arr(t.points).filter((p): p is number[] => Array.isArray(p) && p.length >= 3 && p.every((x) => typeof x === 'number'));
      const w = wireMesh(pts, num(t.wire_width, 0.03));
      if (!w) continue;
      const pi = B.proto(`wire ${str(t.name)}`, [w], 'wire', () => 'Провода');
      B.place(pi, [w], poseOf(pos, rot, scale), str(t.name) || 'wire', 'wire_set');
      wires++;
    }
  }

  // трава: LOD1 (в игре вблизи LOD0, но на весь уровень это лишние миллионы треугольников); если всё равно больше
  // GRASS_BUDGET треугольников — равномерно прореживается
  const levelDir = path.split('/').slice(0, -2).join('/');
  const vegNotes: string[] = [];
  const layers: Array<{ L: VegLayer; list: Array<{ model: number; M: Float64Array }>; protos: Array<{ pi: number; parts: Mesh[] } | null> }> = [];
  let grassAll = 0, grassTris = 0;
  for (const L of vegLayers(objects)) {
    if (!L.visible) continue;
    const ve = arc.lookup(`${levelDir}/${L.file}`);
    if (!ve) { vegNotes.push(`${L.file} не найден`); continue; }
    let veg: ReturnType<typeof parseVeg>;
    try { veg = parseVeg(await arc.read(ve)); } catch (er) { vegNotes.push(`${L.file}: ${(er as Error).message}`); continue; }
    const protos = [];
    for (const m of L.models) protos.push(await protoOf(m.name, ['model'], 'veg', (p) => `Трава · ${baseName(p)}`, GRASS_LOD));
    const list = vegInstances(L, veg.pos, veg.nor);
    for (const it of list) { const pr = protos[it.model]; if (pr) { grassAll++; grassTris += pr.parts.reduce((s, p) => s + p.indices.length / 3, 0); } }
    layers.push({ L, list, protos });
  }
  const keep = grassTris > GRASS_BUDGET ? GRASS_BUDGET / grassTris : 1, pick = rng(1);
  let grass = 0;
  for (const { L, list, protos } of layers) {
    for (const it of list) {
      const pr = protos[it.model];
      if (!pr || (keep < 1 && pick() >= keep)) continue;
      B.place(pr.pi, pr.parts, it.M, L.models[it.model]!.name.split('/').pop()!, `vegetation/${L.name}`);
      grass++;
    }
  }

  // метки света и частиц (по умолчанию скрыты; включаются в списке мешей)
  const markers = (list: Array<{ name: string; pos: number[] }>, label: string, color: number[], layer: string) => {
    if (!list.length) return;
    const m = markerMesh(label, 0.2, color), pi = B.proto(label, [m], 'marker', () => label, true);
    for (const x of list) { const M = new Float64Array(16); compose(x.pos, [1, 0, 0, 0], [1, 1, 1], M); B.place(pi, [m], M, x.name, layer); }
  };
  markers(lights, 'Метки · свет', [1, 0.85, 0.3], 'light');
  markers(particles, 'Метки · частицы', [0.3, 0.8, 1], 'particle');

  const meshes = B.build();
  if (!meshes.length) throw new Error('В уровне нет найденных моделей');
  const info = [
    `Survarium (Vostok): уровень ${name || path}`,
    `Объектов: ${visuals.length}, показано ${statics} (моделей ${[...cache].filter(([k, v]) => v && k.startsWith('static|')).length}, треугольников ${B.tris})`,
  ];
  if (skel) info.push(`Объекты со скелетом (в bind-позе): ${skel}`);
  if (grass) info.push(`Трава: ${grass === grassAll ? grass : `${grass} из ${grassAll} (прорежена)`} экземпляров, LOD${GRASS_LOD} (меши «Трава · …»)`);
  if (vegNotes.length) info.push(`Трава пропущена: ${vegNotes.slice(0, 3).join('; ')}`);
  if (wires) info.push(`Провода: ${wires}`);
  if (lights.length || particles.length) info.push(`Метки (скрыты): источники света ${lights.length}, частицы ${particles.length} — эффекты не воспроизводятся`);
  if (missing.size) info.push(`Модели не найдены: ${missing.size} (${[...missing].slice(0, 3).join(', ')}${missing.size > 3 ? '…' : ''})`);
  if (matMissing.size) info.push(`Не найдены материалы: ${matMissing.size}`);
  return { meshes, instances: B.scene, skeleton: null, motions: [], bounds: boundsOf(meshes), info, flipZ: true };
}

