// Уровни Far Cry (CryEngine 1): файл редактора `<уровень>.cry` (ZIP) рядом с `level.pak`.
// Из .cry: `level.editor_xml` (ландшафт — размер и шаг, уровень воды; объекты Brush с путём .cgf, сущности с моделью
// в свойствах, сущности-прототипы из Editor/EntityLibrary; описания растительности), `heightmapdataw.editor_data`
// (u16 высоты, ÷256 — метры, индекс [x·N + y]) и `vegetationinstancesarray.editor_data` (записи по 19 байт: x, y, z,
// масштаб f32, u8 номер растения, u8 яркость, u8). Цвет ландшафта — `terrain/cover_low.dds` из `level.pak`.
// Сверено: высоты объектов и растений совпадают с ландшафтом (медиана расхождения 0,1 м).
import { openZip } from '../../core/archives/zip';
import { boundsOf } from '../../core/geometry';
import { decodeDDS } from '../../core/images/dds';
import { LevelBuilder } from '../../core/levelbuilder';
import { decodeText, normPath, toArrayBuffer } from '../../core/binary';
import type { LoadContext } from '../../core/plugin';
import type { Archive, DecodedImage, Mesh, Model, VFile } from '../../core/types';
import { cry1Model } from './cry1';

/** Атрибуты тега XML. */
export function xmlAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = m[2]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return out;
}

export interface Fc1Object { type: string; name: string; model: string; pos: number[]; angles: number[]; scale: number[]; layer: string; hidden: boolean }
export interface Fc1Veg { index: number; file: string; hidden: boolean }
export interface Fc1Editor { size: number; unit: number; water: number; objects: Fc1Object[]; vegetation: Map<number, Fc1Veg>; libraries: string[] }

const vec = (s: string | undefined, def: number[]): number[] => { const v = (s ?? '').split(',').map(Number); return v.length === 3 && v.every(Number.isFinite) ? v : def; };

/** Разбор level.editor_xml: ландшафт, объекты (модель по типу), растительность, библиотеки прототипов. */
export function parseEditorXml(x: string, prototypes: Map<string, string> = new Map()): Fc1Editor {
  const hm = xmlAttrs(/<Heightmap [^>]*>/.exec(x)?.[0] ?? '');
  const li = xmlAttrs(/<LevelInfo [^>]*>/.exec(x)?.[0] ?? '');
  const size = +(hm.Width ?? li.HeightmapSize ?? 1024) || 1024, unit = +(hm.UnitSize ?? li.HeightmapUnitSize ?? 2) || 2, water = +(hm.WaterLevel ?? li.WaterLevel ?? 0) || 0;
  const objects: Fc1Object[] = [];
  const re = /<Object\s[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  const vegetation = new Map<number, Fc1Veg>();
  // раздел растительности — описания растений (у них FileName и Index)
  const vegSec = /<Vegetation(?:Map)?\s*>([\s\S]*?)<\/Vegetation(?:Map)?>/.exec(x)?.[1] ?? '';
  for (const t of vegSec.matchAll(/<Object\s[^>]*>/g)) { const a = xmlAttrs(t[0]); if (a.FileName && a.Index !== undefined) vegetation.set(+a.Index, { index: +a.Index, file: a.FileName, hidden: a.Hidden === '1' }); }
  while ((m = re.exec(x))) {
    const a = xmlAttrs(m[0]), type = a.Type ?? '';
    if (!type || type === 'AIPoint' || type === 'TagPoint') continue;
    let model = '';
    if (type === 'Brush') model = a.Prefab ?? '';
    else if (type === 'Entity' || type === 'SimpleEntity') {
      if (m[1] !== '/') {
        // свойства сущности — до её закрывающего тега (вложенных Object нет)
        const end = x.indexOf('</Object>', m.index), body = x.slice(m.index, end < 0 ? m.index + 4000 : end);
        const props = /<Properties\s[^>]*>/.exec(body)?.[0];
        if (props) model = Object.values(xmlAttrs(props)).find((v) => /\.cg[af]$/i.test(v)) ?? '';
      }
      if (!model && a.Geometry) model = a.Geometry;
    } else if (type === 'PrototypeEntity') model = prototypes.get((a.Prototype ?? '').toUpperCase()) ?? '';
    if (!model || !/\.cg[af]$/i.test(model)) continue;
    objects.push({ type, name: a.Name ?? '', model, pos: vec(a.Pos, [0, 0, 0]), angles: vec(a.Angles, [0, 0, 0]), scale: vec(a.Scale, [1, 1, 1]), layer: a.Layer ?? '', hidden: a.HiddenInGame === '1' });
  }
  const libraries = [...x.matchAll(/<Library Name="([^"]+)"/g)].map((l) => l[1]!);
  return { size, unit, water, objects, vegetation, libraries };
}

/** Прототипы сущностей из библиотеки (Editor/EntityLibrary/*.xml): GUID → модель. */
export function parsePrototypes(x: string, out = new Map<string, string>()): Map<string, string> {
  for (const m of x.matchAll(/<EntityPrototype\s[^>]*>[\s\S]*?(?=<EntityPrototype\s|$)/g)) {
    const id = xmlAttrs(/<EntityPrototype\s[^>]*>/.exec(m[0])![0]).Id, props = /<Properties\s[^>]*>/.exec(m[0])?.[0];
    const model = props ? Object.values(xmlAttrs(props)).find((v) => /\.cg[af]$/i.test(v)) : undefined;
    if (id && model) out.set(id.toUpperCase(), model);
  }
  return out;
}

/** Записи растений: x, y, z, масштаб, номер растения. */
export function parseVegetation(u: Uint8Array): Array<{ x: number; y: number; z: number; s: number; i: number }> {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), n = Math.floor(u.length / 19), out = [];
  for (let k = 0; k < n; k++) { const o = k * 19; out.push({ x: dv.getFloat32(o, true), y: dv.getFloat32(o + 4, true), z: dv.getFloat32(o + 8, true), s: dv.getFloat32(o + 12, true), i: u[o + 16]! }); }
  return out;
}

