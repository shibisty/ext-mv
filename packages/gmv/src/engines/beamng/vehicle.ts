// Сборка машины BeamNG.drive по конфигурации .pc: дерево слотов jbeam -> выбранные детали -> flexbody-меши из .dae.
// Положение мешей: pos/rot/scale flexbody + nodeOffset слота (смещение узлов детали; X зеркалится по стороне меша).
import { decodeText } from '../../core/binary';
import { boundsOf, sumTris, sumVerts } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import type { Archive, ArchiveEntry, Mesh, Model, SurfaceInfo, VFile } from '../../core/types';
import { parseCollada, type ColladaMesh } from '../collada/collada';
import { evalNumber, evalValue, parseJbeam, type JValue, type Vars } from './jbeam';

type Obj = { [k: string]: JValue };
const isObj = (v: JValue | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export interface JPart { name: string; slotType: string; data: Obj; file: string }
interface Slot { type: string; def: string; opts: Obj | null }
interface Chosen { part: JPart; offsets: Obj[] }
export interface Flexbody { mesh: string; part: string; opts: Obj | null; offsets: Obj[] }

/** Строки таблицы jbeam: первая — заголовок, словари между строками — модификаторы (пропускаем). */
function rows(v: JValue | undefined): JValue[][] {
  if (!Array.isArray(v)) return [];
  return v.slice(1).filter((r): r is JValue[] => Array.isArray(r));
}
const lastObj = (r: JValue[]): Obj | null => { for (let k = r.length - 1; k >= 0; k--) if (isObj(r[k])) return r[k] as Obj; return null; };

export function slotsOf(part: JPart): Slot[] {
  const out: Slot[] = [];
  for (const r of rows(part.data.slots)) out.push({ type: String(r[0] ?? ''), def: String(r[1] ?? ''), opts: lastObj(r) });
  // slots2: ["name", "allowTypes", "denyTypes", "default", "description"]
  for (const r of rows(part.data.slots2)) {
    const allow = Array.isArray(r[1]) ? (r[1] as JValue[]).map(String) : [String(r[0] ?? '')];
    for (const t of allow.length ? allow : [String(r[0] ?? '')]) out.push({ type: String(r[0] ?? t), def: String(r[3] ?? ''), opts: lastObj(r) });
  }
  return out;
}

/** Все детали из jbeam-файлов архивов (папка vehicles/ мода и, если открыта, игры). */
export async function collectParts(archives: readonly Archive[]): Promise<Map<string, JPart>> {
  const parts = new Map<string, JPart>();
  for (const a of archives)
    for (const e of a.entries) {
      if (!e.path.endsWith('.jbeam')) continue;
      let data: JValue;
      try { data = parseJbeam(decodeText(await a.read(e))); } catch { continue; }
      if (!isObj(data)) continue;
      for (const [name, v] of Object.entries(data)) if (isObj(v) && !parts.has(name)) parts.set(name, { name, slotType: String(v.slotType ?? ''), data: v, file: e.path });
    }
  return parts;
}

export interface Assembly { chosen: Chosen[]; flexbodies: Flexbody[]; missing: string[]; substituted: string[]; vars: Vars }

/** Обход дерева слотов от главной детали. pcParts: slotType -> имя детали ("" — пусто). */
export function assemble(parts: Map<string, JPart>, mainPart: string, pcParts: Record<string, string>, pcVars: Record<string, JValue> = {}): Assembly {
  const chosen: Chosen[] = [], missing: string[] = [], substituted: string[] = [], seen = new Set<string>();
  const bySlot = new Map<string, string[]>();
  for (const p of parts.values()) { if (!bySlot.has(p.slotType)) bySlot.set(p.slotType, []); bySlot.get(p.slotType)!.push(p.name); }
  const visit = (name: string, offsets: Obj[]) => {
    if (!name || seen.has(name)) return;
    const part = parts.get(name);
    if (!part) { missing.push(name); return; }
    seen.add(name);
    chosen.push({ part, offsets });
    for (const s of slotsOf(part)) {
      const pick = Object.prototype.hasOwnProperty.call(pcParts, s.type) ? pcParts[s.type]! : s.def;
      const off = s.opts && isObj(s.opts.nodeOffset) ? [...offsets, s.opts.nodeOffset as Obj] : offsets;
      // деталь из .pc не найдена (общая деталь игры) — берём деталь слота по умолчанию из мода
      // а если и её нет — первую деталь мода с тем же slotType (колёса, шины из общих файлов игры)
      if (pick && !parts.has(pick)) {
        const alt = parts.has(s.def) ? s.def : bySlot.get(s.type)?.[0];
        if (alt) { substituted.push(`${pick} → ${alt}`); visit(alt, off); continue; }
      }
      visit(pick, off);
    }
  };
  visit(mainPart, []);
  // переменные: значения по умолчанию из выбранных деталей, затем из .pc
  const vars: Vars = new Map();
  for (const c of chosen) {
    const tbl = c.part.data.variables;
    if (!Array.isArray(tbl) || !Array.isArray(tbl[0])) continue;
    const head = (tbl[0] as JValue[]).map(String), iName = head.indexOf('name'), iDef = head.indexOf('default');
    for (const r of rows(tbl)) if (iName >= 0 && iDef >= 0) vars.set(String(r[iName]), (r[iDef] ?? null) as never);
  }
  for (const [k, v] of Object.entries(pcVars)) vars.set(k, v as never);
  const flexbodies: Flexbody[] = [];
  for (const c of chosen)
    for (const r of rows(c.part.data.flexbodies)) {
      if (typeof r[0] !== 'string' || !r[0]) continue;
      flexbodies.push({ mesh: r[0], part: c.part.name, opts: lastObj(r), offsets: c.offsets });
    }
  return { chosen, flexbodies, missing, substituted, vars };
}

const vec = (o: JValue | undefined, vars: Vars, def: number): [number, number, number] =>
  isObj(o) ? [evalNumber(o.x, vars, def), evalNumber(o.y, vars, def), evalNumber(o.z, vars, def)] : [def, def, def];

/** Поворот в градусах: сначала X, затем Y, затем Z. */
function rotMat([rx, ry, rz]: number[]): number[] {
  const [a, b, c] = [rx!, ry!, rz!].map((d) => (d * Math.PI) / 180) as [number, number, number];
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // Rz·Ry·Rx, строки
  return [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa, sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa, -sb, cb * sa, cb * ca];
}

/** Копия меша с преобразованием flexbody и смещением узлов. */
export function placeMesh(src: ColladaMesh, fb: Flexbody, vars: Vars): Mesh {
  const o = fb.opts, pos = vec(o?.pos, vars, 0), rot = vec(o?.rot, vars, 0), scl = vec(o?.scale, vars, 1), R = rotMat(rot);
  const n = src.vertexCount, P = new Float32Array(n * 3), N = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const x = src.pos[v * 3]! * scl[0], y = src.pos[v * 3 + 1]! * scl[1], z = src.pos[v * 3 + 2]! * scl[2];
    P[v * 3] = R[0]! * x + R[1]! * y + R[2]! * z + pos[0];
    P[v * 3 + 1] = R[3]! * x + R[4]! * y + R[5]! * z + pos[1];
    P[v * 3 + 2] = R[6]! * x + R[7]! * y + R[8]! * z + pos[2];
    const a = src.nor[v * 3]!, b = src.nor[v * 3 + 1]!, c = src.nor[v * 3 + 2]!;
    N[v * 3] = R[0]! * a + R[1]! * b + R[2]! * c; N[v * 3 + 1] = R[3]! * a + R[4]! * b + R[5]! * c; N[v * 3 + 2] = R[6]! * a + R[7]! * b + R[8]! * c;
  }
  // nodeOffset слотов: X — наружу по стороне вершины (узлы смещаются на x·sign(x узла)), Y/Z — как есть.
  // Меш ступиц часто один на обе стороны, поэтому знак берётся по каждой вершине.
  let ox = 0, oy = 0, oz = 0;
  for (const off of fb.offsets) { const [x, y, z] = vec(off, vars, 0); ox += x; oy += y; oz += z; }
  if (ox || oy || oz) for (let v = 0; v < n; v++) { const x = P[v * 3]!; P[v * 3] = x + Math.sign(x) * ox; P[v * 3 + 1] += oy; P[v * 3 + 2] += oz; }
  return { ...src, name: `${fb.mesh} · ${fb.part}`, pos: P, nor: N };
}

