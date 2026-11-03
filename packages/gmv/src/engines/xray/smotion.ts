// Анимации X-Ray SDK (ActorEditor): .skl (чанк 0x1200 с одной анимацией), .skls (u32 число + анимации подряд),
// они же внутри .object (чанк 0x0916). Анимация (CSMotion, версии 6–7): имя, u32 первый и последний кадр, f32 FPS,
// u16 версия, u8 флаги (1 — эффект на одну кость), u16 кость/часть (0xFFFF — всё тело), f32 скорость, наплыв, спад, сила,
// u16 число костей; кость: имя, u8 флаги, 6 огибающих (позиция X, Y, Z; повороты H, P, B). Огибающая (как в LightWave):
// u8×2 поведение до/после, u16 ключей; ключ: f32 значение, f32 время (с), u8 форма (0 TCB, 1 Эрмит, 2 Безье, 3 линия,
// 4 ступень, 5 Безье-2), кроме ступени — 7 чисел u16 в [−32, 32]: натяжение, непрерывность, смещение, параметры ×4.
// С версии 7 — метки (имя до «\r\n», u32 число, интервалы f32×2). Поза кости: Fmatrix::setXYZi(P, H, B) + позиция.
import { XRAY_FX_PART } from '../../core/motions';
import type { XrayMotion, XrayTrack } from '../../core/types';

export interface EnvKey { value: number; time: number; shape: number; tension: number; continuity: number; bias: number; param: number[] }
export interface Envelope { behavior: [number, number]; keys: EnvKey[] }
export interface SMotion {
  name: string; frameStart: number; frameEnd: number; fps: number; version: number;
  flags: number; boneOrPart: number; speed: number;
  bones: Array<{ name: string; flags: number; envs: Envelope[] }>;
}

