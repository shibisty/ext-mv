// Need for Speed: World — машины (CARS/<машина>/GEOMETRY.bin + TEXTURES.BIN). Таблица объектов 0x134004 →
// сжатые объекты 0x80134010: заголовок (имя, габариты), хеши текстур, меш 0x80134100 с подмешами (116 байт),
// индексами u16 и буферами вершин по 32 байта (позиция s16/4096, UV s16/4096, цвет, нормаль s16/32767, касательная).
import { boundsOf, computeNormals, sumTris, sumVerts } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import type { DecodedImage, Mesh, Model, ModelOption, VFile } from '../../core/types';
import { composeSkin, isFlat, loadVinyl, loadWheel, PAINTS, vinylList, wheelList, type VinylPlace } from './nfscustom';
import { bbBlocks, bbChunks, bbFind, BB_GEOMETRY, decodeBbTexture, readTpks, skipPad, stpTexture, tpkEntries, unLzc, type BbTexture } from './blackbox';

/** Маркер объекта (0x13401a, 80 байт): хеш имени (REAR_LICENSE_PLATE, LEFT_HEADLIGHT…) и матрица 4×4 по строкам. */
export interface NfsMarker { hash: number; m: Float32Array }
export interface NfsPart { hash: number; name: string; subs: NfsSub[]; markers?: NfsMarker[] }
export interface NfsSub { texture: number; /** хеш из записи подмеша @4 (ключ материала; у одной текстуры совпадает с ней) */ key?: number; /** запечённый свет по вершинам (RGBA, 128 = 1; float-вершины трасс) */ shade?: Uint8Array; /** слот 1 списка текстур (карта нормалей у трасс), если отличается от цвета */ normal?: number; pos: Float32Array; nor: Float32Array; uv: Float32Array; indices: Uint32Array }

const SUB_SIZE = 116;
/** Шаги вершин: 32 — s16 (машины), 28 — float без нормали, 36/44 — float с нормалью s16 (44 — с касательной). */
const STRIDES = [32, 36, 44, 28, 40, 48];

/** Разбор GEOMETRY.bin: все объекты (все LOD и детали тюнинга). */
export function parseNfsGeometry(u: Uint8Array, filter?: (name: string) => boolean): { parts: NfsPart[]; total: number; skipped: string[] } {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const top = bbChunks(u, 0, u.length).find((c) => c.id === BB_GEOMETRY);
  if (!top) throw new Error('Не геометрия Black Box (нет чанка 0x80134000)');
  const table = bbFind(u, top.off, top.off + top.size, 0x134004, 2)[0];
  const parts: NfsPart[] = [], skipped: string[] = [];
  if (!table) {
    // трафик, полиция: объекты лежат в файле без сжатия и без таблицы
    const objs = bbFind(u, top.off, top.off + top.size, 0x80134010, 1);
    if (!objs.length) throw new Error('GEOMETRY.bin: нет ни таблицы объектов 0x134004, ни объектов 0x80134010');
    for (const c of objs) {
      const o = u.subarray(c.off - 8, c.off + c.size), name = objectName(o);
      if (filter && !filter(name)) continue;
      try { parts.push(parseObject(o, 0, name)); } catch (err) { skipped.push(`${name}: ${(err as Error).message}`); }
    }
    return { parts, total: objs.length, skipped };
  }
  const n = Math.floor(table.size / 36);
  for (let i = 0; i < n; i++) {
    const e = table.off + i * 36, hash = dv.getUint32(e, true), off = dv.getUint32(e + 4, true), cs = dv.getUint32(e + 8, true), us = dv.getUint32(e + 12, true);
    if (!us || off >= u.length) continue;
    let o: Uint8Array;
    try { o = bbBlocks(u, off, cs, us); } catch { skipped.push(hash.toString(16)); continue; }
    const name = objectName(o);
    if (filter && !filter(name)) continue;
    try { parts.push(parseObject(o, hash, name)); } catch (err) { skipped.push(`${name}: ${(err as Error).message}`); }
  }
  return { parts, total: n, skipped };
}

export function objectName(o: Uint8Array): string {
  const obj = bbChunks(o, 0, o.length).find((c) => c.id === 0x80134010);
  const hdr = obj && bbChunks(o, obj.off, obj.off + obj.size).find((c) => c.id === 0x134011);
  if (!hdr) return '';
  let s = '';
  // в несжатых файлах (трафик) у заголовка бывает выравнивание 0x11 в начале
  for (let i = skipPad(o, hdr.off, hdr.off + hdr.size) + 0xa0; i < hdr.off + hdr.size && o[i]; i++) s += String.fromCharCode(o[i]!);
  return s;
}