export interface PcFile { parts: Record<string, string>; vars: Record<string, JValue>; mainPartName?: string; model?: string; paints?: Array<{ baseColor?: number[] }> }

export async function loadVehicle(main: VFile, ctx: LoadContext): Promise<Model> {
  const pc = parseJbeam(decodeText(await main.arrayBuffer())) as unknown as PcFile;
  if (!pc || typeof pc !== 'object' || !pc.parts) throw new Error('Не конфигурация BeamNG (.pc): нет "parts"');
  const archives = [...ctx.archives];
  if (main.archive && !archives.includes(main.archive)) archives.push(main.archive);
  const parts = await collectParts(archives);
  if (!parts.size) throw new Error('Не найдено ни одного .jbeam — откройте мод целиком («Папка игры…» или zip)');
  const model = pc.model ?? (main.path ? /vehicles\/([^/]+)\//.exec(main.path)?.[1] : undefined) ?? '';
  let mainPart = pc.mainPartName ?? '';
  if (!parts.has(mainPart)) mainPart = [...parts.values()].find((p) => p.slotType === 'main' && p.file.includes(`/vehicles/${model.toLowerCase()}/`))?.name ?? [...parts.values()].find((p) => p.slotType === 'main')?.name ?? '';
  if (!mainPart) throw new Error('Не найдена главная деталь (slotType "main")');
  const asm = assemble(parts, mainPart, pc.parts, pc.vars ?? {});
  const wanted = new Set(asm.flexbodies.map((f) => f.mesh.toLowerCase()));

  // меши: .dae из тех же архивов, где встречаются нужные имена узлов
  const byName = new Map<string, ColladaMesh[]>();
  const daes: Array<[Archive, ArchiveEntry]> = [];
  for (const a of archives) for (const e of a.entries) if (e.path.endsWith('.dae')) daes.push([a, e]);
  const vehDir = `/vehicles/${model.toLowerCase()}/`;
  daes.sort((x, y) => +y[1].path.includes(vehDir) - +x[1].path.includes(vehDir)); // сначала папка машины
  for (const [a, e] of daes) {
    if ([...wanted].every((w) => byName.has(w))) break;
    const xml = decodeText(await a.read(e)), low = xml.toLowerCase();
    const need = new Set([...wanted].filter((w) => !byName.has(w) && (low.includes(`name="${w}"`) || low.includes(`id="${w}"`))));
    if (!need.size) continue;
    for (const m of parseCollada(xml, { nodes: need }).meshes) {
      const k = m.nodeName.toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k)!.push(m);
    }
  }
  const paint = pc.paints?.[0]?.baseColor;
  const mats = await collectMaterials(archives);
  const meshes: Mesh[] = [], noMesh = new Set<string>();
  for (const fb of asm.flexbodies) {
    const src = byName.get(fb.mesh.toLowerCase());
    if (!src) { noMesh.add(fb.mesh); continue; }
    for (const m of src) {
      const pm = placeMesh(m, fb, asm.vars), mt = mats.get((m.material ?? '').toLowerCase());
      // без карты цвета: множитель материала, иначе цвет покраски из .pc
      if (mt?.normal) pm.normalMap = mt.normal;
      if (mt?.surface) pm.surface = mt.surface;
      if (mt?.color) pm.texture = mt.color;
      else pm.color = (mt?.factor ?? paint ?? [0.7, 0.7, 0.7]).slice(0, 3).map((x) => Math.min(1, x));
      meshes.push(pm);
    }
  }
  if (!meshes.length) throw new Error(`Ни один меш не найден в .dae (нужно ${wanted.size}: ${[...wanted].slice(0, 5).join(', ')}…)`);
  const info = [
    `BeamNG: ${model} (${main.name}), деталей ${asm.chosen.length}, мешей ${meshes.length}, вершин ${sumVerts(meshes)}, треугольников ${sumTris(meshes)}`,
    'Пропсы (руль, приборы, фары-источники) и деформация пока не показываются.',
  ];
  if (asm.missing.length) info.push(`Нет деталей (в моде не хватает файлов игры?): ${asm.missing.slice(0, 8).join(', ')}${asm.missing.length > 8 ? '…' : ''}`);
  if (asm.substituted.length) info.push(`Заменены деталями слота по умолчанию: ${asm.substituted.slice(0, 6).join(', ')}${asm.substituted.length > 6 ? '…' : ''}`);
  if (noMesh.size) info.push(`Нет мешей в .dae: ${[...noMesh].slice(0, 8).join(', ')}${noMesh.size > 8 ? '…' : ''}`);
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: false, defaultZUp: true, cameraYaw: 0, info,
    meta: { beamng: { model, parts: asm.chosen.map((c) => c.part.name) } } };
}

