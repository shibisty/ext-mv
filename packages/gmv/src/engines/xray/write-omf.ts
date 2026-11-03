// Запись внешних анимаций X-Ray (.omf) - обратное к parseOMF (MF-A A1, xray-1.7 net1189).
//
// Формат (motions_value::load движка, SkeletonMotions.cpp):
//   чанк S_SMPARAMS (15): u16 версия (4); u16 частей; часть: stringz имя, u16 костей, кость: stringz имя, u32 номер трека;
//     u16 описаний; описание: stringz имя, u32 флаги (esmFX 1, esmStopAtEnd 2, esmNoMix 4, esmSyncPart 8, esmUseFootSteps 16,
//     esmRootMover 32, esmIdle 64, esmUseWeaponBone 128), u16 часть|кость, u16 номер анимации, f32 скорость, мощность,
//     нарастание, спад; версия ≥ 4: u32 меток, метка: имя до «\r\n», u32 интервалов, пары f32.
//   чанк S_MOTIONS (14): подчанк 0 - u32 число; подчанк i+1: stringz имя, u32 кадров, по костям в порядке треков:
//     u8 флаги (flRKeyAbsent 2 - один поворот; flTKeyPresent 1 - смещение по кадрам; flTKey16IsBit 4 - 16 бит),
//     поворот: 4×s16 (один) или u32 crc + кадров×4×s16; смещение: u32 crc + кадров×3×(s8|s16) + f32×3 size + f32×3 init,
//     или f32×3 (постоянное).
// Поворот квантуется ×32767 (KEY_Quant), смещение - s16 по размаху (8 бит - если размах < 1 мм на шаг, иначе 16).
import type { XrayMotion, XrayTrack } from '../../core/types';

export const ESM = { FX: 1, STOP_AT_END: 2, NO_MIX: 4, SYNC_PART: 8, USE_FOOT_STEPS: 16, ROOT_MOVER: 32, IDLE: 64, USE_WEAPON_BONE: 128 } as const;