export function parseObject(o: Uint8Array, hash: number, name: string): NfsPart {
  const dv = new DataView(o.buffer, o.byteOffset, o.byteLength);
  const obj = bbChunks(o, 0, o.length).find((c) => c.id === 0x80134010);
  if (!obj) throw new Error('нет объекта 0x80134010');
  const kids = bbChunks(o, obj.off, obj.off + obj.size);
  const mesh = kids.find((c) => c.id === 0x80134100);
  const part: NfsPart = { hash, name, subs: [] };
  const mkC = kids.find((c) => c.id === 0x13401a);
  if (mkC) {
    part.markers = [];
    for (let p = skipPad(o, mkC.off, mkC.off + mkC.size); p + 80 <= mkC.off + mkC.size; p += 80) {
      const m = new Float32Array(16);
      for (let k = 0; k < 16; k++) m[k] = dv.getFloat32(p + 16 + k * 4, true);
      part.markers.push({ hash: dv.getUint32(p, true), m });
    }
  }
  if (!mesh) return part;
  const mk = bbChunks(o, mesh.off, mesh.off + mesh.size);
  const subC = mk.find((c) => c.id === 0x134b02), idxC = mk.find((c) => c.id === 0x134b03), vbs = mk.filter((c) => c.id === 0x134b01);
  if (!subC || !idxC || !vbs.length) return part;
  const s0 = skipPad(o, subC.off, subC.off + subC.size), nSub = Math.floor((subC.off + subC.size - s0) / SUB_SIZE);
  const i0 = skipPad(o, idxC.off, idxC.off + idxC.size), nIdx = Math.floor((idxC.off + idxC.size - i0) / 2);
  // список текстур объекта (0x134012: {хеш, 0}); подмеш ссылается на него номером @40 (слоты: цвет, нормали, …)
  const tl = kids.find((c) => c.id === 0x134012), texList: number[] = [];
  if (tl) for (let p = tl.off; p + 8 <= tl.off + tl.size; p += 8) texList.push(dv.getUint32(p, true));
  const subs = Array.from({ length: nSub }, (_, k) => {
    const e = s0 + k * SUB_SIZE, key = dv.getUint32(e + 4, true), ti = o[e + 40]!, ni = o[e + 41]!;
    return { key, normal: ni !== ti && ni < texList.length ? texList[ni] : undefined, texture: ti < texList.length ? texList[ti]! : key, format: dv.getUint32(e + 8, true), verts: dv.getUint32(e + 64, true), count: dv.getUint32(e + 68, true), start: dv.getUint32(e + 76, true) };
  });
  // буферы вершин заполняются подмешами по порядку (вершины подмешей идут подряд): к буферу добавляем подмеши, пока
  // размер не делится ровно на шаг 32 (упакованные s16 у машин) или 28/36/44 (float — трассы, номерной знак); иначе — запасной вариант:
  // буфер по порядку появления «формата» подмеша, шаг — из суммы вершин
  const starts = vbs.map((c) => skipPad(o, c.off, c.off + c.size)), bytes = vbs.map((c, k) => c.off + c.size - starts[k]!);
  const seq: number[] = [], strides: number[] = [];
  {
    let k = 0, acc = 0;
    for (const s of subs) {
      if (k >= vbs.length) { seq.length = 0; break; }
      seq.push(k); acc += s.verts;
      const st = STRIDES.find((x) => acc * x === bytes[k]);
      if (st) { strides[k] = st; k++; acc = 0; }
    }
    if (k !== vbs.length || acc) seq.length = 0;
  }
  const fmtOrder: number[] = [];
  for (const s of subs) if (!fmtOrder.includes(s.format)) fmtOrder.push(s.format);
  const vbOf = (i: number) => (seq.length ? seq[i]! : fmtOrder.length === vbs.length ? fmtOrder.indexOf(subs[i]!.format) : 0);
  const vbInfo = vbs.map((_, k) => {
    const nv = subs.reduce((a, s, i) => a + (vbOf(i) === k ? s.verts : 0), 0);
    const st = seq.length ? strides[k]! : nv ? Math.floor(bytes[k]! / nv) : 32, stride = st >= 24 && st <= 64 ? st : 32;
    return { start: starts[k]!, stride, count: Math.floor(bytes[k]! / stride) };
  });
  // «развёрнутые» экземпляры (DEINST у трасс): копии одной детали в общем буфере, у каждой — своя матрица 4×4
  // (0x134c06, строки — оси и перенос); перед каждым буфером вершин — его диапазоны {первая, последняя, номер матрицы, 0}
  // (0x134c05, номера вершин внутри буфера)
  const mC = mk.find((c) => c.id === 0x134c06), rCs = mk.filter((c) => c.id === 0x134c05);
  let mats: Float32Array | null = null;
  const vbRanges: number[][][] = [];
  if (mC && rCs.length === vbs.length) {
    const m0 = skipPad(o, mC.off, mC.off + mC.size);
    mats = new Float32Array(Math.floor((mC.off + mC.size - m0) / 4));
    for (let k = 0; k < mats.length; k++) mats[k] = dv.getFloat32(m0 + k * 4, true);
    for (const rC of rCs) {
      const r: number[][] = [];
      for (let p = skipPad(o, rC.off, rC.off + rC.size); p + 16 <= rC.off + rC.size; p += 16) r.push([dv.getUint32(p, true), dv.getUint32(p + 4, true), dv.getUint32(p + 8, true)]);
      vbRanges.push(r);
    }
  }
  const matOf = (k: number, v: number): number => {
    if (!mats) return -1;
    for (const [a, b, m] of vbRanges[k] ?? []) if (v >= a! && v <= b!) return (m! + 1) * 16 <= mats.length ? m! * 16 : -1;
    return -1;
  };
  for (const [i, s] of subs.entries()) {
    const vb = vbInfo[vbOf(i)];
    if (!vb || !s.count || s.start + s.count > nIdx) continue;
    const remap = new Map<number, number>(), idx = new Uint32Array(s.count), P: number[] = [], N: number[] = [], T: number[] = [], C: number[] = [];
    let bad = false, noNormal = false;
    for (let k = 0; k < s.count; k++) {
      const v = dv.getUint16(i0 + (s.start + k) * 2, true);
      if (v >= vb.count) { bad = true; break; }
      let r = remap.get(v);
      if (r === undefined) {
        r = remap.size; remap.set(v, r);
        const p = vb.start + v * vb.stride;
        if (vb.stride !== 32) {
          // float: позиция @0, цвет (28) или нормаль s16 @12 (36, 44), UV @20; без нормали досчитаем по граням
          P.push(dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true));
          T.push(dv.getFloat32(p + 20, true), dv.getFloat32(p + 24, true));
          { const c = p + (vb.stride >= 36 ? 28 : 12); C.push(o[c]!, o[c + 1]!, o[c + 2]!, o[c + 3]!); }
          if (vb.stride >= 36) {
            let nx = dv.getInt16(p + 12, true) / 32767, ny = dv.getInt16(p + 14, true) / 32767, nz = dv.getInt16(p + 16, true) / 32767;
            const l = Math.hypot(nx, ny, nz);
            if (l > 0.5 && l < 1.5) { nx /= l; ny /= l; nz /= l; } else noNormal = true;
            N.push(nx, ny, nz);
          } else { noNormal = true; N.push(0, 0, 1); }
          const mo = matOf(vbOf(i), v);
          if (mo >= 0) {
            const M = mats!, q = P.length - 3, x = P[q]!, y = P[q + 1]!, z = P[q + 2]!, nx = N[q]!, ny = N[q + 1]!, nz = N[q + 2]!;
            for (let c = 0; c < 3; c++) {
              P[q + c] = x * M[mo + c]! + y * M[mo + 4 + c]! + z * M[mo + 8 + c]! + M[mo + 12 + c]!;
              N[q + c] = nx * M[mo + c]! + ny * M[mo + 4 + c]! + nz * M[mo + 8 + c]!;
            }
            const l = Math.hypot(N[q]!, N[q + 1]!, N[q + 2]!) || 1; N[q] = N[q]! / l; N[q + 1] = N[q + 1]! / l; N[q + 2] = N[q + 2]! / l;
          }
        } else {
          P.push(dv.getInt16(p, true) / 4096, dv.getInt16(p + 2, true) / 4096, dv.getInt16(p + 4, true) / 4096);
          T.push(dv.getInt16(p + 8, true) / 4096, dv.getInt16(p + 10, true) / 4096); // V как в Direct3D (сверху вниз)
          let nx = dv.getInt16(p + 16, true) / 32767, ny = dv.getInt16(p + 18, true) / 32767, nz = dv.getInt16(p + 20, true) / 32767;
          const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
          N.push(nx, ny, nz);
        }
      }
      idx[k] = r;
    }
    if (bad) continue;
    const pos = Float32Array.from(P);
    const sub: NfsSub = { texture: s.texture, key: s.key, normal: s.normal, pos, nor: noNormal ? computeNormals(pos, idx) : Float32Array.from(N), uv: Float32Array.from(T), indices: idx };
    if (C.length === P.length / 3 * 4) sub.shade = Uint8Array.from(C);
    part.subs.push(sub);
  }
  return part;
}

