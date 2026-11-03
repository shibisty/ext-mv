// Двоичные объекты Dunia (.fcb, «nbCF» — FCbn в little-endian), версия 2 (Far Cry 2).
// Заголовок: u32 магия, u16 версия 2, u16 флаги 0, u32 всего объектов, u32 всего значений; затем корневой объект.
// Объект: счётчик детей (u8; 0xFF — далее u32; 0xFE — u32 номер уже прочитанного объекта — ссылка),
//   u32 хеш типа (CRC-32 имени класса: «Sector», «Entity», «CGraphicComponent»…), счётчик значений,
//   значения: u32 хеш имени, размер (счётчик; 0xFE — u32 смещение назад до такого же значения), байты; затем дети.
// Имён в файле нет — только CRC-32 (по описанию классов Gibbed.Dunia, configs/Far Cry 2/binary_classes.xml).
import { crc32 } from '../../core/writers/zip';

export interface FcbObject { type: number; values: Map<number, Uint8Array>; children: FcbObject[] }

/** CRC-32 имени класса/поля, как в .fcb. */
export const fcbHash = (name: string): number => crc32(new TextEncoder().encode(name)) >>> 0;

export function parseFcb(u: Uint8Array): FcbObject {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 16 || dv.getUint32(0, true) !== 0x4643626e) throw new Error('Не .fcb (нет «nbCF»)');
  if (dv.getUint16(4, true) !== 2) throw new Error(`.fcb версии ${dv.getUint16(4, true)} не поддерживается (нужна 2 — Far Cry 2)`);
  let p = 16;
  const need = (n: number) => { if (p + n > u.length) throw new Error('.fcb обрезан'); };
  const count = (): [number, boolean] => {
    need(1);
    const b = u[p++]!;
    if (b < 0xfe) return [b, false];
    need(4); const v = dv.getUint32(p, true); p += 4;
    return [v, b === 0xfe];
  };
  const pointers: FcbObject[] = [];
  const obj = (depth: number): FcbObject => {
    if (depth > 64) throw new Error('.fcb: слишком глубокая вложенность');
    const [nChildren, isRef] = count();
    if (isRef) { const o = pointers[nChildren]; if (!o) throw new Error('.fcb: ссылка на неизвестный объект'); return o; }
    const o: FcbObject = { type: 0, values: new Map(), children: [] };
    pointers.push(o);
    need(4); o.type = dv.getUint32(p, true); p += 4;
    const [nValues] = count();
    for (let i = 0; i < nValues; i++) {
      need(4); const name = dv.getUint32(p, true); p += 4;
      const at = p;
      const [size, back] = count();
      if (back) {
        // то же значение уже записано раньше: смещение назад от начала этого счётчика
        const save = p; p = at - size;
        const [s2, again] = count();
        if (again) throw new Error('.fcb: двойная ссылка значения');
        need(s2); o.values.set(name, u.subarray(p, p + s2)); p = save;
      } else { need(size); o.values.set(name, u.subarray(p, p + size)); p += size; }
    }
    for (let i = 0; i < nChildren; i++) o.children.push(obj(depth + 1));
    return o;
  };
  return obj(0);
}

const dvOf = (v: Uint8Array) => new DataView(v.buffer, v.byteOffset, v.byteLength);
export const fcbString = (v: Uint8Array | undefined): string | undefined => {
  if (!v) return undefined;
  let e = v.indexOf(0); if (e < 0) e = v.length;
  return new TextDecoder('latin1').decode(v.subarray(0, e));
};
export const fcbU32 = (v: Uint8Array | undefined): number | undefined => (v && v.length >= 4 ? dvOf(v).getUint32(0, true) : undefined);
export const fcbF32 = (v: Uint8Array | undefined): number | undefined => (v && v.length >= 4 ? dvOf(v).getFloat32(0, true) : undefined);
export const fcbVec3 = (v: Uint8Array | undefined): number[] | undefined => {
  if (!v || v.length < 12) return undefined;
  const d = dvOf(v); return [d.getFloat32(0, true), d.getFloat32(4, true), d.getFloat32(8, true)];
};

/** Обход дерева: все объекты с типом type. */
export function fcbFind(root: FcbObject, type: number, out: FcbObject[] = [], seen = new Set<FcbObject>()): FcbObject[] {
  if (seen.has(root)) return out;
  seen.add(root);
  if (root.type === type) out.push(root);
  for (const c of root.children) fcbFind(c, type, out, seen);
  return out;
}
