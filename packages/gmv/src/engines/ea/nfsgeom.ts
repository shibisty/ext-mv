// Need for Speed: World — машины (CARS/<машина>/GEOMETRY.bin + TEXTURES.BIN). Таблица объектов 0x134004 →
// сжатые объекты 0x80134010: заголовок (имя, габариты), хеши текстур, меш 0x80134100 с подмешами (116 байт),
// индексами u16 и буферами вершин по 32 байта (позиция s16/4096, UV s16/4096, цвет, нормаль s16/32767, касательная).
import { boundsOf, computeNormals, sumTris, sumVerts } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import type { DecodedImage, Mesh, Model, VFile } from '../../core/types';
import { bbBlocks, bbChunks, bbFind, BB_GEOMETRY, decodeBbTexture, readTpks, skipPad, unLzc, type BbTexture } from './blackbox';

export interface NfsPart { hash: number; name: string; subs: NfsSub[] }
export interface NfsSub { texture: number; pos: Float32Array; nor: Float32Array; uv: Float32Array; indices: Uint32Array }

const SUB_SIZE = 116;

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

function objectName(o: Uint8Array): string {
  const obj = bbChunks(o, 0, o.length).find((c) => c.id === 0x80134010);
  const hdr = obj && bbChunks(o, obj.off, obj.off + obj.size).find((c) => c.id === 0x134011);
  if (!hdr) return '';
  let s = '';
  // в несжатых файлах (трафик) у заголовка бывает выравнивание 0x11 в начале
  for (let i = skipPad(o, hdr.off, hdr.off + hdr.size) + 0xa0; i < hdr.off + hdr.size && o[i]; i++) s += String.fromCharCode(o[i]!);
  return s;
}