/** Деталь видна по умолчанию: кузов BASE и стоковый обвес KIT00 (и целые детали DAMAGE0); без помятых, капотов STYLE, водителя-женщины, колёс и тормозов (их позиции не в геометрии). */
export function nfsPartVisible(name: string): boolean {
  const n = name.toUpperCase();
  // DAMAGE0 — целое состояние (у полицейских и трафика все детали такие), DAMAGE1+ — помятые
  if (/_(STYLE\d+|KITW\d+|KIT(?!00_)\d+)_/.test(n) || /DAMAGE[1-9]/.test(n)) return false;
  if (/DRIVER_FEMALE|WINDOW_CARSKINUV|_TIRE|_BRAKE_|_BRAKE$|_WHEEL|_RIM/.test(n)) return false;
  return true;
}

/** Хеши текстур, создаваемых игрой на лету (окраска/винилы, номерной знак): показываем цветом. */
const RUNTIME_TEXTURES: Record<number, { label: string; color: number[] }> = {
  0xe1c9231e: { label: 'окраска кузова (создаётся игрой)', color: [0.62, 0.64, 0.68] },
  0x3617dcfc: { label: 'надпись на стекле (создаётся игрой)', color: [0.92, 0.92, 0.9] },
};

const PAINT = 0xe1c9231e, PLATE_WORLD = 0xa9aa415f; // LICENSEPLATE_WORLD
const PLATE_REAR = 0xc805f7e0, PLATE_FRONT = 0xaa35c17f; // binHash('REAR_LICENSE_PLATE'), binHash('FRONT_LICENSE_PLATE')

/** Номер 30×15 см в плоскости маркера: строка 1 — ширина, строка 0 — высота, строка 2 — нормаль (наружу). */
export function plateQuad(m: Float32Array, img: DecodedImage, name: string): Mesh {
  const W = 0.15, H = 0.075, off = 0.003, ax = [m[4]!, m[5]!, m[6]!], ay = [m[0]!, m[1]!, m[2]!], n = [m[8]!, m[9]!, m[10]!], t = [m[12]! + n[0]! * off, m[13]! + n[1]! * off, m[14]! + n[2]! * off];
  const pt = (sx: number, sy: number) => [0, 1, 2].map((c) => t[c]! + ax[c]! * sx * W + ay[c]! * sy * H);
  const pos = Float32Array.from([...pt(1, 1), ...pt(-1, 1), ...pt(-1, -1), ...pt(1, -1)]);
  return {
    name, texture: img.name ?? 'plate', vertexCount: 4, pos, nor: Float32Array.from([...n, ...n, ...n, ...n]), uv: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    bone: new Float32Array(0), weight: new Float32Array(0), indices: new Uint16Array([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]), skinned: false, image: img,
  };
}