class R {
  readonly dv: DataView;
  constructor(readonly u: Uint8Array, public p: number, readonly end: number) { this.dv = new DataView(u.buffer, u.byteOffset, u.byteLength); }
  need(n: number) { if (this.p + n > this.end) throw new Error('Анимация SDK обрезана'); }
  u8() { this.need(1); return this.u[this.p++]!; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  q16() { return -32 + (this.u16() * 64) / 65535; }
  sz() { const e = this.u.indexOf(0, this.p); if (e < 0 || e >= this.end) throw new Error('Анимация SDK: строка не закрыта'); const s = new TextDecoder('latin1').decode(this.u.subarray(this.p, e)); this.p = e + 1; return s; }
  line() { while (this.p < this.end && this.u[this.p] !== 10) this.p++; this.p++; }
}

function readEnvelope(r: R): Envelope {
  const behavior: [number, number] = [r.u8(), r.u8()], n = r.u16(), keys: EnvKey[] = [];
  for (let i = 0; i < n; i++) {
    const value = r.f32(), time = r.f32(), shape = r.u8();
    const k: EnvKey = { value, time, shape, tension: 0, continuity: 0, bias: 0, param: [0, 0, 0, 0] };
    if (shape !== 4) { k.tension = r.q16(); k.continuity = r.q16(); k.bias = r.q16(); k.param = [r.q16(), r.q16(), r.q16(), r.q16()]; }
    keys.push(k);
  }
  return { behavior, keys };
}

function readSMotion(r: R): SMotion {
  const name = r.sz(), frameStart = r.u32(), frameEnd = r.u32(), fps = r.f32(), version = r.u16();
  if (version < 6) throw new Error(`Анимация SDK версии ${version} не поддерживается (нужна 6–7)`);
  const flags = r.u8(), boneOrPart = r.u16(), speed = r.f32();
  r.f32(); r.f32(); r.f32(); // наплыв, спад, сила
  const nb = r.u16(), bones: SMotion['bones'] = [];
  for (let b = 0; b < nb; b++) {
    const bn = r.sz(), bf = r.u8(), envs: Envelope[] = [];
    for (let c = 0; c < 6; c++) envs.push(readEnvelope(r));
    bones.push({ name: bn, flags: bf, envs });
  }
  if (version >= 7) { const nm = r.u32(); for (let i = 0; i < nm; i++) { r.line(); const k = r.u32(); r.p += k * 8; } }
  return { name, frameStart, frameEnd, fps, version, flags, boneOrPart, speed, bones };
}

/** Список анимаций: u32 число + анимации (.skls, чанк 0x0916 .object). */
export function parseSMotions(u: Uint8Array): SMotion[] {
  const r = new R(u, 0, u.length), n = r.u32(), out: SMotion[] = [];
  for (let i = 0; i < n; i++) out.push(readSMotion(r));
  return out;
}

/** .skl: чанк 0x1200 с одной анимацией. */
export function parseSkl(u: Uint8Array): SMotion {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (u.length < 8 || dv.getUint32(0, true) !== 0x1200) throw new Error('Не .skl (нет чанка 0x1200)');
  return readSMotion(new R(u, 8, Math.min(u.length, 8 + dv.getUint32(4, true))));
}

// ---- огибающие (evalEnvelope из LightWave SDK, как в xrCore/envelope.cpp) ----
function outgoing(keys: EnvKey[], i: number): number {
  const k0 = keys[i]!, k1 = keys[i + 1]!, prev = keys[i - 1];
  switch (k0.shape) {
    case 0: {
      const a = (1 - k0.tension) * (1 + k0.continuity) * (1 + k0.bias), b = (1 - k0.tension) * (1 - k0.continuity) * (1 - k0.bias), d = k1.value - k0.value;
      return prev ? ((k1.time - k0.time) / (k1.time - prev.time)) * (a * (k0.value - prev.value) + b * d) : b * d;
    }
    case 3: { const d = k1.value - k0.value; return prev ? ((k1.time - k0.time) / (k1.time - prev.time)) * (k0.value - prev.value + d) : d; }
    case 1: case 2: return prev ? k0.param[1]! * ((k1.time - k0.time) / (k1.time - prev.time)) : k0.param[1]!;
    case 5: { const o = k0.param[3]! * (k1.time - k0.time); return Math.abs(k0.param[2]!) > 1e-5 ? o / k0.param[2]! : o * 1e5; }
    default: return 0;
  }
}
function incoming(keys: EnvKey[], i: number): number {
  const k0 = keys[i - 1]!, k1 = keys[i]!, next = keys[i + 1];
  switch (k1.shape) {
    case 0: {
      const a = (1 - k1.tension) * (1 - k1.continuity) * (1 + k1.bias), b = (1 - k1.tension) * (1 + k1.continuity) * (1 - k1.bias), d = k1.value - k0.value;
      return next ? ((k1.time - k0.time) / (next.time - k0.time)) * (b * (next.value - k1.value) + a * d) : a * d;
    }
    case 3: { const d = k1.value - k0.value; return next ? ((k1.time - k0.time) / (next.time - k0.time)) * (next.value - k1.value + d) : d; }
    case 1: case 2: return next ? k1.param[0]! * ((k1.time - k0.time) / (next.time - k0.time)) : k1.param[0]!;
    case 5: { const o = k1.param[1]! * (k1.time - k0.time); return Math.abs(k1.param[0]!) > 1e-5 ? o / k1.param[0]! : o * 1e5; }
    default: return 0;
  }
}
/** Безье-2: кривая по времени — ищем параметр делением отрезка пополам. */
function bez2(k0: EnvKey, k1: EnvKey, time: number): number {
  const x0 = k0.time, x1 = k0.time + (k0.shape === 5 ? k0.param[2]! : (k1.time - k0.time) / 3), x3 = k1.time, x2 = k1.time + (k1.shape === 5 ? k1.param[0]! : -(k1.time - k0.time) / 3);
  const y0 = k0.value, y1 = k0.value + (k0.shape === 5 ? k0.param[3]! : outgoing([k0, k1], 0) / 3), y3 = k1.value, y2 = k1.value + (k1.shape === 5 ? k1.param[1]! : -incoming([k0, k1], 1) / 3);
  const cub = (a: number, b: number, c: number, d: number, t: number) => { const s = 1 - t; return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d; };
  let lo = 0, hi = 1, t = 0.5;
  for (let i = 0; i < 30; i++) { t = (lo + hi) / 2; if (cub(x0, x1, x2, x3, t) < time) lo = t; else hi = t; }
  return cub(y0, y1, y2, y3, t);
}

export function evalEnvelope(env: Envelope, time: number): number {
  const K = env.keys;
  if (!K.length) return 0;
  if (K.length === 1) return K[0]!.value;
  const s = K[0]!, e = K[K.length - 1]!;
  if (time < s.time) {
    if (env.behavior[0] === 0) return 0;
    if (env.behavior[0] === 2 && e.time > s.time) time = s.time + ((((time - s.time) % (e.time - s.time)) + (e.time - s.time)) % (e.time - s.time));
    else return s.value;
  } else if (time > e.time) {
    if (env.behavior[1] === 0) return 0;
    if (env.behavior[1] === 2 && e.time > s.time) time = s.time + ((time - s.time) % (e.time - s.time));
    else return e.value;
  }
  let k = 0;
  while (k + 2 < K.length && time > K[k + 1]!.time) k++;
  const k0 = K[k]!, k1 = K[k + 1]!;
  if (time <= k0.time) return k0.value;
  if (time >= k1.time) return k1.value;
  const t = (time - k0.time) / (k1.time - k0.time);
  switch (k1.shape) {
    case 0: case 1: case 2: {
      const out = outgoing(K, k), inn = incoming(K, k + 1), t2 = t * t, t3 = t2 * t;
      const h2 = 3 * t2 - 2 * t3, h1 = 1 - h2, h4 = t3 - t2, h3 = h4 - t2 + t;
      return h1 * k0.value + h2 * k1.value + h3 * out + h4 * inn;
    }
    case 5: return bez2(k0, k1, time);
    case 3: return k0.value + t * (k1.value - k0.value);
    case 4: return k0.value;
    default: return 0;
  }
}

/** Кватернион из матрицы поворота (строки, как в quatLocal скелета X-Ray). */
export function quatOfRows(o: ArrayLike<number>): [number, number, number, number] {
  const tr = o[0]! + o[5]! + o[10]!;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (o[9]! - o[6]!) / s; y = (o[2]! - o[8]!) / s; z = (o[4]! - o[1]!) / s; }
  else if (o[0]! > o[5]! && o[0]! > o[10]!) { const s = Math.sqrt(1 + o[0]! - o[5]! - o[10]!) * 2; x = s / 4; w = (o[9]! - o[6]!) / s; y = (o[1]! + o[4]!) / s; z = (o[2]! + o[8]!) / s; }
  else if (o[5]! > o[10]!) { const s = Math.sqrt(1 + o[5]! - o[0]! - o[10]!) * 2; y = s / 4; w = (o[2]! - o[8]!) / s; x = (o[1]! + o[4]!) / s; z = (o[6]! + o[9]!) / s; }
  else { const s = Math.sqrt(1 + o[10]! - o[0]! - o[5]!) * 2; z = s / 4; w = (o[4]! - o[1]!) / s; x = (o[2]! + o[8]!) / s; y = (o[6]! + o[9]!) / s; }
  return [x, y, z, w];
}