export interface OmfMotionDef {
  /** Флаги esm*. */
  flags?: number;
  /** Часть тела (номер в parts) для циклов или кость для FX. */
  boneOrPart?: number;
  speed?: number; power?: number; accrue?: number; falloff?: number;
  /** Метки (шаги и т. п.): имя и интервалы [начало, конец] в секундах. */
  marks?: Array<{ name: string; intervals: Array<[number, number]> }>;
}
export interface OmfInput {
  /** Имена костей в порядке треков (порядок костей модели). */
  bones: readonly string[];
  /** Части тела; пусто - одна часть «default» со всеми костями. */
  parts?: Array<{ name: string; bones: string[] }>;
  motions: Array<{ motion: XrayMotion; def?: OmfMotionDef }>;
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < u.length; i++) c = CRC_TABLE[(c ^ u[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class W {
  private buf = new Uint8Array(1 << 16); private dv = new DataView(this.buf.buffer); pos = 0;
  private need(n: number) { if (this.pos + n <= this.buf.length) return; let s = this.buf.length * 2; while (s < this.pos + n) s *= 2; const b = new Uint8Array(s); b.set(this.buf); this.buf = b; this.dv = new DataView(b.buffer); }
  u8(v: number) { this.need(1); this.dv.setUint8(this.pos, v); this.pos += 1; }
  u16(v: number) { this.need(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v: number) { this.need(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  i16(v: number) { this.need(2); this.dv.setInt16(this.pos, v, true); this.pos += 2; }
  i8(v: number) { this.need(1); this.dv.setInt8(this.pos, v); this.pos += 1; }
  f32(v: number) { this.need(4); this.dv.setFloat32(this.pos, v, true); this.pos += 4; }
  bytes(u: Uint8Array) { this.need(u.length); this.buf.set(u, this.pos); this.pos += u.length; }
  stringz(s: string) { this.bytes(new TextEncoder().encode(s)); this.u8(0); }
  line(s: string) { this.bytes(new TextEncoder().encode(s)); this.u8(13); this.u8(10); }
  chunk(id: number, body: (w: W) => void) { const w = new W(); body(w); this.u32(id); this.u32(w.pos); this.bytes(w.out()); }
  out(): Uint8Array { return this.buf.subarray(0, this.pos); }
}

const KEY_QUANT = 32767;
const q16 = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v * KEY_QUANT)));

/** Поворот из трека: Int16Array уже в квантах X-Ray (parseOMF хранит сырые s16), либо 4 значения на все кадры. */
function writeRotation(w: W, t: XrayTrack, frames: number, constR: boolean) {
  if (constR) { for (let k = 0; k < 4; k++) w.i16(t.rot[k]!); return; }
  const raw = new Uint8Array(frames * 8), dv = new DataView(raw.buffer);
  for (let k = 0; k < frames * 4; k++) dv.setInt16(k * 2, t.rot[k]!, true);
  w.u32(crc32(raw)); w.bytes(raw);
}

/** Смещение по кадрам: квантование по размаху, 8 бит если шаг квантования ≤ 1 мм, иначе 16. */
function writeTranslation(w: W, t: XrayTrack, frames: number): number {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < frames; k++) for (let a = 0; a < 3; a++) { const v = t.trans[k * 3 + a]!; if (v < mn[a]!) mn[a] = v; if (v > mx[a]!) mx[a] = v; }
  const range = [0, 1, 2].map((a) => mx[a]! - mn[a]!);
  const wide = Math.max(...range) / 127 > 0.001;
  const quant = wide ? 32767 : 127;
  const size = range.map((r) => (r > 0 ? r / quant : 1)), init = mn;
  const raw = new Uint8Array(frames * 3 * (wide ? 2 : 1)), dv = new DataView(raw.buffer);
  for (let k = 0; k < frames * 3; k++) {
    const a = k % 3, q = Math.max(-quant, Math.min(quant, Math.round((t.trans[k]! - init[a]!) / size[a]!)));
    if (wide) dv.setInt16(k * 2, q, true); else dv.setInt8(k, q);
  }
  w.u32(crc32(raw)); w.bytes(raw);
  for (let a = 0; a < 3; a++) w.f32(size[a]!);
  for (let a = 0; a < 3; a++) w.f32(init[a]!);
  return wide ? 4 : 0;
}

/** Трек-заглушка для кости без анимации: поза покоя (единичный поворот, нулевое смещение). */
const identityTrack = (): XrayTrack => ({ rot: new Int16Array([0, 0, 0, KEY_QUANT]), trans: new Float32Array(3), constT: true });

function isConstRot(t: XrayTrack, frames: number): boolean {
  if (t.rot.length === 4) return true;
  for (let k = 1; k < frames; k++) for (let a = 0; a < 4; a++) if (t.rot[k * 4 + a] !== t.rot[a]) return false;
  return true;
}
function isConstTrans(t: XrayTrack, frames: number): boolean {
  if (t.constT || t.trans.length === 3) return true;
  for (let k = 1; k < frames; k++) for (let a = 0; a < 3; a++) if (Math.abs(t.trans[k * 3 + a]! - t.trans[a]!) > 1e-6) return false;
  return true;
}

export function writeOMF(input: OmfInput): Uint8Array {
  const bones = input.bones;
  const parts = input.parts?.length ? input.parts : [{ name: 'default', bones: [...bones] }];
  const trackOf = new Map(bones.map((b, i) => [b.toLowerCase(), i]));
  const top = new W();
  // S_SMPARAMS
  top.chunk(15, (w) => {
    w.u16(4); w.u16(parts.length);
    for (const p of parts) {
      w.stringz(p.name); w.u16(p.bones.length);
      for (const b of p.bones) { const i = trackOf.get(b.toLowerCase()); if (i === undefined) throw new Error(`часть «${p.name}»: кости «${b}» нет в списке костей`); w.stringz(b); w.u32(i); }
    }
    w.u16(input.motions.length);
    input.motions.forEach(({ motion, def = {} }, k) => {
      w.stringz(motion.name); w.u32(def.flags ?? 0); w.u16(def.boneOrPart ?? 0); w.u16(k);
      w.f32(def.speed ?? 1); w.f32(def.power ?? 1); w.f32(def.accrue ?? 2); w.f32(def.falloff ?? 2);
      const marks = def.marks ?? []; w.u32(marks.length);
      for (const m of marks) { w.line(m.name); w.u32(m.intervals.length); for (const [a, b] of m.intervals) { w.f32(a); w.f32(b); } }
    });
  });
  // S_MOTIONS
  top.chunk(14, (w) => {
    w.chunk(0, (c) => c.u32(input.motions.length));
    input.motions.forEach(({ motion }, k) => w.chunk(k + 1, (c) => {
      const frames = motion.frames;
      c.stringz(motion.name); c.u32(frames);
      for (let i = 0; i < bones.length; i++) {
        const t = motion.tracks[i] ?? identityTrack();
        const constR = isConstRot(t, frames), constT = isConstTrans(t, frames);
        // flags: вычисляются после записи смещения (бит 16-битности), поэтому пишем во временный буфер
        const body = new W();
        writeRotation(body, t, frames, constR);
        let flags = constR ? 2 : 0;
        if (constT) { for (let a = 0; a < 3; a++) body.f32(t.trans[a]!); }
        else flags |= 1 | writeTranslation(body, t, frames);
        c.u8(flags); c.bytes(body.out());
      }
    }));
  });
  return top.out();
}

/** Квантованный поворот из float-кватерниона (x, y, z, w) - для треков, построенных не из OMF. */
export function quantRot(q: readonly number[]): Int16Array { return new Int16Array([q16(q[0]!), q16(q[1]!), q16(q[2]!), q16(q[3]!)]); }