/** Цвет окраски с наложенной текстурой (альфа — маска эмблем и линий). */
function paintOver(color: number[], over: DecodedImage): DecodedImage {
  const src = over.rgba!, out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]! / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(color[c]! * 255 * (1 - a) + src[i + c]! * a);
    out[i + 3] = 255;
  }
  return { width: over.width, height: over.height, rgba: out, name: over.name };
}

export async function loadNfsCar(main: VFile, ctx: LoadContext): Promise<Model> {
  const u = new Uint8Array(await main.arrayBuffer());
  const opt = ctx.options ?? {}, paint = (PAINTS.find((p) => p.id === opt.paint) ?? PAINTS[0]!).rgb;
  const lodOf = (n: string) => /_([A-E])$/i.exec(n)?.[1]?.toUpperCase() ?? 'A';
  // все LOD: A показан, B–E — скрытыми мешами в списке
  const { parts, total, skipped } = parseNfsGeometry(u);
  // текстуры: TEXTURES.BIN рядом, затем общие CARS/TEXTURES.BIN
  const tex = new Map<number, BbTexture>(), packs: string[] = [];
  const add = (buf: ArrayBuffer | Uint8Array | null, label: string) => {
    if (!buf) return;
    const before = tex.size;
    try { readTpks(unLzc(buf instanceof Uint8Array ? buf : new Uint8Array(buf)), tex); } catch { /* пакет не прочитан */ }
    if (tex.size > before) packs.push(`${label} (${tex.size - before})`);
  };
  add(await ctx.sibling('TEXTURES.BIN'), 'TEXTURES.BIN машины');
  const dir = (main.path ?? '').replace(/[^/]*$/, '');
  const carsRoot = /(^|\/)cars\/[^/]+\/$/i.test(dir) ? dir.replace(/[^/]+\/$/, '') : 'cars/', gameRoot = carsRoot.replace(/cars\/$/i, '');
  add(await ctx.readPath(carsRoot + 'textures.bin'), 'CARS/TEXTURES.BIN');
  // общие текстуры игры (чёрный, стёкла, сетки, водитель): GLOBAL/GlobalB.lzc и InGameA.lzc — распаковываются один раз
  for (const [path, label] of [['global/globalb.lzc', 'GLOBAL/GlobalB.lzc'], ['global/ingamea.lzc', 'GLOBAL/InGameA.lzc']] as const) {
    const before = tex.size;
    for (const [h, t] of await globalPack(ctx, gameRoot + path)) if (!tex.has(h)) tex.set(h, t);
    if (tex.size > before) packs.push(`${label} (${tex.size - before})`);
  }
  // номерной знак: игра пишет текст поверх фона; фон «мирового» номера — из GLOBAL/LicensePlates.bin (записи в .stp)
  let plateTex: BbTexture | null = null;
  {
    try {
      const idx = await ctx.readPath(gameRoot + 'global/licenseplates.bin'), e = idx && tpkEntries(idx).find((x) => x.hash === PLATE_WORLD);
      const stp = e && await ctx.readPath(`${gameRoot}global/licenseplates/${PLATE_WORLD.toString(16).toUpperCase().padStart(8, '0')}.stp`.toLowerCase());
      if (e && stp) { plateTex = stpTexture(e, stp); packs.push('GLOBAL/LicensePlates (номер)'); }
    } catch { /* нет номеров */ }
  }
  const images = new Map<number, DecodedImage | null>(), failed = new Set<string>();
  const image = (h: number): DecodedImage | null => {
    if (images.has(h)) return images.get(h)!;
    const t = tex.get(h);
    let img: DecodedImage | null = null;
    if (t) try { img = decodeBbTexture(t); } catch (e) { failed.add((e as Error).message); }
    images.set(h, img);
    return img;
  };
  // слоты, которые игра подменяет по состоянию (фары вкл/выкл, стёкла): по имени детали — текстура машины
  const byName = new Map<string, number>();
  for (const t of tex.values()) byName.set(t.name.toUpperCase(), t.hash);
  const car = (main.path ?? '').match(/(?:^|\/)cars\/([^/]+)\//i)?.[1]?.toUpperCase()
    ?? [...tex.values()].find((t) => /^CARTEMPLATETEXTURES_/i.test(t.pack))?.pack.replace(/^CARTEMPLATETEXTURES_/i, '').toUpperCase() ?? '';
  const slot = (partName: string): number | undefined => {
    const n = partName.toUpperCase(), kit = /_(KIT\w*?\d+)_/.exec(n)?.[1] ?? 'KIT00';
    const kind = /HEADLIGHT_GLASS/.test(n) ? 'HEADLIGHT_GLASS' : /BRAKELIGHT_GLASS/.test(n) ? 'BRAKELIGHT_GLASS' : /HEADLIGHT/.test(n) ? 'HEADLIGHT' : /BRAKELIGHT/.test(n) ? 'BRAKELIGHT' : /WINDOW/.test(n) ? 'WINDOW' : '';
    if (kind === 'WINDOW') return byName.get('WINDOW_FRONT');
    if (!kind) return undefined;
    for (const k of new Set([kit, 'KIT00'])) for (const st of ['OFF', 'ON']) { const h = byName.get(`${car}_${k}_${kind}_${st}`); if (h !== undefined) return h; }
    return undefined;
  };
  const names = new Set(parts.map((p) => p.name.toUpperCase()));
  const visible = (n: string) => nfsPartVisible(n) && !(/_DAMAGE0_/i.test(n) && names.has(n.toUpperCase().replace('_DAMAGE0_', '_')));
  const meshes: Mesh[] = [], missing = new Set<string>(), runtime = new Set<string>();
  for (const part of parts) {
    // подмеши одной текстуры — в один меш
    // ключ материала подмеша (@4) — сама текстура или окраска; не нашлась — слот по имени детали, затем текстура из
    // списка объекта (шины, тормозные диски, стёкла)
    const pick = (s: NfsSub): number => {
      const k = s.key ?? s.texture;
      return tex.has(k) || RUNTIME_TEXTURES[k] ? k : slot(part.name) ?? (tex.has(s.texture) ? s.texture : k);
    };
    // окраска: поверх цвета кузова игра кладёт текстуру из списка объекта (эмблемы, линии дверей — <машина>_BADGING)
    const groups = new Map<string, { h: number; over: number; list: NfsSub[] }>();
    for (const s of part.subs) {
      const h = pick(s), over = RUNTIME_TEXTURES[h] && h === PAINT && s.texture !== h && tex.has(s.texture) ? s.texture : 0, key = `${h}:${over}`;
      if (!groups.has(key)) groups.set(key, { h, over, list: [] });
      groups.get(key)!.list.push(s);
    }
    for (const { h, over, list } of groups.values()) {
      const nv = list.reduce((a, s) => a + s.pos.length / 3, 0), ni = list.reduce((a, s) => a + s.indices.length, 0);
      const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
      let vo = 0, io = 0;
      for (const s of list) {
        pos.set(s.pos, vo * 3); nor.set(s.nor, vo * 3); uv.set(s.uv, vo * 2);
        for (let k = 0; k < s.indices.length; k++) idx[io + k] = s.indices[k]! + vo;
        vo += s.pos.length / 3; io += s.indices.length;
      }
      const t = tex.get(h), img = image(h), rt = RUNTIME_TEXTURES[h];
      const texName = t?.name ?? rt?.label ?? `0x${h.toString(16).padStart(8, '0')}`;
      if (!t) (rt ? runtime : missing).add(texName);
      const m: Mesh = {
        name: `${part.name} · ${texName}`, texture: texName, vertexCount: nv, pos, nor, uv,
        bone: new Float32Array(nv * 4), weight: new Float32Array(nv * 4).map((_, k) => (k % 4 === 0 ? 1 : 0)), indices: idx, skinned: false,
      };
      const overImg = over ? image(over) : null;
      if (img) m.image = img;
      else if (rt && overImg) { m.image = paintOver(h === PAINT ? paint : rt.color, overImg); m.name = `${part.name} · ${texName} + ${tex.get(over)!.name}`; }
      else if (rt) m.color = h === PAINT ? [...paint] : rt.color;
      else m.color = [0.6, 0.6, 0.6];
      if (img && t && /GRILL|MESH|BADG|DECAL|LOGO|EMBLEM|TIRE|RIM|WHEEL|ROTOR|CALIPER/i.test(t.name)) m.alphaTest = true;
      // накладки без текстуры (линии дверей) закрыли бы кузов сплошным цветом
      if (lodOf(part.name) !== 'A' || !visible(part.name) || (!img && !rt && /DOORLINE/i.test(part.name))) m.defaultHidden = true;
      meshes.push(m);
    }
  }
  if (!meshes.length) throw new Error('GEOMETRY.bin: не найдено ни одного меша');
  // библиотеки деталей (CARS/WHEELS, SPOILER_*, EXHAUST…): ни одна деталь не подходит под правила — показываем все
  const lodA = (m: Mesh) => lodOf(m.name.split(' · ')[0]!) === 'A';
  const library = !meshes.some((m) => !m.defaultHidden);
  if (library) {
    // у библиотек — только LOD A (сетка из всех LOD была бы вчетверо больше)
    for (let i = meshes.length - 1; i >= 0; i--) if (!lodA(meshes[i]!)) meshes.splice(i, 1);
    for (const m of meshes) delete m.defaultHidden;
    layoutGrid(meshes);
  }
  // колесо с диском из библиотеки (выбор «Колёса»), иначе — шина машины
  let wheelMeshes: Mesh[] | undefined, wheelName = '';
  if (!library && opt.wheel && opt.wheel !== 'none') {
    try {
      const w = await loadWheel(ctx, carsRoot, opt.wheel);
      if (w) {
        wheelName = w.name;
        for (const [h, t] of w.tex) if (!tex.has(h)) tex.set(h, t);
        wheelMeshes = simpleMeshes(parseObject(w.data, 0, w.name), (h) => { const t = tex.get(h); let img: DecodedImage | null = null; if (t) try { img = decodeBbTexture(t); } catch { /* нет */ } return { img, name: t?.name ?? h.toString(16) }; });
      }
    } catch { /* колесо не прочитано */ }
  }
  const wheels = library ? null : placeWheels(meshes, wheelMeshes);
  // кожа кузова: заглушка <машина>_SKIN1 (ровный серый) → цвет окраски и винил
  let vinylNote = '';
  if (!library) {
    const skinMeshes = meshes.filter((m) => /_SKIN1$/i.test(m.texture) && m.image && isFlat(m.image));
    if (skinMeshes.length) {
      let vinyl = null;
      if (opt.vinyl && opt.vinyl !== 'none') { try { vinyl = await loadVinyl(ctx, gameRoot, opt.vinyl); } catch { vinyl = null; } vinylNote = vinyl ? '' : 'винил не прочитан'; }
      const skin = composeSkin(1024, paint, vinyl, (opt.place as VinylPlace) || 'sides');
      for (const m of skinMeshes) m.image = skin;
    }
  }
  // номерные знаки: игра рисует их сама по маркерам REAR/FRONT_LICENSE_PLATE видимых деталей
  let plates = 0;
  if (!library && plateTex) {
    let plateImg: DecodedImage | null = null;
    try { plateImg = decodeBbTexture(plateTex); } catch { /* не декодирован */ }
    const done = new Set<number>();
    for (const part of parts) {
      if (lodOf(part.name) !== 'A' || !visible(part.name) || !part.markers) continue;
      for (const mk of part.markers) if ((mk.hash === PLATE_REAR || mk.hash === PLATE_FRONT) && !done.has(mk.hash) && plateImg) {
        done.add(mk.hash); plates++;
        meshes.push(plateQuad(mk.m, plateImg, `номер ${mk.hash === PLATE_REAR ? 'задний' : 'передний'} · ${plateTex.name}`));
      }
    }
  }
  const shown = meshes.filter((m) => !m.defaultHidden);
  const info = [
    `Need for Speed: World — ${library ? 'библиотека деталей' : 'машина'}: объектов ${total}, деталей LOD A ${parts.filter((p) => lodOf(p.name) === 'A').length} (LOD B–E — ${parts.filter((p) => lodOf(p.name) !== 'A').length}, скрыты), мешей ${meshes.length} (видно ${shown.length}), вершин ${sumVerts(shown)}, треугольников ${sumTris(shown)}`,
    'По умолчанию показан кузов BASE и стоковый обвес KIT00; остальные обвесы (KIT/KITW), капоты STYLE и повреждения — в списке мешей.',
    plates ? `Номерной знак (${plates}) — фон «мирового» номера LICENSEPLATE_WORLD на маркере; надпись игрок выбирает сам.` : '',
    wheels ? `Колёса и тормозные диски расставлены по аркам кузова (оси x ${wheels.front.toFixed(2)} / ${wheels.rear.toFixed(2)} м, колея ${(wheels.half * 2).toFixed(2)} м): в файлах игры их позиций нет — игра берёт их из настроек машины. Диски (WHEELS*) выбираются тюнингом и не ставятся.` : 'Колёса и тормоза — в списке мешей (в начале координат).',
    packs.length ? `Текстуры: ${packs.join(', ')}` : 'Текстуры не найдены: откройте «Папку игры» или выберите TEXTURES.BIN вместе с GEOMETRY.bin',
  ];
  if (runtime.size) info.push(`Без файла (создаются игрой): ${[...runtime].join('; ')} — показаны цветом`);
  if (missing.size) info.push(`Текстуры не найдены: ${[...missing].slice(0, 12).join(', ')}${missing.size > 12 ? '…' : ''}`);
  if (failed.size) info.push(`Не декодированы: ${[...failed].slice(0, 5).join('; ')}`);
  if (skipped.length) info.push(`Пропущены объекты: ${skipped.slice(0, 5).join('; ')}`);
  if (wheelName) info.push(`Колёса: ${wheelName} (библиотека дисков игры)`);
  if (vinylNote) info.push(vinylNote);
  // настройки вида: окраска, винил, место винила, колёса
  const options: ModelOption[] = [];
  if (!library) {
    options.push({ id: 'paint', label: 'Окраска', values: PAINTS.map((p) => ({ id: p.id, label: p.label })), value: opt.paint ?? PAINTS[0]!.id });
    if (meshes.some((m) => /_SKIN1$/i.test(m.texture))) {
      const vl = await vinylList(ctx, gameRoot).catch(() => []);
      if (vl.length) {
        options.push({ id: 'vinyl', label: 'Винил', values: [{ id: 'none', label: 'нет' }, ...vl], value: opt.vinyl ?? 'none' });
        options.push({ id: 'place', label: 'Место винила', values: [{ id: 'sides', label: 'бока' }, { id: 'hood', label: 'капот' }], value: opt.place ?? 'sides' });
      }
    }
    if (wheels) {
      const wl = await wheelList(ctx, carsRoot).catch(() => []);
      if (wl.length) options.push({ id: 'wheel', label: 'Колёса', values: [{ id: 'none', label: 'шины машины (без дисков)' }, ...wl.map((w) => ({ id: w.id, label: w.label }))], value: opt.wheel ?? 'none' });
    }
  }
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(shown.length ? shown : meshes), flipZ: false, defaultZUp: true, cameraYaw: 0, info: info.filter(Boolean), options };
}

