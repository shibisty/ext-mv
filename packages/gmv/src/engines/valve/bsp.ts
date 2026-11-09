// Карты Source BSP (VBSP): VTMB v17 (грань 104 байта, 8 стилей света), HL2/CS:S v19–20 (грань 56 байт).
// Геометрия брашей и дисплейсментов по материалам, карта освещения (атлас RGB), статический и «энтити»-реквизит (.mdl).
import { boundsOf } from '../../core/geometry';
import { LevelBuilder } from '../../core/levelbuilder';
import { openZip } from '../../core/archives/zip';
import type { LoadContext } from '../../core/plugin';
import type { Archive, BlobFile, Mesh, Model, ScreenFx, VFile } from '../../core/types';
import { bakePose, loadMdlByPath, pickIdle } from './mdl';
import { matStem, vmtInfo, vmtKey } from './vmt';

const SURF_SKY2D = 0x2, SURF_SKY = 0x4, SURF_TRIGGER = 0x40, SURF_NODRAW = 0x80, SURF_HINT = 0x100, SURF_SKIP = 0x200, SURF_BUMPLIGHT = 0x800;

interface Face { plane: number; side: number; firstEdge: number; numEdges: number; texinfo: number; disp: number; lightofs: number; lmMins: [number, number]; lmSize: [number, number] }
interface Batch { pos: number[]; nor: number[]; uv: number[]; uv2: number[]; idx: number[]; alpha: number[] }
type Ent = Map<string, string>;

function parseEntities(text: string): Ent[] {
  const out: Ent[] = [];
  for (const block of text.match(/\{[^{}]*\}/g) ?? []) {
    const e: Ent = new Map();
    for (const m of block.matchAll(/"([^"]*)"\s+"([^"]*)"/g)) if (!e.has(m[1]!.toLowerCase())) e.set(m[1]!.toLowerCase(), m[2]!);
    out.push(e);
  }
  return out;
}

const vec = (s: string | undefined): number[] => { const v = (s ?? '').trim().split(/\s+/).map(Number); return v.length >= 3 && v.every(Number.isFinite) ? v.slice(0, 3) : [0, 0, 0]; };

/** Матрица Source (QAngle pitch/yaw/roll, градусы) + перенос, по столбцам. */
export function angleMatrix(ang: number[], org: number[], scale = 1): number[] {
  const r = Math.PI / 180, [p, y, rl] = [ang[0]! * r, ang[1]! * r, ang[2]! * r];
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y), sr = Math.sin(rl), cr = Math.cos(rl);
  return [cp * cy * scale, cp * sy * scale, -sp * scale, 0,
    (sr * sp * cy - cr * sy) * scale, (sr * sp * sy + cr * cy) * scale, sr * cp * scale, 0,
    (cr * sp * cy + sr * sy) * scale, (cr * sp * sy - sr * cy) * scale, cr * cp * scale, 0,
    org[0]!, org[1]!, org[2]!, 1];
}

/** Цвет из VMT: «[r g b]» — 0..1, «{r g b}» — 0..255. */
function vmtColor(text: string, key: string): number[] | null {
  const raw = vmtKey(text, key), v = raw.replace(/[[\]{}]/g, ' ').trim().split(/\s+/).map(Number);
  if (v.length !== 3 || !v.every(Number.isFinite)) return null;
  const line = new RegExp(`"?${key.replace(/\$/g, '\\$')}"?[ \t]+"?([\[{])`, 'i').exec(text);
  return line?.[1] === '{' || v.some((x) => x > 4) ? v.map((x) => x / 255) : v;
}

/** Вода (Water) и преломляющее стекло (Refract) из VMT: тона, сила искажения, туман, прокрутка карты нормалей. */
export function vmtScreenFx(text: string, shader: string, hasBase: boolean): ScreenFx | null {
  const num = (k: string, d: number) => { const v = parseFloat(vmtKey(text, k)); return Number.isFinite(v) ? v : d; };
  const clamp = (c: number[]) => c.map((x) => Math.min(1.5, Math.max(0, x)));
  if (shader === 'water') {
    const fogc = vmtColor(text, '$fogcolor') ?? [0.05, 0.08, 0.08], refr = vmtKey(text, '$refracttexture');
    const rate = parseFloat(vmtKey(text, 'texturescrollrate')) || 0, ang = (parseFloat(vmtKey(text, 'texturescrollangle')) || 0) * Math.PI / 180;
    const on = vmtKey(text, '$fogenable') !== '0';
    return {
      kind: 'water',
      // VTMB: $refractamount/$reflectamount порядка 20–60 — в долях экрана ~0.0005–0.0008 на единицу
      refractTint: clamp(vmtColor(text, '$refracttint') ?? (refr ? [1, 1, 1] : fogc)), reflectTint: clamp(vmtColor(text, '$reflecttint') ?? [0.8, 0.8, 0.8]),
      refract: Math.min(0.05, num('$refractamount', refr ? 20 : 8) * 0.0008), reflect: Math.min(0.05, num('$reflectamount', 30) * 0.0005),
      ...(on ? { fog: { color: clamp(fogc), start: num('$fogstart', 0), end: Math.max(num('$fogend', 512), num('$fogstart', 0) + 1) } } : {}),
      ...(rate ? { scroll: [Math.cos(ang) * rate, Math.sin(ang) * rate] as [number, number] } : {}),
      fallback: { color: fogc.map((x, k) => Math.min(1, 0.6 * x + [0.08, 0.13, 0.15][k]!)), opacity: 0.8 },
    };
  }
  if (shader === 'refract' || (!hasBase && vmtKey(text, '$refracttexture'))) {
    const tint = clamp(vmtColor(text, '$refracttint') ?? [1, 1, 1]);
    const env = vmtKey(text, '$envmap') ? clamp(vmtColor(text, '$envmaptint') ?? [1, 1, 1]) : null;
    return { kind: 'glass', refractTint: tint, ...(env ? { reflectTint: env } : {}), refract: Math.min(0.06, num('$refractamount', 1) * 0.01), fallback: { color: tint.map((x) => Math.min(1, x)), opacity: 0.3 } };
  }
  return null;
}

