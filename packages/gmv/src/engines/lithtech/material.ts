// Текстуры и материалы LithTech Jupiter EX (F.E.A.R. Online).
// .tex — «TEXR», u32 1, u32 флаги, затем обычный DDS.
// .mat — «LTMI», u32 версия (4), u32 размер блока данных, u16 число текстур, u16 число параметров, 2×u32, u16 длина + путь шейдера (.fxo),
// блок данных (числа и пути текстур с нулём), u32, затем описания параметров подряд:
// [u16 длина, имя, u32 смещение в блоке данных, u16 тип, u16 номер]. Текстуры — параметры с именами tDiffuseMap, tNormalMap, tSpecularMap…
import { decodeDDS } from '../../core/images/dds';
import type { DecodedImage } from '../../core/types';

export function decodeTex(buf: ArrayBuffer): DecodedImage {
  const u = new Uint8Array(buf);
  if (u.length < 16 || String.fromCharCode(u[0]!, u[1]!, u[2]!, u[3]!) !== 'TEXR') throw new Error('Не текстура LithTech (нет «TEXR»)');
  const at = String.fromCharCode(u[12]!, u[13]!, u[14]!, u[15]!) === 'DDS ' ? 12 : u.indexOf(0x44);
  return decodeDDS(buf.slice(at));
}

export interface LtMaterial {
  shader: string;
  /** Имя параметра (tDiffuseMap…) -> путь текстуры. */
  textures: Record<string, string>;
  /** Числовые параметры (float). */
  values: Record<string, number>;
}

export function parseLtMaterial(u: Uint8Array): LtMaterial {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 26 || String.fromCharCode(u[0]!, u[1]!, u[2]!, u[3]!) !== 'LTMI') throw new Error('Не материал LithTech (нет «LTMI»)');
  const dataSize = dv.getUint32(8, true), nTex = dv.getUint16(12, true), nPar = dv.getUint16(14, true);
  const sl = dv.getUint16(24, true);
  let shader = '';
  for (let k = 26; k < 26 + sl && u[k]; k++) shader += String.fromCharCode(u[k]!);
  const data = 26 + sl, after = data + dataSize;
  const str = (o: number) => { let s = ''; for (let k = data + o; k < after && u[k]; k++) s += String.fromCharCode(u[k]!); return s; };
  const res: LtMaterial = { shader, textures: {}, values: {} };
  let p = after + 4;
  for (let i = 0; i < nTex + nPar && p + 2 <= u.length; i++) {
    const len = dv.getUint16(p, true);
    if (p + 2 + len + 4 > u.length) break;
    let name = '';
    for (let k = 0; k < len; k++) name += String.fromCharCode(u[p + 2 + k]!);
    const off = dv.getUint32(p + 2 + len, true);
    p += 2 + len + 8;
    if (/^t[A-Z]/.test(name)) { const s = str(off); if (s) res.textures[name] = s; }
    else if (data + off + 4 <= after) res.values[name] = dv.getFloat32(data + off, true);
  }
  return res;
}