/**
 * Колёса: шина и тормозной диск лежат в начале координат (ось — Y; у шины наружная сторона — у y = 0, задник — у y = ширина).
 * Позиции — по аркам кузова: у боковых вершин кузова (BASE, KIT00 BODY/бамперы/пороги) минимальная высота по x резко растёт
 * над колесом; центр арки — ось, верх арки минус радиус шины — высота оси. Копии шины и диска ставятся на 4 места.
 */
export function placeWheels(meshes: Mesh[], wheel?: Mesh[]): { front: number; rear: number; half: number } | null {
  const partOf = (m: Mesh) => m.name.split(' · ')[0]!.toUpperCase();
  const tire = (axle: 'FRONT' | 'REAR') => meshes.filter((m) => new RegExp(`_KIT00_${axle}_TIRE_A$|_${axle}_TIRE_A$`).test(partOf(m)));
  const brake = (axle: 'FRONT' | 'REAR') => meshes.filter((m) => new RegExp(`_KIT00_${axle}_BRAKE_A$|_${axle}_BRAKE_A$`).test(partOf(m)));
  const ft = tire('FRONT'), rt = tire('REAR').length ? tire('REAR') : ft;
  if (!ft.length) return null;
  const tb = boundsOf(ft), radius = (tb.max[2]! - tb.min[2]!) / 2, width = tb.max[1]! - tb.min[1]!;
  if (!(radius > 0.1 && radius < 1)) return null;
  const body = meshes.filter((m) => !m.defaultHidden && /_BASE_A$|_KIT00_(DAMAGE0_)?(BODY|FRONT_BUMPER|REAR_BUMPER|SKIRT\w*|SIDE\w*|LEFT_DOOR|RIGHT_DOOR)_A$/.test(partOf(m)));
  if (!body.length) return null;
  // ширина — по нижней части кузова (зеркала и обвес крыши шире колеи)
  let zmin = Infinity, ymax = 0;
  for (const m of body) for (let k = 2; k < m.pos.length; k += 3) zmin = Math.min(zmin, m.pos[k]!);
  for (const m of body) for (let k = 0; k < m.pos.length; k += 3) if (m.pos[k + 2]! < zmin + radius * 2) ymax = Math.max(ymax, Math.abs(m.pos[k + 1]!));
  const STEP = 0.05, minZ = new Map<number, number>(), minZ2 = new Map<number, number>();
  for (const m of body) for (let k = 0; k < m.pos.length; k += 3) {
    const ay = Math.abs(m.pos[k + 1]!), b = Math.round(m.pos[k]! / STEP);
    if (ay > ymax * 0.75) minZ.set(b, Math.min(minZ.get(b) ?? Infinity, m.pos[k + 2]!));
    if (ay > ymax * 0.4) minZ2.set(b, Math.min(minZ2.get(b) ?? Infinity, m.pos[k + 2]!));
  }
  const present = [...minZ.keys()], zs = present.map((b) => minZ.get(b)!).sort((a, b) => a - b);
  const low = zs[Math.floor(zs.length * 0.2)] ?? 0;
  // в проёме арки боковых вершин может не быть совсем: пустой шаг — по вершинам ближе к середине, иначе «поднят»
  const b0 = Math.min(...present), b1 = Math.max(...present), keys: number[] = [], real = new Set(present);
  // пропуски: короткий (до 15 см) — как соседние шаги (двери, пороги); длинный — проём арки
  const sorted = [...present].sort((a, b) => a - b);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const l = sorted[i]!, r = sorted[i + 1]!, gap = r - l - 1;
    for (let b = l + 1; b < r; b++) minZ.set(b, minZ2.get(b) ?? (gap <= 3 ? Math.min(minZ.get(l)!, minZ.get(r)!) : low + radius * 1.5));
  }
  for (let b = b0; b <= b1; b++) keys.push(b);
  // кандидаты — участки, где низ боковины поднят над порогом (0,6…1 радиуса); оценка — сумма высот по шагам с настоящими
  // вершинами (выше 2 радиусов не считаем). Передняя арка — в передних 32 % длины, задняя — в задних 32 %
  type Run = { a: number; b: number; top: number; score: number };
  const runs: Run[] = [];
  for (const thr of [0.6, 0.8, 0.9, 1.0]) {
    let cur: Run | null = null;
    for (const b of keys) {
      const z = minZ.get(b)!;
      if (z - low < radius * thr) continue;
      if (cur && b - cur.b <= 2) { cur.b = b; cur.top = Math.max(cur.top, z); } else { cur = { a: b, b, top: z, score: 0 }; runs.push(cur); }
      if (real.has(b)) cur.score += Math.min(z - low, radius * 2);
    }
  }
  const L = b1 - b0, ok = (r: Run) => { const len = (r.b - r.a + 1) * STEP; return len > radius * 0.8 && len < radius * 4; };
  const best = (pred: (c: number) => boolean) => runs.filter((r) => ok(r) && pred((r.a + r.b) / 2)).sort((x, y) => y.score - x.score)[0];
  // сначала узкие зоны (двери и пороги не путаются с арками), не нашлось — шире
  const fa = best((c) => c > b0 + L * 0.68) ?? best((c) => c > b0 + L * 0.6), ra = best((c) => c < b0 + L * 0.32) ?? best((c) => c < b0 + L * 0.4);
  if (!fa || !ra) return null;
  const spot = (r: Run) => ({ x: ((r.a + r.b) / 2) * STEP, z: r.top - radius - 0.01 });
  const front = spot(fa), rear = spot(ra), half = ymax - width / 2;
  // колесо из библиотеки (шина с диском, тот же вид: ось Y, от y = 0 наружу) — вместо шины машины, в масштабе её радиуса
  let wheelScale = 1;
  if (wheel?.length) { const wb = boundsOf(wheel), wr = (wb.max[2]! - wb.min[2]!) / 2; if (wr > 0.05) wheelScale = radius / wr; }
  // шина и колесо: наружная сторона (диск) — у y = 0, смотрит в −Y, задник шины — у y = ширина; для левой стороны (+Y)
  // разворот на 180° вокруг вертикали, для правой — как есть. Тормозной диск — наоборот: от y = 0 наружу
  const place = (list: Mesh[], x: number, z: number, side: 1 | -1, tag: string, k0 = 1, outerAtZero = true) => {
    const r = outerAtZero ? -side : side, off = outerAtZero ? side * (half + width / 2) : side * (half - width / 2);
    for (const m of list) {
      const pos = new Float32Array(m.pos.length), nor = new Float32Array(m.nor.length);
      for (let k = 0; k < m.pos.length; k += 3) {
        pos[k] = r * m.pos[k]! * k0 + x; pos[k + 1] = r * m.pos[k + 1]! * k0 + off; pos[k + 2] = m.pos[k + 2]! * k0 + z;
        nor[k] = r * m.nor[k]!; nor[k + 1] = r * m.nor[k + 1]!; nor[k + 2] = m.nor[k + 2]!;
      }
      const c: Mesh = { ...m, name: `${tag} · ${m.name}`, pos, nor };
      delete c.defaultHidden;
      meshes.push(c);
    }
  };
  for (const [axle, x, z] of [['FRONT', front.x, front.z], ['REAR', rear.x, rear.z]] as const) {
    const t = axle === 'FRONT' ? ft : rt, br = brake(axle);
    for (const side of [1, -1] as const) {
      const tag = `колесо ${axle === 'FRONT' ? 'переднее' : 'заднее'} ${side > 0 ? 'левое' : 'правое'}`;
      if (wheel?.length) place(wheel, x, z, side, tag, wheelScale); else place(t, x, z, side, tag);
      place(br, x, z, side, tag, 1, false);
    }
  }
  return { front: front.x, rear: rear.x, half };
}