export async function loadSourceBsp(main: VFile, ctx: LoadContext): Promise<Model> {
  const buf = await main.arrayBuffer(), dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (buf.byteLength < 1036 || dv.getUint32(0, true) !== 0x50534256) throw new Error('Не Source BSP (нет VBSP)');
  const version = dv.getInt32(4, true);
  if (version < 17 || version > 21) throw new Error(`Source BSP v${version} не поддерживается (17–21)`);
  // v21 (L4D2, CS:GO): в записи каталога сначала версия, потом смещение и длина
  const lump = (i: number): [number, number] => {
    const o = 8 + i * 16;
    const [ofs, len] = version === 21 && dv.getInt32(o, true) < 0x100 && dv.getInt32(o + 4, true) >= 1036 ? [dv.getInt32(o + 4, true), dv.getInt32(o + 8, true)] : [dv.getInt32(o, true), dv.getInt32(o + 4, true)];
    return ofs > 0 && len > 0 && ofs + len <= buf.byteLength ? [ofs, len] : [0, 0];
  };
  const F = (o: number) => dv.getFloat32(o, true), I = (o: number) => dv.getInt32(o, true);
  const info: string[] = [];

  // ---------- lump-ы BSP ----------
  const [vO, vL] = lump(3), nVert = vL / 12;
  const [pO] = lump(1);
  const [eO, eL] = lump(12), [seO, seL] = lump(13);
  const [tiO, tiL] = lump(6), nTexinfo = tiL / 72;
  const [tdO, tdL] = lump(2), nTexdata = tdL / 32;
  const [tsO, tsL] = lump(44), [sdO, sdL] = lump(43);
  const [fO, fL] = lump(7), faceSize = version === 17 ? 104 : 56, nFaces = Math.floor(fL / faceSize);
  const [mO, mL] = lump(14), nModels = mL / 48;
  const [diO, diL] = lump(26), [dvO] = lump(33);
  let [lO, lL] = lump(8);
  if (!lL) [lO, lL] = lump(53);
  if (!nFaces || !nVert) throw new Error(`${main.name}: в карте нет граней`);
  const edgeVert = (se: number) => { const e = I(seO + se * 4), a = Math.abs(e); return dv.getUint16(eO + a * 4 + (e < 0 ? 2 : 0), true); };
  void eL; void seL; void sdL;

  const texName: string[] = [];
  for (let t = 0; t < nTexdata; t++) {
    const id = I(tdO + t * 32 + 12), so = id >= 0 && id * 4 < tsL ? I(tsO + id * 4) : -1;
    let s = '';
    if (so >= 0) for (let p = sdO + so; p < sdO + sdL && u8[p]; p++) s += String.fromCharCode(u8[p]!);
    texName.push(s);
  }
  const texSize = (t: number): [number, number] => [I(tdO + t * 32 + 16) || 256, I(tdO + t * 32 + 20) || 256];

  const face = (i: number): Face => {
    const o = fO + i * faceSize;
    if (version === 17) {
      return { plane: dv.getUint16(o + 32, true), side: u8[o + 34]!, firstEdge: I(o + 36), numEdges: dv.getInt16(o + 40, true), texinfo: dv.getInt16(o + 42, true), disp: dv.getInt16(o + 44, true),
        lightofs: I(o + 72), lmMins: [I(o + 80), I(o + 84)], lmSize: [I(o + 88), I(o + 92)] };
    }
    return { plane: dv.getUint16(o, true), side: u8[o + 2]!, firstEdge: I(o + 4), numEdges: dv.getInt16(o + 8, true), texinfo: dv.getInt16(o + 10, true), disp: dv.getInt16(o + 12, true),
      lightofs: I(o + 20), lmMins: [I(o + 28), I(o + 32)], lmSize: [I(o + 36), I(o + 40)] };
  };

  // ---------- сущности ----------
  const [enO, enL] = lump(0);
  let entText = '';
  for (let p = enO; p < enO + enL && u8[p]; p++) entText += String.fromCharCode(u8[p]!);
  const ents = parseEntities(entText);

  // ---------- pakfile (материалы карты: patch-vmt под cubemap'ы) ----------
  let pak: Archive | null = null;
  const [pkO, pkL] = lump(40);
  if (pkL) {
    try { const blob = new Blob([u8.subarray(pkO, pkO + pkL)]) as Blob & { name: string }; Object.defineProperty(blob, 'name', { value: 'pakfile.zip' }); pak = await openZip(blob as unknown as BlobFile); } catch { pak = null; }
  }
  const dec = new TextDecoder('latin1');
  interface Mat { stem: string; alphaTest: boolean; translucent: boolean; tool: boolean; found: boolean; /** текстура, если .vmt есть только в pakfile */ tex?: string; /** WorldVertexTransition: вторая текстура (смешивание по альфе вершин дисплейсмента) */ wvt?: string; /** вода/стекло с преломлением (плоскость воды — у меша) */ fx?: ScreenFx }
  const mats = new Map<string, Mat>();
  /** Материал по имени из BSP/MDL: patch -> include; итоговый stem — путь .vmt без materials/. */
  const material = async (name: string): Promise<Mat> => {
    let stem = matStem(name);
    const key = stem;
    const known = mats.get(key);
    if (known) return known;
    const m: Mat = { stem, alphaTest: false, translucent: false, tool: /^tools\//.test(stem), found: false };
    for (let depth = 0; depth < 3; depth++) {
      const vp = 'materials/' + stem + '.vmt', pe = pak?.lookup(vp), data = pe ? await pak!.read(pe) : await ctx.readPath(vp);
      if (!data) break;
      m.found = true;
      const vi = vmtInfo(dec.decode(data));
      if (pe && vi.base) m.tex = matStem(vi.base);
      if (vi.include) { stem = matStem(vi.include); m.stem = stem; continue; }
      m.alphaTest = vi.alphaTest; m.translucent = vi.translucent;
      const text = dec.decode(data), b2 = vmtKey(text, '$basetexture2');
      // вода и преломляющее стекло: отражение и преломление по снимку экрана (ScreenFx)
      const fx = vmtScreenFx(text, vi.shader, !!vi.base);
      if (fx) { if (/waterbeneath/.test(stem)) m.tool = true; else m.fx = fx; } // waterbeneath — нижняя сторона воды
      if (/worldvertextransition/.test(vi.shader) && b2) m.wvt = matStem(b2);
      if (/^tools\//.test(stem) || /^(nodraw|toolsnodraw)$/.test(vi.shader)) m.tool = true;
      break;
    }
    if (!m.found && /^maps\/[^/]+\//.test(stem)) {
      // patch-материал карты без pakfile: «maps/<карта>/wood/x_1_2_3» -> «wood/x»
      const alt = stem.replace(/^maps\/[^/]+\//, '').replace(/(_-?\d+){3}$/, '');
      const r = await material(alt);
      mats.set(key, r);
      return r;
    }
    mats.set(key, m);
    return m;
  };

  // ---------- карта освещения: упаковка полками в атлас RGB ----------
  const lmW = 2048, lmFaces: Array<{ f: number; x: number; y: number; w: number; h: number }> = [];
  let shelfX = 4, shelfY = 0, shelfH = 4;
  const lmPos = new Map<number, { x: number; y: number; w: number; h: number }>(), bumpFaces = new Set<number>();
  const faces: Face[] = [];
  for (let i = 0; i < nFaces; i++) faces.push(face(i));
  if (lL) {
    const order = faces.map((f, i) => ({ f, i })).filter(({ f }) => f.lightofs >= 0 && f.lmSize[0] >= 0 && f.lmSize[1] >= 0 && f.lmSize[0] < 512 && f.lmSize[1] < 512)
      .sort((a, b) => b.f.lmSize[1] - a.f.lmSize[1]);
    for (const { f, i } of order) {
      const w = f.lmSize[0] + 1, h = f.lmSize[1] + 1;
      if (f.lightofs + w * h * 4 > lL) continue;
      // рельеф: за обычной картой — ещё три, по направлениям базиса (для каждого стиля света)
      if (f.texinfo >= 0 && f.texinfo < nTexinfo && I(tiO + f.texinfo * 72 + 64) & SURF_BUMPLIGHT && f.lightofs + w * h * 16 <= lL) bumpFaces.add(i);
      if (shelfX + w + 2 > lmW) { shelfX = 0; shelfY += shelfH + 2; shelfH = 0; }
      const r = { f: i, x: shelfX + 1, y: shelfY + 1, w, h };
      lmFaces.push(r); lmPos.set(i, r);
      shelfX += w + 2; shelfH = Math.max(shelfH, h);
    }
  }
  const lmH = lmFaces.length ? 1 << Math.ceil(Math.log2(shelfY + shelfH + 2)) : 0;
  let lightmap: Uint8Array | null = null, bumpLm: [Uint8Array, Uint8Array, Uint8Array] | null = null;
  if (lmH && lmH <= 8192) {
    lightmap = new Uint8Array(lmW * lmH * 3);
    if (bumpFaces.size) bumpLm = [new Uint8Array(lmW * lmH * 3), new Uint8Array(lmW * lmH * 3), new Uint8Array(lmW * lmH * 3)];
    // ColorRGBExp32 -> гамма 2.2, половинная яркость (шейдер умножает ×2)
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) lightmap.fill(128, (y * lmW + x) * 3, (y * lmW + x) * 3 + 3); // «без освещения»: ×1
    const px = (o: number) => {
      const e = dv.getInt8(o + 3);
      const k = Math.pow(2, e) / 255;
      return [u8[o]! * k, u8[o + 1]! * k, u8[o + 2]! * k];
    };
    const enc = (v: number) => Math.min(255, Math.round(Math.pow(Math.min(4, v), 1 / 2.2) * 127.5));
    if (bumpLm) for (const L of bumpLm) L.set(lightmap.subarray(0, lmW * 4 * 3));
    for (const r of lmFaces) {
      const f = faces[r.f]!, bumped = bumpLm && bumpFaces.has(r.f), blk = r.w * r.h * 4;
      for (let y = -1; y <= r.h; y++)
        for (let x = -1; x <= r.w; x++) {
          const sx = Math.min(r.w - 1, Math.max(0, x)), sy = Math.min(r.h - 1, Math.max(0, y)), so = lO + f.lightofs + (sy * r.w + sx) * 4;
          const c = px(so), o = ((r.y + y) * lmW + r.x + x) * 3;
          for (let k = 0; k < 3; k++) lightmap[o + k] = enc(c[k]!);
          if (!bumpLm) continue;
          // грань без рельефа — во всех трёх картах базиса та же яркость
          for (let b = 0; b < 3; b++) {
            const L = bumpLm[b]!;
            if (bumped) { const cb = px(so + (b + 1) * blk); for (let k = 0; k < 3; k++) L[o + k] = enc(cb[k]!); }
            else for (let k = 0; k < 3; k++) L[o + k] = lightmap[o + k]!;
          }
        }
    }
  }

  // ---------- 3D-небо: область листа sky_camera, показ в масштабе (p − origin) × scale ----------
  const [lfO, lfL] = lump(10), [ndO, ndL] = lump(5), [lffO, lffL] = lump(16);
  const leafSize = version === 19 && lfL % 56 === 0 ? 56 : 32, nLeafs = Math.floor(lfL / leafSize);
  const leafArea = (li: number) => (li >= 0 && li < nLeafs ? dv.getInt16(lfO + li * leafSize + 6, true) & 0x1ff : -1);
  const pointLeaf = (p: number[]): number => {
    if (!ndL || !nModels) return -1;
    let node = I(mO + 36);
    for (let guard = 0; node >= 0 && guard < 4096; guard++) {
      if ((node + 1) * 32 > ndL) return -1;
      const nd = ndO + node * 32, pl = pO + I(nd) * 20, d = F(pl) * p[0]! + F(pl + 4) * p[1]! + F(pl + 8) * p[2]! - F(pl + 12);
      node = I(nd + (d >= 0 ? 4 : 8));
    }
    return -1 - node;
  };
  const skyCam = ents.find((e) => e.get('classname') === 'sky_camera'), skyO = vec(skyCam?.get('origin')), skyS = +(skyCam?.get('scale') ?? 16) || 16;
  let skyArea = skyCam ? leafArea(pointLeaf(skyO)) : -1;
  const start = ents.find((e) => /^info_player_start$/.test(e.get('classname') ?? ''));
  if (skyArea >= 0 && start && leafArea(pointLeaf(vec(start.get('origin')))) === skyArea) skyArea = -1; // небо в той же области — не отделяем
  const skyFaces = new Set<number>();
  if (skyArea >= 0)
    for (let li = 0; li < nLeafs; li++) {
      if (leafArea(li) !== skyArea) continue;
      const o = lfO + li * leafSize, first = dv.getUint16(o + 20, true), num = dv.getUint16(o + 22, true);
      for (let k = 0; k < num && (first + k) * 2 < lffL; k++) skyFaces.add(dv.getUint16(lffO + (first + k) * 2, true));
    }
  const toSky = (p: number[]) => [(p[0]! - skyO[0]!) * skyS, (p[1]! - skyO[1]!) * skyS, (p[2]! - skyO[2]!) * skyS];

  // ---------- браши ----------
  const offsetOf = new Map<number, number[]>();
  offsetOf.set(0, [0, 0, 0]);
  for (const e of ents) {
    const m = /^\*(\d+)$/.exec(e.get('model') ?? '');
    if (!m) continue;
    const cls = e.get('classname') ?? '';
    if (/^(trigger_|func_areaportal|func_occluder|func_viscluster|env_|func_ladder|func_clip|func_precipitation)/.test(cls)) continue;
    offsetOf.set(+m[1]!, vec(e.get('origin')));
  }
  const batches = new Map<string, Batch>();
  const batch = (k: string) => { let b = batches.get(k); if (!b) { b = { pos: [], nor: [], uv: [], uv2: [], idx: [], alpha: [] }; batches.set(k, b); } return b; };
  const texMat = new Map<number, Mat>();
  for (let t = 0; t < nTexdata; t++) texMat.set(t, await material(texName[t]!));
  let skipped = 0, dispCount = 0, brushFaces = 0;
  const done = new Set<number>();
  for (const [mi, off] of offsetOf) {
    if (mi >= nModels) continue;
    const first = I(mO + mi * 48 + 40), num = I(mO + mi * 48 + 44);
    for (let fi = first; fi < first + num && fi < nFaces; fi++) {
      if (done.has(fi)) continue;
      done.add(fi);
      const f = faces[fi]!;
      if (f.texinfo < 0 || f.texinfo >= nTexinfo || f.numEdges < 3) { skipped++; continue; }
      const ti = tiO + f.texinfo * 72, flags = I(ti + 64), td = I(ti + 68);
      if (flags & (SURF_SKY | SURF_SKY2D | SURF_NODRAW | SURF_HINT | SURF_SKIP | SURF_TRIGGER)) { skipped++; continue; }
      const mat = texMat.get(td);
      if (!mat || mat.tool) { skipped++; continue; }
      const isSky = skyFaces.has(fi), [tw, th] = texSize(td);
      const pn = [F(pO + f.plane * 20), F(pO + f.plane * 20 + 4), F(pO + f.plane * 20 + 8)];
      if (f.side) { pn[0] = -pn[0]!; pn[1] = -pn[1]!; pn[2] = -pn[2]!; }
      // вода: свой меш на каждую плоскость (отражение строится по плоскости)
      let pk = '';
      if (mat.fx?.kind === 'water') {
        // у воды видна только верхняя грань: боковые (стенки объёма воды) игра не рисует
        if (pn[2]! < 0.7) { skipped++; continue; }
        const v0 = edgeVert(f.firstEdge), d = pn[0]! * (F(vO + v0 * 12) + off[0]!) + pn[1]! * (F(vO + v0 * 12 + 4) + off[1]!) + pn[2]! * (F(vO + v0 * 12 + 8) + off[2]!);
        pk = '#' + [...pn.map((x) => x.toFixed(3)), d.toFixed(1)].join(',');
      }
      const b = batch((isSky ? 'sky|' : '') + mat.stem + pk);
      const lp = lmPos.get(fi);
      const tv = (k: number, p: number[]) => F(ti + k * 16) * p[0]! + F(ti + k * 16 + 4) * p[1]! + F(ti + k * 16 + 8) * p[2]! + F(ti + k * 16 + 12);
      const lv = (k: number, p: number[]) => F(ti + 32 + k * 16) * p[0]! + F(ti + 32 + k * 16 + 4) * p[1]! + F(ti + 32 + k * 16 + 8) * p[2]! + F(ti + 32 + k * 16 + 12);
      const push = (p: number[], n: number[], uvBase: number[]) => {
        const w = [p[0]! + off[0]!, p[1]! + off[1]!, p[2]! + off[2]!], q = isSky ? toSky(w) : w;
        b.pos.push(q[0]!, q[1]!, q[2]!); b.nor.push(n[0]!, n[1]!, n[2]!);
        b.uv.push(tv(0, uvBase) / tw, tv(1, uvBase) / th);
        if (lp) b.uv2.push((lp.x + Math.min(lp.w - 0.5, Math.max(0.5, lv(0, uvBase) - f.lmMins[0] + 0.5))) / lmW, (lp.y + Math.min(lp.h - 0.5, Math.max(0.5, lv(1, uvBase) - f.lmMins[1] + 0.5))) / lmH);
        else b.uv2.push(-1, -1);
      };
      const corners: number[][] = [];
      for (let k = 0; k < f.numEdges; k++) { const v = edgeVert(f.firstEdge + k); corners.push([F(vO + v * 12), F(vO + v * 12 + 4), F(vO + v * 12 + 8)]); }
      if (f.disp >= 0 && diL && f.disp * 176 < diL && corners.length === 4) {
        // дисплейсмент: сетка (2^power+1)², углы — от startPosition
        const di = diO + f.disp * 176, start = [F(di), F(di + 4), F(di + 8)], dvStart = I(di + 12), power = I(di + 20), n = (1 << power) + 1;
        let s0 = 0, best = Infinity;
        corners.forEach((c, k) => { const d = Math.hypot(c[0]! - start[0]!, c[1]! - start[1]!, c[2]! - start[2]!); if (d < best) { best = d; s0 = k; } });
        const c = [0, 1, 2, 3].map((k) => corners[(s0 + k) % 4]!), base = b.pos.length / 3;
        const grid: number[][] = [];
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) {
            const ty = y / (n - 1), tx = x / (n - 1);
            const L = [0, 1, 2].map((k) => c[0]![k]! + (c[1]![k]! - c[0]![k]!) * ty), R = [0, 1, 2].map((k) => c[3]![k]! + (c[2]![k]! - c[3]![k]!) * ty);
            const bp = [0, 1, 2].map((k) => L[k]! + (R[k]! - L[k]!) * tx), o = dvO + (dvStart + y * n + x) * 20, dist = F(o + 12);
            grid.push(bp);
            push([bp[0]! + F(o) * dist, bp[1]! + F(o + 4) * dist, bp[2]! + F(o + 8) * dist], pn, bp);
          }
        // нормали по сетке
        const idx0 = b.idx.length;
        for (let y = 0; y < n - 1; y++)
          for (let x = 0; x < n - 1; x++) {
            const a = base + y * n + x, q = a + 1, r = a + n, s = r + 1;
            if ((x + y) & 1) b.idx.push(a, r, q, q, r, s); else b.idx.push(a, r, s, a, s, q);
          }
        const acc = new Float32Array(n * n * 3);
        for (let t = idx0; t < b.idx.length; t += 3) {
          const ia = b.idx[t]! - base, ib = b.idx[t + 1]! - base, ic = b.idx[t + 2]! - base, P = (j: number, k: number) => b.pos[(base + j) * 3 + k]!;
          const ux = P(ib, 0) - P(ia, 0), uy = P(ib, 1) - P(ia, 1), uz = P(ib, 2) - P(ia, 2), wx = P(ic, 0) - P(ia, 0), wy = P(ic, 1) - P(ia, 1), wz = P(ic, 2) - P(ia, 2);
          const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
          for (const j of [ia, ib, ic]) { acc[j * 3] += nx; acc[j * 3 + 1] += ny; acc[j * 3 + 2] += nz; }
        }
        // ориентация треугольников — по нормали плоскости грани
        let dot = 0;
        for (let j = 0; j < n * n; j++) dot += acc[j * 3]! * pn[0]! + acc[j * 3 + 1]! * pn[1]! + acc[j * 3 + 2]! * pn[2]!;
        const sgn = dot < 0 ? -1 : 1;
        if (dot < 0) for (let t = idx0; t < b.idx.length; t += 3) { const tmp = b.idx[t + 1]!; b.idx[t + 1] = b.idx[t + 2]!; b.idx[t + 2] = tmp; }
        for (let j = 0; j < n * n; j++) {
          const l = Math.hypot(acc[j * 3]!, acc[j * 3 + 1]!, acc[j * 3 + 2]!) || 1;
          for (let k = 0; k < 3; k++) b.nor[(base + j) * 3 + k] = (acc[j * 3 + k]! / l) * sgn;
        }
        void grid;
        // WorldVertexTransition: второй слой поверх, прозрачность — альфа вершин дисплейсмента (0..255)
        if (mat.wvt) {
          const ob = batch((isSky ? 'sky|' : '') + 'wvt|' + mat.stem), ob0 = ob.pos.length / 3;
          for (let j = 0; j < n * n; j++) {
            for (let k = 0; k < 3; k++) { ob.pos.push(b.pos[(base + j) * 3 + k]!); ob.nor.push(b.nor[(base + j) * 3 + k]!); }
            ob.uv.push(b.uv[(base + j) * 2]!, b.uv[(base + j) * 2 + 1]!); ob.uv2.push(b.uv2[(base + j) * 2]!, b.uv2[(base + j) * 2 + 1]!);
            ob.alpha.push(Math.min(1, Math.max(0, F(dvO + (dvStart + j) * 20 + 16) / 255)));
          }
          for (let t = idx0; t < b.idx.length; t++) ob.idx.push(b.idx[t]! - base + ob0);
        }
        dispCount++;
        continue;
      }
      const base = b.pos.length / 3;
      for (const p of corners) push(p, pn, p);
      // веер; вершины грани Source идут по часовой стрелке — меняем порядок на против
      for (let k = 1; k + 1 < corners.length; k++) b.idx.push(base, base + k + 1, base + k);
      brushFaces++;
    }
  }

  const meshes: Mesh[] = [];
  let brushTris = 0;
  let skyTris = 0, wvtLayers = 0, fxMeshes = 0;
  for (const [key, b] of batches) {
    if (!b.idx.length) continue;
    const sky = key.startsWith('sky|'), k1 = sky ? key.slice(4) : key, [k2, pk] = k1.split('#') as [string, string | undefined], overlay = k2.startsWith('wvt|'), stem = overlay ? k2.slice(4) : k2;
    const mat = mats.get(stem) ?? [...mats.values()].find((m) => m.stem === stem);
    const nv = b.pos.length / 3, pos = Float32Array.from(b.pos);
    const hasLm = !!lightmap && b.uv2.some((v) => v >= 0);
    const tex = overlay ? mat!.wvt! : stem, fx = !overlay ? mat?.fx : undefined;
    const plane = pk ? (pk.split(',').map(Number) as [number, number, number, number]) : undefined;
    if (fx) fxMeshes++;
    if (sky) skyTris += b.idx.length / 3;
    if (overlay) wvtLayers++;
    meshes.push({ name: `${sky ? 'небо 3D' : 'карта'} · ${tex}${overlay ? ' (слой)' : ''}`, texture: tex,
      materialPaths: [overlay ? 'materials/' + tex + '.vtf' : mat?.tex ? 'materials/' + mat.tex + '.vtf' : 'materials/' + stem + '.vmt'], vertexCount: nv, pos, nor: Float32Array.from(b.nor), uv: Float32Array.from(b.uv),
      ...(overlay ? { vertexAlpha: Float32Array.from(b.alpha) } : {}),
      ...(fx ? { screenFx: { ...fx, ...(plane ? { plane } : {}) }, color: fx.fallback.color } : {}),
      ...(hasLm ? { uv2: Float32Array.from(b.uv2.map((v, k) => (v < 0 ? 1.5 / (k & 1 ? lmH : lmW) : v))) } : {}),
      bone: new Float32Array(0), weight: new Float32Array(0), indices: nv > 65535 ? Uint32Array.from(b.idx) : Uint16Array.from(b.idx), skinned: false,
      ...(mat?.alphaTest || mat?.translucent ? { alphaTest: true } : {}) } as Mesh);
    brushTris += b.idx.length / 3;
  }
  info.push(`Source BSP v${version}: ${main.name} — граней ${brushFaces.toLocaleString('ru')}${dispCount ? `, дисплейсментов ${dispCount}` : ''}, материалов ${meshes.length}, треугольников ${Math.round(brushTris).toLocaleString('ru')} (служебных граней пропущено ${skipped})`);
  if (skyFaces.size) info.push(`3D-небо: ${skyFaces.size} граней в масштабе ×${skyS} от sky_camera (меши «небо 3D · …»), треугольников ${Math.round(skyTris).toLocaleString('ru')}`);
  if (fxMeshes) info.push(`Вода и стекло с преломлением: ${fxMeshes} мешей (отражение и преломление по снимку экрана)`);
  if (wvtLayers) info.push(`Смешивание текстур дисплейсментов (WorldVertexTransition): ${wvtLayers} слоёв`);
  const lostMats = [...mats.values()].filter((m) => !m.found && !m.tool).map((m) => m.stem);
  if (lostMats.length) info.push(`Не найдено материалов: ${lostMats.length} (${lostMats.slice(0, 4).join(', ')}${lostMats.length > 4 ? '…' : ''})`);

  // ---------- реквизит ----------
  const B = new LevelBuilder();
  const protos = new Map<string, { pi: number; parts: Mesh[] } | null>(), missing = new Set<string>();
  // общие include-модели анимаций читаются один раз на карту
  const fileCache = new Map<string, Promise<Uint8Array | null>>();
  const readCached = (p: string) => { if (/\/shared\//.test(p)) { let r = fileCache.get(p); if (!r) fileCache.set(p, (r = ctx.readPath(p))); return r; } return ctx.readPath(p); };
  let posed = 0;
  const poseNames = new Map<string, number>();
  const proto = async (path: string, skin: number, sky = false, anim?: string) => {
    const key = `${path}#${skin}${sky ? '#sky' : ''}${anim !== undefined ? '#' + anim : ''}`;
    if (protos.has(key)) return protos.get(key)!;
    let pr: { pi: number; parts: Mesh[] } | null = null;
    try {
      const m = await loadMdlByPath(path, readCached, skin, anim !== undefined);
      if (m && m.skeleton && anim !== undefined) {
        // персонаж: поза первого кадра «idle» вместо T-позы
        const mo = pickIdle(m.motions, anim);
        if (mo) { m.meshes = await bakePose(m, mo, 0); posed++; poseNames.set(mo.name, (poseNames.get(mo.name) ?? 0) + 1); }
      }
      if (m && m.meshes.length) {
        const parts: Mesh[] = [];
        for (const p of m.meshes) {
          // материал: первый существующий .vmt из путей модели
          let stem = matStem(p.materialPaths?.[0] ?? p.texture), mat: Mat | null = null;
          for (const c of p.materialPaths ?? []) { const r = await material(c); if (r.found) { mat = r; stem = r.stem; break; } }
          if (mat?.tool) continue;
          parts.push({ ...p, texture: stem, materialPaths: undefined, ...(mat?.alphaTest || mat?.translucent ? { alphaTest: true } : {}), ...(mat?.fx ? { screenFx: mat.fx, color: mat.fx.fallback.color } : {}) });
        }
        if (parts.length) pr = { pi: B.proto(key, parts, sky ? 'sky' : 'prop', (q) => `${sky ? 'небо 3D · ' : ''}реквизит · ${q.texture.split('/').slice(-2).join('/')}`), parts };
      } else missing.add(path);
    } catch { missing.add(path); }
    protos.set(key, pr);
    return pr;
  };
  let statics = 0, entProps = 0, skyProps = 0;
  const skyM = (M: number[]) => M.map((v, k) => (k < 12 ? (k % 4 === 3 ? v : v * skyS) : k < 15 ? (v - skyO[k - 12]!) * skyS : v));
  // статический реквизит: game lump `sprp` / `prps` (VTMB)
  const [gO, gL] = lump(35);
  if (gL >= 4) {
    const n = I(gO);
    for (let i = 0; i < n && gO + 4 + i * 16 + 16 <= buf.byteLength; i++) {
      const o = gO + 4 + i * 16, id = String.fromCharCode(u8[o]!, u8[o + 1]!, u8[o + 2]!, u8[o + 3]!), gver = dv.getUint16(o + 6, true), go = I(o + 8), gl = I(o + 12);
      if ((id !== 'prps' && id !== 'sprp') || go <= 0 || go + gl > buf.byteLength) continue;
      let p = go;
      const nd = I(p); p += 4;
      if (nd < 0 || nd > 65535) continue;
      const names: string[] = [];
      for (let k = 0; k < nd; k++) { let s = ''; for (let j = 0; j < 128 && u8[p + k * 128 + j]; j++) s += String.fromCharCode(u8[p + k * 128 + j]!); names.push(s.toLowerCase().replace(/\\/g, '/')); }
      p += nd * 128;
      const nl = I(p), leafs = p + 4; p += 4 + nl * 2;
      const np = I(p); p += 4;
      if (np <= 0) continue;
      const size = Math.floor((go + gl - p) / np);
      if (size < 32) continue;
      for (let k = 0; k < np; k++) {
        const q = p + k * size, type = dv.getUint16(q + 24, true), skin = size >= 36 ? I(q + 32) : 0;
        const path = names[type];
        if (!path) continue;
        const fl = dv.getUint16(q + 26, true), sky = skyArea >= 0 && fl < nl && leafArea(dv.getUint16(leafs + fl * 2, true)) === skyArea;
        const pr = await proto(path, skin > 0 && skin < 64 ? skin : 0, sky);
        if (!pr) continue;
        const M = angleMatrix([F(q + 12), F(q + 16), F(q + 20)], [F(q), F(q + 4), F(q + 8)]);
        B.place(pr.pi, pr.parts, sky ? skyM(M) : M, path.split('/').pop()!, sky ? 'небо 3D' : 'prop_static');
        if (sky) skyProps++;
        statics++;
      }
      void gver;
    }
  }
  for (const e of ents) {
    const mdl = (e.get('model') ?? '').toLowerCase().replace(/\\/g, '/');
    if (!/\.mdl$/.test(mdl)) continue;
    const cls = e.get('classname') ?? '';
    if (/^(env_sprite|info_|light|npc_maker)/.test(cls)) continue; // npc_maker — точки появления, в игре их не видно
    const skin = +(e.get('skin') ?? 0) || 0;
    const org = vec(e.get('origin')), sky = skyArea >= 0 && leafArea(pointLeaf(org)) === skyArea;
    const character = /^models\/character\//.test(mdl) || /^npc_/.test(cls);
    const pr = await proto(mdl, skin, sky, character ? (e.get('defaultanim') || e.get('demo_sequence') || e.get('sequence') || '') : undefined);
    if (!pr) continue;
    const scale = +(e.get('modelscale') ?? 1) || 1, M = angleMatrix(vec(e.get('angles')), org, scale);
    B.place(pr.pi, pr.parts, sky ? skyM(M) : M, e.get('targetname') || mdl.split('/').pop()!, sky ? 'небо 3D' : cls || 'entity');
    if (sky) skyProps++;
    entProps++;
  }
  const props = B.build();
  const fxProps = props.filter((m) => m.screenFx).length;
  if (fxProps) info.push(`Реквизит с преломлением (Refract): ${fxProps} мешей`);
  info.push(`Реквизит: статического ${statics}, из сущностей ${entProps}${skyProps ? ` (в 3D-небе ${skyProps})` : ''}, разных моделей ${[...protos.values()].filter(Boolean).length}`);
  if (posed) info.push(`Персонажи: ${posed} моделей поставлены в позу первого кадра (${[...poseNames].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} ×${c}`).join(', ')})`);
  if (missing.size) info.push(`Не найдено моделей: ${missing.size} (${[...missing].slice(0, 4).join(', ')}${missing.size > 4 ? '…' : ''})`);
  const all = [...props, ...meshes];
  // 2D-небо (worldspawn skyname): куб materials/skybox/<имя>{ft,rt,bk,lf,up,dn} вокруг всего; ft смотрит на +X, справа rt (−Y)
  const skyName = ents.find((e) => e.get('classname') === 'worldspawn')?.get('skyname')?.toLowerCase();
  let sky2d = false;
  if (skyName && all.length) {
    const ab = boundsOf(all), c = [0, 1, 2].map((k) => (ab.min[k]! + ab.max[k]!) / 2);
    const s = 1.5 * Math.hypot(ab.max[0]! - c[0]!, ab.max[1]! - c[1]!, ab.max[2]! - c[2]!) || 1000;
    const sides: Array<[string, number[], number[]]> = [['ft', [1, 0, 0], [0, -1, 0]], ['rt', [0, -1, 0], [-1, 0, 0]], ['bk', [-1, 0, 0], [0, 1, 0]], ['lf', [0, 1, 0], [1, 0, 0]]];
    const faces: Array<[string, (u: number, v: number) => number[], number[]]> = sides.map(([n, D, R]) => [n, (u: number, v: number) => [0, 1, 2].map((k) => c[k]! + s * (D[k]! + R[k]! * (2 * u - 1) + [0, 0, 1][k]! * (1 - 2 * v))), D]);
    faces.push(['up', (u, v) => [c[0]! + s * (2 * v - 1), c[1]! + s * (1 - 2 * u), c[2]! + s], [0, 0, 1]]);
    faces.push(['dn', (u, v) => [c[0]! + s * (1 - 2 * v), c[1]! + s * (1 - 2 * u), c[2]! - s], [0, 0, -1]]);
    for (const [n, P, D] of faces) {
      if (!(await ctx.readPath(`materials/skybox/${skyName}${n}.vmt`))) continue;
      const uv = [0, 0, 1, 0, 1, 1, 0, 1], pos = new Float32Array(12);
      for (let i = 0; i < 4; i++) pos.set(P(uv[i * 2]!, uv[i * 2 + 1]!), i * 3);
      // изнутри: обход против часовой при взгляде из центра; нормаль внутрь
      const nor = new Float32Array(12).map((_, i) => -D[i % 3]!);
      all.push({ name: `небо 2D · ${skyName}${n}`, texture: `skybox/${skyName}${n}`, materialPaths: [`materials/skybox/${skyName}${n}.vmt`], vertexCount: 4, pos, nor, uv: Float32Array.from(uv),
        ...(lightmap ? { uv2: Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0].map((_, k) => 1.5 / (k & 1 ? lmH : lmW))) } : {}),
        bone: new Float32Array(0), weight: new Float32Array(0), indices: Uint16Array.from([0, 2, 1, 0, 3, 2]), skinned: false, defaultHidden: true });
      sky2d = true;
    }
  }
  // дальний фон 3D-неба (холмы, купол вокруг уровня) закрывает карту при взгляде снаружи — скрыт по умолчанию
  const core = all.filter((m) => !m.name.startsWith('небо 3D'));
  if (core.length && core.length < all.length) {
    const cb = boundsOf(core), c = [0, 1, 2].map((k) => (cb.min[k]! + cb.max[k]!) / 2), r = Math.hypot(cb.max[0]! - c[0]!, cb.max[1]! - c[1]!, cb.max[2]! - c[2]!) || 1;
    let hidden = 0;
    for (const m of all) {
      if (!m.name.startsWith('небо 3D')) continue;
      let far = 0;
      for (let i = 0; i < m.pos.length; i += 3) far = Math.max(far, Math.hypot(m.pos[i]! - c[0]!, m.pos[i + 1]! - c[1]!, m.pos[i + 2]! - c[2]!));
      if (far > 2 * r) { m.defaultHidden = true; hidden++; }
    }
    if (hidden) info.push(`3D-небо: ${hidden} мешей дальнего фона скрыты (включаются в списке мешей)`);
  }
  if (!all.length) throw new Error(`${main.name}: нет видимой геометрии`);
  if (lightmap) info.push(`Карта освещения: ${lmFaces.length} граней, атлас ${lmW}×${lmH}${bumpFaces.size ? `; с рельефом (3 направления базиса) ${bumpFaces.size}` : ''}`);
  const sky = ents.find((e) => e.get('classname') === 'worldspawn')?.get('skyname');
  if (sky) info.push(sky2d ? `2D-небо: ${sky} — куб «небо 2D · …» вокруг карты, по умолчанию скрыт (закрывает вид снаружи), включается в списке мешей` : `Небо: ${sky} (текстуры не найдены)`);
  return { meshes: all, instances: B.scene, skeleton: null, motions: [], bounds: boundsOf(all.some((m) => !m.name.startsWith('небо')) ? all.filter((m) => !m.name.startsWith('небо')) : all), flipZ: false, defaultZUp: true, cameraYaw: 0, info,
    ...(lightmap ? { lightmap: { width: lmW, height: lmH, data: lightmap, rgb: true, scale: 2, ...(bumpLm ? { bump: bumpLm } : {}) } } : {}) };
}
