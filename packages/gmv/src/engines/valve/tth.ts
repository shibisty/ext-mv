// Текстуры Troika (VTMB): .tth — заголовок + VTF без больших мипов, .ttz — zlib-поток с остальными мипами.
// TTH: "TTH\0", u8 верс.×2, u8 мипов, u8 флаги, u32 длина VTF в .tth, (мипов+1) × (u32 конец в VTF, u32 конец в .ttz), затем VTF.
import { inflateZlib } from '../../core/codecs/zlib';

export function isTth(u8: Uint8Array): boolean {
  return u8.length >= 12 && u8[0] === 0x54 && u8[1] === 0x54 && u8[2] === 0x48 && u8[3] === 0;
}

/** Собрать обычный VTF из .tth (+ .ttz, если есть). */
export async function tthToVtf(tth: Uint8Array, ttz: Uint8Array | null): Promise<ArrayBuffer> {
  if (!isTth(tth)) throw new Error('Не TTH');
  const dv = new DataView(tth.buffer, tth.byteOffset, tth.byteLength), mips = tth[6]!, raw = dv.getUint32(8, true);
  const start = 12 + (mips + 1) * 8, total = dv.getUint32(12 + mips * 8, true);
  if (start + 4 > tth.length || dv.getUint32(start, true) !== 0x00465456) throw new Error('TTH: нет VTF внутри');
  const head = tth.subarray(start, Math.min(tth.length, start + raw));
  const rest = ttz && ttz.length ? await inflateZlib(ttz) : new Uint8Array(0);
  const out = new Uint8Array(Math.max(total, head.length + rest.length));
  out.set(head); out.set(rest.subarray(0, out.length - head.length), head.length);
  return out.buffer;
}