function parseObject(o: Uint8Array, hash: number, name: string): NfsPart {
  const dv = new DataView(o.buffer, o.byteOffset, o.byteLength);
  const obj = bbChunks(o, 0, o.length).find((c) => c.id === 0x80134010);
  if (!obj) throw new Error('нет объекта 0x80134010');
  const kids = bbChunks(o, obj.off, obj.off + obj.size);
  const mesh = kids.find((c) => c.id === 0x80134100);
  const part: NfsPart = { hash, name, subs: [] };
  if (!mesh) return part;
  const mk = bbChunks(o, mesh.off, mesh.off + mesh.size);
  const subC = mk.find((c) => c.id === 0x134b02), idxC = mk.find((c) => c.id === 0x134b03), vbs = mk.filter((c) => c.id === 0x134b01);
  if (!subC || !idxC || !vbs.length) return part;
  const s0 = skipPad(o, subC.off, subC.off + subC.size), nSub = Math.floor((subC.off + subC.size - s0) / SUB_SIZE);
  const i0 = skipPad(o, idxC.off, idxC.off + idxC.size), nIdx = Math.floor((idxC.off + idxC.size - i0) / 2);
  const subs = Array.from({ length: nSub }, (_, k) => {
    const e = s0 + k * SUB_SIZE;
    return { texture: dv.getUint32(e + 4, true), format: dv.getUint32(e + 8, true), verts: dv.getUint32(e + 64, true), count: dv.getUint32(e + 68, true), start: dv.getUint32(e + 76, true) };
  });
  // буферы вершин заполняются подмешами по порядку (вершины подмешей идут подряд): к буферу добавляем подмеши, пока
  // размер не делится ровно на шаг 32 (упакованные s16) или 36 (float — номерной знак у трафика); иначе — запасной вариант:
  // буфер по порядку появления «формата» подмеша, шаг — из суммы вершин
  const starts = vbs.map((c) => skipPad(o, c.off, c.off + c.size)), bytes = vbs.map((c, k) => c.off + c.size - starts[k]!);
  const seq: number[] = [], strides: number[] = [];
  {
    let k = 0, acc = 0;
    for (const s of subs) {
      if (k >= vbs.length) { seq.length = 0; break; }
      seq.push(k); acc += s.verts;
      const st = [32, 36].find((x) => acc * x === bytes[k]);
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
  for (const [i, s] of subs.entries()) {
    const vb = vbInfo[vbOf(i)];
    if (!vb || !s.count || s.start + s.count > nIdx) continue;
    const remap = new Map<number, number>(), idx = new Uint32Array(s.count), P: number[] = [], N: number[] = [], T: number[] = [];
    let bad = false;
    for (let k = 0; k < s.count; k++) {
      const v = dv.getUint16(i0 + (s.start + k) * 2, true);
      if (v >= vb.count) { bad = true; break; }
      let r = remap.get(v);
      if (r === undefined) {
        r = remap.size; remap.set(v, r);
        const p = vb.start + v * vb.stride;
        if (vb.stride === 36) {
          // float: позиция @0, UV @20; нормаль досчитаем по граням
          P.push(dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true));
          T.push(dv.getFloat32(p + 20, true), dv.getFloat32(p + 24, true));
          N.push(0, 0, 0);
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
    part.subs.push({ texture: s.texture, pos, nor: vb.stride === 36 ? computeNormals(pos, idx) : Float32Array.from(N), uv: Float32Array.from(T), indices: idx });
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
  0x3617dcfc: { label: 'номерной знак (создаётся игрой)', color: [0.92, 0.92, 0.9] },
};

export async function loadNfsCar(main: VFile, ctx: LoadContext): Promise<Model> {
  const u = new Uint8Array(await main.arrayBuffer());
  const lodOf = (n: string) => /_([A-E])$/i.exec(n)?.[1]?.toUpperCase() ?? 'A';
  const { parts, total, skipped } = parseNfsGeometry(u, (n) => lodOf(n) === 'A');
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
    const groups = new Map<number, NfsSub[]>();
    for (const s of part.subs) { if (!groups.has(s.texture)) groups.set(s.texture, []); groups.get(s.texture)!.push(s); }
    for (const [h0, list] of groups) {
      const h = tex.has(h0) || RUNTIME_TEXTURES[h0] ? h0 : slot(part.name) ?? h0;
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
      if (img) m.image = img;
      else if (rt) m.color = rt.color;
      else m.color = [0.6, 0.6, 0.6];
      if (img && t && /GRILL|MESH|BADG|DECAL|LOGO|EMBLEM/i.test(t.name)) m.alphaTest = true;
      // накладки без текстуры (линии дверей) закрыли бы кузов сплошным цветом
      if (!visible(part.name) || (!img && !rt && /DOORLINE/i.test(part.name))) m.defaultHidden = true;
      meshes.push(m);
    }
  }
  if (!meshes.length) throw new Error('GEOMETRY.bin: не найдено ни одного меша LOD A');
  // библиотеки деталей (CARS/WHEELS, SPOILER_*, EXHAUST…): ни одна деталь не подходит под правила — показываем все
  const library = !meshes.some((m) => !m.defaultHidden);
  if (library) {
    for (const m of meshes) delete m.defaultHidden;
    layoutGrid(meshes);
  }
  const shown = meshes.filter((m) => !m.defaultHidden);
  const info = [
    `Need for Speed: World — ${library ? 'библиотека деталей' : 'машина'}: объектов ${total}, деталей LOD A ${parts.length}, мешей ${meshes.length} (видно ${shown.length}), вершин ${sumVerts(shown)}, треугольников ${sumTris(shown)}`,
    'По умолчанию показан кузов BASE и стоковый обвес KIT00; остальные обвесы (KIT/KITW), капоты STYLE, повреждения, колёса и тормоза — в списке мешей (колёса и тормоза стоят в начале координат: их позиции хранятся не в геометрии).',
    packs.length ? `Текстуры: ${packs.join(', ')}` : 'Текстуры не найдены: откройте «Папку игры» или выберите TEXTURES.BIN вместе с GEOMETRY.bin',
  ];
  if (runtime.size) info.push(`Без файла (создаются игрой): ${[...runtime].join('; ')} — показаны цветом`);
  if (missing.size) info.push(`Текстуры не найдены: ${[...missing].slice(0, 12).join(', ')}${missing.size > 12 ? '…' : ''}`);
  if (failed.size) info.push(`Не декодированы: ${[...failed].slice(0, 5).join('; ')}`);
  if (skipped.length) info.push(`Пропущены объекты: ${skipped.slice(0, 5).join('; ')}`);
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(shown.length ? shown : meshes), flipZ: false, defaultZUp: true, cameraYaw: 0, info };
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