/** Меши детали по текстурам (колёса из библиотеки). */
function simpleMeshes(part: NfsPart, image: (h: number) => { img: DecodedImage | null; name: string }): Mesh[] {
  const groups = new Map<number, NfsSub[]>();
  for (const s of part.subs) { if (!groups.has(s.texture)) groups.set(s.texture, []); groups.get(s.texture)!.push(s); }
  const out: Mesh[] = [];
  for (const [h, list] of groups) {
    const nv = list.reduce((a, s) => a + s.pos.length / 3, 0), ni = list.reduce((a, s) => a + s.indices.length, 0);
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const s of list) { pos.set(s.pos, vo * 3); nor.set(s.nor, vo * 3); uv.set(s.uv, vo * 2); for (let k = 0; k < s.indices.length; k++) idx[io + k] = s.indices[k]! + vo; vo += s.pos.length / 3; io += s.indices.length; }
    const { img, name } = image(h);
    const m: Mesh = { name: `${part.name} · ${name}`, texture: name, vertexCount: nv, pos, nor, uv, bone: new Float32Array(0), weight: new Float32Array(0), indices: idx, skinned: false };
    // у дисков альфа — маска хрома/краски, не прозрачность; у шины — вырезы протектора
    if (img) { m.image = img; if (/TIRE/i.test(name)) m.alphaTest = true; } else m.color = [0.5, 0.5, 0.5];
    out.push(m);
  }
  return out;
}

