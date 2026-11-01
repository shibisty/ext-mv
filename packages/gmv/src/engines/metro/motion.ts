// Анимации 4A Engine (Metro 2033): meshes/…/*.skeleton + motions/<папка скелета>/**/*.motion.
// Формат разобран по файлам игры (двери, пишущая машинка, люди, крысы: все файлы читаются байт в байт до конца).
// Чанки: 0 — u32 версия (8), u32 crc скелета (как в чанке 0x0d .skeleton), u16 число костей, 128 бит — какие кости
//   (номер бита = номер кости в файле скелета) есть в анимации;
// 1 — u16 флаги, f32 ×3, u32 число ключей, u16 0, u16 последний кадр, 32 байта маски;
// 2 — треки костей подряд: u8 флаги (бит 0 — позиция по ключам, бит 1 — поворот по ключам, бит 5 — «три меньших»,
//   бит 2 на разбор не влияет);
//   поворот: 8 байт (хэш), затем 1 или N ключей — s16 ×3 = x, y, z кватерниона / 32767, w = √(1 − x² − y² − z²);
//   с битом 5 — «три меньших»: номер наибольшей компоненты (x, y, z, w) — младшие биты первых двух чисел (бит первого — старший),
//   остальные три по порядку × √2 (бёдра, ключицы, кисти, лицевые кости); проверено по шагу: стопы касаются пола (~0,15 м)
//   во всех кадрах ходьбы, голова на 1,7 м, кисти симметричны;
//   позиция по ключам: 8 байт (хэш), N ключей s16 ×3, f32 ×3 масштаб, f32 ×3 смещение (p = ключ × масштаб + смещение);
//   постоянная позиция: f32 ×3.
// Кватернион анимации — сопряжённый к повороту кости скелета в нашей записи (Ry·Rx·Rz по столбцам): сверено по костям,
// которые анимация не меняет (пальцы, позиции 110 из 113 совпали). Ключи — 30 кадров в секунду.
import type { NodeChannel, NodeMotion } from '../../core/types';

const FPS = 30;

export interface MetroMotionHeader { skeletonCrc: number; bones: number[]; keys: number }

function chunks(u: Uint8Array): Map<number, Uint8Array> {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out = new Map<number, Uint8Array>();
  for (let p = 0; p + 8 <= u.length;) {
    const id = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (p + 8 + size > u.length) break;
    out.set(id, u.subarray(p + 8, p + 8 + size));
    p += 8 + size;
  }
  return out;
}

export function metroMotionHeader(u: Uint8Array): MetroMotionHeader {
  const c = chunks(u), h = c.get(0), i = c.get(1);
  if (!h || h.length < 26 || !i || i.length < 22) throw new Error('Не анимация 4A (.motion): нет заголовка');
  const dh = new DataView(h.buffer, h.byteOffset, h.byteLength), di = new DataView(i.buffer, i.byteOffset, i.byteLength);
  const bones: number[] = [];
  for (let b = 0; b < 128; b++) if (h[10 + (b >> 3)]! & (1 << (b & 7))) bones.push(b);
  return { skeletonCrc: dh.getUint32(4, true), bones, keys: di.getUint32(14, true) };
}

/**
 * Разобрать .motion. remap — номер кости в файле скелета -> номер кости в модели (после упорядочения по родителям).
 */
export function parseMetroMotion(u: Uint8Array, name: string, remap: (fileBone: number) => number): NodeMotion {
  const head = metroMotionHeader(u), d = chunks(u).get(2);
  if (!d) throw new Error('В .motion нет треков');
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), N = head.keys, chan = new Map<number, NodeChannel>();
  let p = 0;
  const quat = (o: number, smallest3: boolean): number[] => {
    const a = dv.getInt16(o, true) / 32767, b = dv.getInt16(o + 2, true) / 32767, c = dv.getInt16(o + 4, true) / 32767;
    if (smallest3) {
      // «три меньших»: номер опущенной (наибольшей) компоненты x/y/z/w — в младших битах первых двух чисел,
      // остальные три — по порядку, умноженные на √2; опущенная восстанавливается
      const idx = ((dv.getInt16(o, true) & 1) << 1) | (dv.getInt16(o + 2, true) & 1);
      const t = [a * Math.SQRT1_2, b * Math.SQRT1_2, c * Math.SQRT1_2];
      t.splice(idx, 0, Math.sqrt(Math.max(0, 1 - t[0]! * t[0]! - t[1]! * t[1]! - t[2]! * t[2]!)));
      return [t[3]!, -t[0]!, -t[1]!, -t[2]!];
    }
    const w = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
    return [w, -a, -b, -c]; // [w, x, y, z], сопряжённый
  };
  for (const fileBone of head.bones) {
    if (p >= d.length) throw new Error(`.motion: треки кончились на кости ${fileBone}`);
    const flags = d[p++]!, nRot = flags & 2 ? N : 1;
    p += 8;
    if (p + nRot * 6 > d.length) throw new Error('.motion: повреждён трек поворота');
    const rot: Array<[number, number[]]> = [];
    for (let k = 0; k < nRot; k++) rot.push([k, quat(p + k * 6, (flags & 0x20) !== 0)]);
    p += nRot * 6;
    let pos: Array<[number, number[]]>;
    if (flags & 1) {
      p += 8;
      const keysAt = p, sc = p + N * 6, off = sc + 12;
      if (off + 12 > d.length) throw new Error('.motion: повреждён трек позиции');
      const s = [0, 1, 2].map((k) => dv.getFloat32(sc + k * 4, true)), o = [0, 1, 2].map((k) => dv.getFloat32(off + k * 4, true));
      pos = [];
      for (let k = 0; k < N; k++) pos.push([k, [0, 1, 2].map((a) => dv.getInt16(keysAt + k * 6 + a * 2, true) * s[a]! + o[a]!)]);
      p = off + 12;
    } else {
      pos = [[0, [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)]]];
      p += 12;
    }
    const bone = remap(fileBone);
    if (bone >= 0) chan.set(bone, { rot, pos, scl: null });
  }
  if (p !== d.length) throw new Error(`.motion: прочитано ${p} из ${d.length} байт треков`);
  return { kind: 'node', name, tps: FPS, chan, duration: Math.max(N - 1, 0) / FPS || 1 / FPS, frames: N };
}