/**
 * Анимация SDK → треки X-Ray по костям модели (по именам): огибающие считаются на каждом кадре, поворот (setXYZi)
 * переводится в кватернион. local(rot, pos, out) — матрица кости по углам, как у bind-позы этого скелета.
 */
export function smotionToXray(sm: SMotion, boneNames: readonly string[], local: (rot: number[], pos: number[], o: Float32Array) => void, parts: Array<{ name: string; bones: string[] }> = []): XrayMotion {
  const frames = Math.max(1, sm.frameEnd - sm.frameStart), fps = sm.fps > 0 ? sm.fps : 30;
  const idx = new Map(boneNames.map((n, i) => [n.toLowerCase(), i]));
  const tracks: XrayTrack[] = [], M = new Float32Array(16);
  for (const b of sm.bones) {
    const bi = idx.get(b.name.toLowerCase());
    if (bi === undefined) continue;
    const rot = new Int16Array(frames * 4), trans = new Float32Array(frames * 3);
    let px = 0, py = 0, pz = 0, pw = 1;
    for (let f = 0; f < frames; f++) {
      const t = (sm.frameStart + f) / fps, E = b.envs;
      const T = [evalEnvelope(E[0]!, t), evalEnvelope(E[1]!, t), evalEnvelope(E[2]!, t)];
      local([evalEnvelope(E[4]!, t), evalEnvelope(E[3]!, t), evalEnvelope(E[5]!, t)], T, M);
      let [x, y, z, w] = quatOfRows(M);
      if (x * px + y * py + z * pz + w * pw < 0) { x = -x; y = -y; z = -z; w = -w; } // без скачков знака между кадрами
      [px, py, pz, pw] = [x, y, z, w];
      rot[f * 4] = Math.round(x * 32767); rot[f * 4 + 1] = Math.round(y * 32767); rot[f * 4 + 2] = Math.round(z * 32767); rot[f * 4 + 3] = Math.round(w * 32767);
      trans.set(T, f * 3);
    }
    tracks[bi] = { rot, trans };
  }
  const m: XrayMotion = { kind: 'xray', name: sm.name, frames, duration: frames / fps, tracks };
  // часть тела или кость-эффект — как у анимаций OGF
  if (sm.flags & 1) {
    const t = tracks[sm.boneOrPart];
    if (t) { m.tracks = []; m.tracks[sm.boneOrPart] = t; m.part = XRAY_FX_PART; }
  } else if (sm.boneOrPart !== 0xffff && parts.length > 1 && parts[sm.boneOrPart]) {
    const p = parts[sm.boneOrPart]!, keep: XrayTrack[] = [];
    for (const n of p.bones) { const i = idx.get(n.toLowerCase()); if (i !== undefined && tracks[i]) keep[i] = tracks[i]!; }
    m.tracks = keep; m.part = p.name;
  }
  return m;
}