const globalCache = new Map<string, { key: unknown; tex: Map<number, BbTexture> }>();
/** Пакет текстур игры: кэш по пути и открытым архивам (GlobalB — 28 МБ после распаковки). */
async function globalPack(ctx: LoadContext, path: string): Promise<Map<number, BbTexture>> {
  const key = ctx.archives[0] ?? null, hit = globalCache.get(path);
  if (hit && hit.key === key) return hit.tex;
  const tex = new Map<number, BbTexture>();
  try { const u = await ctx.readPath(path); if (u) readTpks(unLzc(u), tex); } catch { /* нет пакета */ }
  globalCache.set(path, { key, tex });
  return tex;
}

/** Детали библиотеки стоят в начале координат друг на друге: раскладываем их сеткой (по имени детали до « · »). */
function layoutGrid(meshes: Mesh[]): void {
  const groups = new Map<string, Mesh[]>();
  for (const m of meshes) { const k = m.name.split(' · ')[0]!; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(m); }
  if (groups.size < 2) return;
  let span = 0;
  for (const list of groups.values()) { const b = boundsOf(list); span = Math.max(span, b.max[0] - b.min[0], b.max[1] - b.min[1]); }
  const step = span * 1.25 || 1, cols = Math.ceil(Math.sqrt(groups.size));
  [...groups.values()].forEach((list, i) => {
    const dx = (i % cols) * step, dy = -Math.floor(i / cols) * step;
    for (const m of list) for (let k = 0; k < m.pos.length; k += 3) { m.pos[k] += dx; m.pos[k + 1] += dy; }
  });
}