/** Матрица объекта: перенос · Rz · Ry · Rx (углы в градусах) · масштаб, column-major. */
export function objectMatrix(pos: number[], ang: number[], scl: number[]): number[] {
  const [ax, ay, az] = ang.map((d) => (d * Math.PI) / 180) as [number, number, number];
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  const R = [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
  const M = new Array(16).fill(0);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) M[c * 4 + r] = R[r * 3 + c]! * scl[c]!;
  M[12] = pos[0]; M[13] = pos[1]; M[14] = pos[2]; M[15] = 1;
  return M;
}

/** Сетка ландшафта с шагом step клеток; UV — по всей карте (цветовая текстура уровня). */
export function terrainMesh(h: Uint16Array, size: number, unit: number, step: number, image: DecodedImage | null): Mesh {
  const n = Math.floor(size / step) + 1, nv = n * n, pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const H = (i: number, j: number) => h[Math.min(size - 1, i) * size + Math.min(size - 1, j)]! / 256;
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
    const i = a * step, j = b * step, v = a * n + b;
    pos[v * 3] = i * unit; pos[v * 3 + 1] = j * unit; pos[v * 3 + 2] = H(i, j);
    const dx = H(i + step, j) - H(Math.max(0, i - step), j), dy = H(i, j + step) - H(i, Math.max(0, j - step)), k = 2 * step * unit;
    const nx = -dx / k, ny = -dy / k, l = Math.hypot(nx, ny, 1);
    nor[v * 3] = nx / l; nor[v * 3 + 1] = ny / l; nor[v * 3 + 2] = 1 / l;
    uv[v * 2] = j / size; uv[v * 2 + 1] = i / size;
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let p = 0;
  for (let a = 0; a + 1 < n; a++) for (let b = 0; b + 1 < n; b++) {
    const v = a * n + b;
    idx[p++] = v; idx[p++] = v + n; idx[p++] = v + n + 1; idx[p++] = v; idx[p++] = v + n + 1; idx[p++] = v + 1;
  }
  return { name: 'Ландшафт', texture: image ? 'terrain/cover_low.dds' : '', vertexCount: nv, pos, nor, uv, bone: new Float32Array(0), weight: new Float32Array(0), indices: idx, skinned: false, ...(image ? { image } : { color: [0.45, 0.42, 0.3] }) };
}

/** Вода: квадраты 32 м там, где ландшафт ниже уровня воды (и полоса вокруг карты). */
export function waterMesh(h: Uint16Array, size: number, unit: number, level: number): Mesh | null {
  const cell = Math.max(1, Math.round(32 / unit)), P: number[] = [], I: number[] = [], S = size * unit, border = S * 0.25;
  const quad = (x0: number, y0: number, x1: number, y1: number) => { const v = P.length / 3; P.push(x0, y0, level, x1, y0, level, x0, y1, level, x1, y1, level); I.push(v, v + 1, v + 3, v, v + 3, v + 2); };
  for (let i = 0; i < size; i += cell) for (let j = 0; j < size; j += cell) {
    let lo = Infinity;
    for (let a = i; a <= Math.min(size - 1, i + cell); a += 2) for (let b = j; b <= Math.min(size - 1, j + cell); b += 2) lo = Math.min(lo, h[a * size + b]! / 256);
    if (lo < level) quad(i * unit, j * unit, (i + cell) * unit, (j + cell) * unit);
  }
  if (!I.length) return null;
  quad(-border, -border, S + border, 0); quad(-border, S, S + border, S + border); quad(-border, 0, 0, S); quad(S, 0, S + border, S);
  const nv = P.length / 3, nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let i = 0; i < nv; i++) nor[i * 3 + 2] = 1;
  return { name: 'Вода', texture: '', color: [0.16, 0.3, 0.4], vertexCount: nv, pos: Float32Array.from(P), nor, uv, bone: new Float32Array(0), weight: new Float32Array(0),
    indices: nv > 65535 ? Uint32Array.from(I) : Uint16Array.from(I), skinned: false, vertexAlpha: new Float32Array(nv).fill(0.6) };
}