// ---------- материалы (*.materials.json, materials.cs) ----------
/** color — карта цвета (пусто, если только цвет-множитель или заглушка generic_*); factor — baseColorFactor слоя 0. */
export interface MaterialTex { color: string; factor?: number[]; normal?: string; surface?: SurfaceInfo }
const PLACEHOLDER = /(^|\/)(null|generic_[a-z]*|white)(\.[a-z]+)*\.(dds|png|jpe?g|tga)$/i;
const putMat = (out: Map<string, MaterialTex>, names: Array<string | undefined>, t: MaterialTex) => {
  for (const name of names) if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), t);
};
export function readMaterialsJson(text: string, out: Map<string, MaterialTex>): void {
  let j: JValue;
  try { j = parseJbeam(text); } catch { return; }
  if (!isObj(j)) return;
  for (const [key, v] of Object.entries(j)) {
    if (!isObj(v)) continue;
    let color = '', factor: number[] | undefined, normal = '', surface: SurfaceInfo | undefined;
    const stages = Array.isArray(v.Stages) ? (v.Stages as JValue[]) : [];
    for (const s of stages) {
      if (!isObj(s)) continue;
      if (!surface) surface = pbrOf(s);
      if (!normal && typeof s.normalMap === 'string' && s.normalMap && !/generic_n|null\./i.test(s.normalMap)) normal = s.normalMap;
      if (!factor && Array.isArray(s.baseColorFactor)) factor = (s.baseColorFactor as JValue[]).slice(0, 3).map(Number);
      for (const k of ['baseColorMap', 'colorMap', 'diffuseMap']) {
        const p = s[k];
        if (typeof p === 'string' && p && !PLACEHOLDER.test(p)) { color = p; break; }
      }
      if (color) break;
    }
    if (!color && typeof v.diffuseMap === 'string' && !PLACEHOLDER.test(v.diffuseMap)) color = v.diffuseMap;
    if (!color && !factor) continue;
    putMat(out, [key, typeof v.mapTo === 'string' ? v.mapTo : '', typeof v.name === 'string' ? v.name : ''], { color, factor, ...(normal ? { normal } : {}), ...(surface ? { surface } : {}) });
  }
}
/** PBR стадии материала BeamNG (v1.5): отдельные одноканальные карты и множители. */
function pbrOf(s: Obj): SurfaceInfo | undefined {
  const map = (k: string) => (typeof s[k] === 'string' && s[k] && !/null\./i.test(s[k] as string) ? { map: s[k] as string, channel: 0 as const } : undefined);
  const num = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : undefined);
  const out: SurfaceInfo = { roughness: map('roughnessMap'), metallic: map('metallicMap'), ao: map('ambientOcclusionMap'), roughnessFactor: num('roughnessFactor'), metallicFactor: num('metallicFactor'), source: 'BeamNG' };
  return out.roughness || out.metallic || out.ao || out.roughnessFactor !== undefined || out.metallicFactor !== undefined ? out : undefined;
}
/** Старый формат TorqueScript: singleton Material(name) { mapTo = "x"; diffuseMap[0] = "…"; } */
export function readMaterialsCs(text: string, out: Map<string, MaterialTex>): void {
  const re = /(?:singleton|new)\s+Material\s*\(\s*([\w.]+)\s*\)\s*\{([\s\S]*?)\n\s*\};?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[2]!, mapTo = /mapTo\s*=\s*"([^"]*)"/.exec(body)?.[1];
    const maps = [...body.matchAll(/(?:diffuseMap|colorMap|baseColorMap)\s*(?:\[\s*(\d+)\s*\])?\s*=\s*"([^"]*)"/g)]
      .map((x) => ({ layer: +(x[1] ?? 0), path: x[2]! })).filter((x) => x.path && !PLACEHOLDER.test(x.path)).sort((a, b) => a.layer - b.layer);
    const f = /(?:baseColorFactor|diffuseColor)\s*(?:\[\s*0\s*\])?\s*=\s*"([^"]*)"/.exec(body)?.[1]?.trim().split(/\s+/).map(Number);
    const factor = f && f.length >= 3 && f.every(Number.isFinite) ? f.slice(0, 3) : undefined;
    if (!maps.length && !factor) continue;
    const normal = [...body.matchAll(/normalMap\s*(?:\[\s*(\d+)\s*\])?\s*=\s*"([^"]*)"/g)].map((x) => x[2]!).find((n) => n && !/generic_n|null\./i.test(n));
    const csMap = (k: string) => { const v = new RegExp(`${k}\\s*\\[\\s*0\\s*\\]\\s*=\\s*"([^"]*)"`).exec(body)?.[1]; return v && !/null\./i.test(v) ? { map: v, channel: 0 as const } : undefined; };
    const csNum = (k: string) => { const v = new RegExp(`${k}\\s*\\[\\s*0\\s*\\]\\s*=\\s*"([\\d.]+)"`).exec(body)?.[1]; return v !== undefined ? +v : undefined; };
    const sf: SurfaceInfo = { roughness: csMap('roughnessMap'), metallic: csMap('metallicMap'), ao: csMap('ambientOcclusionMap'), roughnessFactor: csNum('roughnessFactor'), metallicFactor: csNum('metallicFactor'), source: 'BeamNG' };
    const surface = sf.roughness || sf.metallic || sf.ao || sf.roughnessFactor !== undefined || sf.metallicFactor !== undefined ? sf : undefined;
    putMat(out, [m[1]!, mapTo], { color: maps[0]?.path ?? '', factor, ...(normal ? { normal } : {}), ...(surface ? { surface } : {}) });
  }
}

/** Все материалы из открытых архивов (json важнее cs: читаем json первым). */
export async function collectMaterials(archives: readonly Archive[]): Promise<Map<string, MaterialTex>> {
  const out = new Map<string, MaterialTex>();
  for (const pass of ['json', 'cs'] as const)
    for (const a of archives)
      for (const e of a.entries) {
        const ok = pass === 'json' ? /materials\.json$/.test(e.path) : /(^|\/)materials\.cs$/.test(e.path);
        if (!ok) continue;
        const text = decodeText(await a.read(e));
        if (pass === 'json') readMaterialsJson(text, out); else readMaterialsCs(text, out);
      }
  return out;
}
export { evalValue };