/** Бюджет треугольников растительности (прореживание по экземплярам, детерминированно). */
const VEG_BUDGET = 2_500_000;

export async function loadFc1Level(main: VFile, ctx: LoadContext): Promise<Model> {
  const buf = await main.arrayBuffer();
  const cry = await openZip(Object.assign(new Blob([buf]), { name: main.name }));
  const get = async (name: string) => { const e = cry.lookup(name) ?? cry.entries.find((x) => x.path.toLowerCase() === name) ?? null; return e ? cry.read(e) : null; };
  const xmlBytes = await get('level.editor_xml');
  if (!xmlBytes) throw new Error(`${main.name}: нет level.editor_xml — это не файл уровня Far Cry`);
  const xml = decodeText(xmlBytes);
  // прототипы сущностей — из библиотек редактора игры
  const protos = new Map<string, string>();
  for (const lib of [...xml.matchAll(/<Library Name="([^"]+)"/g)].map((l) => l[1]!)) {
    const t = await ctx.readPath(normPath(`editor/entitylibrary/${lib}.xml`));
    if (t) parsePrototypes(decodeText(t), protos);
  }
  // внешние слои объектов: layers/<имя>.lyr рядом с .cry (слои «не для экспорта» — только редактор, пропускаются)
  const dir0 = (main.path ?? '').replace(/[^/]*$/, ''), extra: string[] = [];
  let extLayers = 0;
  for (const t of xml.matchAll(/<Layer\s[^>]*External="1"[^>]*>/g)) {
    const a = xmlAttrs(t[0]);
    if (!a.Name || a.Exportable === '0') continue;
    const e = main.archive?.lookup(`${dir0}layers/${a.Name.toLowerCase()}.lyr`);
    if (e) { extra.push(decodeText(await main.archive!.read(e))); extLayers++; }
  }
  const ed = parseEditorXml(extra.length ? xml + '\n' + extra.join('\n') : xml, protos);
  const info: string[] = [`Уровень Far Cry: ${main.name} — ландшафт ${ed.size}×${ed.size} × ${ed.unit} м, вода ${ed.water} м${extLayers ? `, внешних слоёв объектов: ${extLayers}` : ''}`];

  // высоты: из .cry, иначе из level.pak
  const dir = dir0;
  let pak: Archive | null = null;
  const arc = main.archive, pe = arc?.lookup(dir + 'level.pak');
  if (arc && pe) { const b = arc.blobOf?.(pe); try { pak = b ? await openZip(b) : await openZip(Object.assign(new Blob([toArrayBuffer(await arc.read(pe))]), { name: 'level.pak' })); } catch { pak = null; } }
  const fromPak = async (p: string) => { const e = pak?.lookup(p); return e ? pak!.read(e) : null; };
  const hRaw = (await get('heightmapdataw.editor_data')) ?? (await fromPak('terrain/land_map.h16'));
  const meshes: Mesh[] = [];
  let hm: Uint16Array | null = null;
  if (hRaw && hRaw.length >= ed.size * ed.size * 2) {
    hm = new Uint16Array(toArrayBuffer(hRaw.subarray(0, ed.size * ed.size * 2)));
    let img: DecodedImage | null = null;
    const cover = await fromPak('terrain/cover_low.dds');
    if (cover) try { img = decodeDDS(toArrayBuffer(cover)); } catch { img = null; }
    meshes.push(terrainMesh(hm, ed.size, ed.unit, ed.size > 512 ? 2 : 1, img));
    const w = waterMesh(hm, ed.size, ed.unit, ed.water);
    if (w) meshes.push(w);
    info.push(`Цвет ландшафта: ${img ? `${img.width}×${img.height} (level.pak)` : 'нет (не найден level.pak рядом)'}`);
  } else info.push('Нет карты высот');

  // модели (по пути, один раз)
  const B = new LevelBuilder(), cache = new Map<string, { pi: number; parts: Mesh[] } | null>(), missing = new Set<string>();
  const proto = async (path: string, kind: string): Promise<{ pi: number; parts: Mesh[] } | null> => {
    const key = normPath(path.replace(/\\/g, '/')).replace(/\/{2,}/g, '/');
    if (cache.has(key + '|' + kind)) return cache.get(key + '|' + kind)!;
    let r: { pi: number; parts: Mesh[] } | null = null;
    try {
      const u = await ctx.readPath(key);
      if (u) {
        const m = cry1Model(toArrayBuffer(u), key.split('/').pop()!);
        const parts = m.meshes.filter((p) => !p.defaultHidden);
        if (parts.length) r = { pi: B.proto(key, parts, kind, (p) => `${kind === 'veg' ? 'растения' : 'объекты'} · ${(p.texture || p.name).split('/').pop()}`), parts };
      } else missing.add(key);
    } catch { missing.add(key); }
    cache.set(key + '|' + kind, r);
    return r;
  };
  let placed = 0;
  for (const o of ed.objects) {
    if (o.hidden) continue;
    const p = await proto(o.model, 'obj');
    if (!p) continue;
    B.place(p.pi, p.parts, objectMatrix(o.pos, o.angles, o.scale), o.name, o.layer || o.type);
    placed++;
  }
  info.push(`Объектов: ${placed} из ${ed.objects.length} (Brush ${ed.objects.filter((o) => o.type === 'Brush').length}, сущности с моделью ${ed.objects.filter((o) => o.type !== 'Brush').length})`);

  // растительность
  const vegRaw = await get('vegetationinstancesarray.editor_data');
  if (vegRaw && hm) {
    const list = parseVegetation(vegRaw), byType = new Map<number, typeof list>();
    for (const v of list) { const d = ed.vegetation.get(v.i); if (!d || d.hidden) continue; let l = byType.get(v.i); if (!l) byType.set(v.i, (l = [])); l.push(v); }
    // бюджет: доля экземпляров одинакова для всех растений
    let total = 0;
    const protosV = new Map<number, { pi: number; parts: Mesh[]; tris: number }>();
    for (const [i, l] of byType) {
      const p = await proto(ed.vegetation.get(i)!.file, 'veg');
      if (!p) continue;
      const tris = p.parts.reduce((a, x) => a + x.indices.length / 3, 0);
      protosV.set(i, { ...p, tris }); total += tris * l.length;
    }
    // бюджет «наливом»: редкие растения (деревья) целиком, массовые (трава, кусты) прореживаются поровну
    const keepOf = new Map<number, number>();
    let left = VEG_BUDGET, types = [...protosV.keys()].sort((a, b) => protosV.get(a)!.tris * byType.get(a)!.length - protosV.get(b)!.tris * byType.get(b)!.length);
    while (types.length) {
      const share = left / types.length, i = types[0]!, cost = protosV.get(i)!.tris * byType.get(i)!.length;
      if (cost <= share) { keepOf.set(i, 1); left -= cost; types = types.slice(1); continue; }
      for (const t of types) keepOf.set(t, Math.max(0, share / (protosV.get(t)!.tris * byType.get(t)!.length)));
      break;
    }
    const keep = Math.min(...keepOf.values(), 1);
    let n = 0, all = 0;
    for (const [i, l] of byType) {
      const p = protosV.get(i);
      if (!p) continue;
      const name = ed.vegetation.get(i)!.file.split(/[\\/]/).pop()!;
      l.forEach((v, k) => {
        all++;
        const kp = keepOf.get(i) ?? 1;
        if (kp < 1 && ((k * 2654435761) >>> 0) / 4294967296 >= kp) return;
        const gi = Math.floor(v.x / ed.unit), gj = Math.floor(v.y / ed.unit);
        const z = v.z || (gi >= 0 && gj >= 0 && gi < ed.size && gj < ed.size ? hm![gi * ed.size + gj]! / 256 : 0);
        const s = v.s > 0 ? v.s : 1;
        B.place(p.pi, p.parts, [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, v.x, v.y, z, 1], name, 'Растительность');
        n++;
      });
    }
    info.push(`Растительность: ${n} из ${all}${keep < 1 ? ` (массовые растения прорежены до ${Math.max(1, Math.round(keep * 100))} % — бюджет ${VEG_BUDGET / 1e6} млн треугольников)` : ''}, видов ${protosV.size}`);
  }
  if (missing.size) info.push(`Не найдено моделей: ${missing.size} (${[...missing].slice(0, 5).join(', ')}${missing.size > 5 ? '…' : ''})`);
  const terrainTris = meshes.reduce((a, m) => a + m.indices.length / 3, 0);
  const all = [...B.build(), ...meshes]; // собранные из экземпляров — первыми (номера мешей сцены)
  info.push(`Треугольников: ${Math.round(B.tris + terrainTris).toLocaleString('ru')}`);
  if (!all.length) throw new Error(`${main.name}: в уровне нет ни ландшафта, ни объектов`);
  return { meshes: all, instances: B.scene, skeleton: null, motions: [], bounds: boundsOf(all), flipZ: false, defaultZUp: true, cameraYaw: 0, info };
}
