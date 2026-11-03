// MF-A A2 (xray-1.7 net1191): перенос анимаций Far Cry 2 (.mab, скелет людей Biped) на скелет сталкера X-Ray (bip01_*).
//   npx vite-node tools/retarget-fc2.ts -- --fc2 <Data_Win32> --ogf <сталкер.ogf> --clips <regex по пути .mab>
//                                           [--map карта.json] [--out <папка>] [--name-prefix fc2_] [--report]
// Оба скелета - 3ds Max Biped: кость X вдоль себя, одинаковые имена (Pelvis/Spine/L Thigh… ↔ bip01_pelvis/bip01_spine/
// bip01_l_thigh…), но крен костей вокруг своей оси (X) у двух ригов разный (кисть - на 85°), поэтому перенос - в мировых
// координатах: Δw = animW·bindW⁻¹ кости FC2 (после перевода осей Max Z-вверх → X-Ray Y-вверх и поворота G, совмещающего
// ось таза ригов), цель = Δw·refW, где refW - bind цели, довёрнутый минимальным поворотом так, чтобы ось кости (X)
// смотрела как у FC2 в bind (поза покоя FC2 - A, X-Ray - T; крен берётся из bind цели). Корень (bip01): ход - из ключей
// таза .mab и дорожки корня D(k), умноженный на отношение длин ног; поворот D - в bip01, остальное - в bip01_pelvis.
// Ключи 30 к/с (ресемплинг nlerp/lerp), запись - writeOMF (одна часть, все кости; незамапленные - поза привязки).
// Отчёт (--report): по клипу - минимальная высота стоп и таза по кадрам (ноги в полу / в воздухе видно числом).
import { openAsBlob, readdirSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { BlobFile, XrayMotion, XrayTrack } from '../packages/gmv/src/index';
import { openDuniaArchive } from '../packages/gmv/src/engines/dunia/fat';
import { parseMab, parseSkeleton, type MabAnim, type DuniaSkelBone } from '../packages/gmv/src/engines/dunia/mab';
import { parseOGF, parseSMParams, readChunks, OGF } from '../packages/gmv/src/engines/xray/ogf';
import { XraySkeleton } from '../packages/gmv/src/engines/xray/skeleton';
import { writeOMF, quantRot, ESM, type OmfMotionDef } from '../packages/gmv/src/engines/xray/write-omf';

console.warn = () => {};
const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1] ?? d; args.splice(i, 2); return v; };
const flag = (n: string) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const FC2 = opt('--fc2'), OGFP = opt('--ogf'), CLIPS = opt('--clips', 'hurt/receiving_wound|hmr/health|hurt/revive'), MAP = opt('--map'), OUT = opt('--out', 'out_retarget');
const PREFIX = opt('--name-prefix', 'fc2_'), REPORT = flag('--report'), LIMIT = parseInt(opt('--limit', '0'), 10);
const PARTS = opt('--parts'), SLOTS = opt('--slots'); // --parts <stalker_animation.omf>: части тела как у модели; --slots <json>: имена/флаги по правилам
const ROOT_MOVE = parseFloat(opt('--root-move', '0.3')); // ход корня (м), с которого клип становится root mover (esmRootMover, ход - в корневой кости)
if (!FC2 || !OGFP) { console.error('нужно --fc2 <Data_Win32> --ogf <модель.ogf>'); process.exit(2); }

// ---------------------------------------------------------------- маленькая линейная алгебра (кватернионы [w,x,y,z], матрицы column-major 4×4)
type Q = [number, number, number, number];
type V = [number, number, number];
const qmul = (p: Q, q: Q): Q => [
  p[0] * q[0] - p[1] * q[1] - p[2] * q[2] - p[3] * q[3], p[0] * q[1] + p[1] * q[0] + p[2] * q[3] - p[3] * q[2],
  p[0] * q[2] - p[1] * q[3] + p[2] * q[0] + p[3] * q[1], p[0] * q[3] + p[1] * q[2] - p[2] * q[1] + p[3] * q[0]];
const conj = (q: Q): Q => [q[0], -q[1], -q[2], -q[3]];
const qnorm = (q: Q): Q => { const l = Math.hypot(...q) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qrot = (q: Q, v: V): V => { const r = qmul(qmul(q, [0, v[0], v[1], v[2]]), conj(q)); return [r[1], r[2], r[3]]; };
const nlerp = (a: Q, b: Q, t: number): Q => { const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = d < 0 ? -1 : 1; return qnorm([a[0] + (s * b[0] - a[0]) * t, a[1] + (s * b[1] - a[1]) * t, a[2] + (s * b[2] - a[2]) * t, a[3] + (s * b[3] - a[3]) * t]); };
const lerp = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Кватернион [w,x,y,z] поворотной части column-major матрицы. */
function matQ(m: ArrayLike<number>): Q {
  const m00 = m[0]!, m11 = m[5]!, m22 = m[10]!, tr = m00 + m11 + m22;
  let q: Q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [s / 4, (m[6]! - m[9]!) / s, (m[8]! - m[2]!) / s, (m[1]! - m[4]!) / s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [(m[6]! - m[9]!) / s, s / 4, (m[4]! + m[1]!) / s, (m[8]! + m[2]!) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m[8]! - m[2]!) / s, (m[4]! + m[1]!) / s, s / 4, (m[9]! + m[6]!) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m[1]! - m[4]!) / s, (m[8]! + m[2]!) / s, (m[9]! + m[6]!) / s, s / 4]; }
  return qnorm(q);
}
/** Перевод осей Max (Z вверх, правая) → X-Ray (Y вверх, левая): P = swap(y, z). Отражение: угол меняет знак. */
const pV = (v: V): V => [v[0], v[2], v[1]];
const pQ = (q: Q): Q => [q[0], -q[1], -q[3], -q[2]];

// ---------------------------------------------------------------- карта костей FC2 → X-Ray
const DEFAULT_MAP: Record<string, string> = {
  'Pelvis': 'bip01_pelvis', 'Spine': 'bip01_spine', 'Spine1': 'bip01_spine1', 'Spine2': 'bip01_spine2', 'Neck': 'bip01_neck', 'Head': 'bip01_head',
  'L Thigh': 'bip01_l_thigh', 'L Calf': 'bip01_l_calf', 'L Foot': 'bip01_l_foot', 'L Toe': 'bip01_l_toe0',
  'R Thigh': 'bip01_r_thigh', 'R Calf': 'bip01_r_calf', 'R Foot': 'bip01_r_foot', 'R Toe': 'bip01_r_toe0',
  'L Clavicle': 'bip01_l_clavicle', 'L UpperArm': 'bip01_l_upperarm', 'L Forearm': 'bip01_l_forearm', 'L Hand': 'bip01_l_hand',
  'R Clavicle': 'bip01_r_clavicle', 'R UpperArm': 'bip01_r_upperarm', 'R Forearm': 'bip01_r_forearm', 'R Hand': 'bip01_r_hand',
  'L Thumb01': 'bip01_l_finger0', 'L Thumb02': 'bip01_l_finger01', 'L Thumb03': 'bip01_l_finger02',
  'L Index01': 'bip01_l_finger1', 'L Index02': 'bip01_l_finger11', 'L Index03': 'bip01_l_finger12',
  'L Middle01': 'bip01_l_finger2', 'L Middle02': 'bip01_l_finger21', 'L Middle03': 'bip01_l_finger22',
  'R Thumb01': 'bip01_r_finger0', 'R Thumb02': 'bip01_r_finger01', 'R Thumb03': 'bip01_r_finger02',
  'R Index01': 'bip01_r_finger1', 'R Index02': 'bip01_r_finger11', 'R Index03': 'bip01_r_finger12',
  'R Middle01': 'bip01_r_finger2', 'R Middle02': 'bip01_r_finger21', 'R Middle03': 'bip01_r_finger22',
  'Jaw': 'jaw_1', 'L_Eye': 'eye_left', 'R_Eye': 'eye_right', 'L_Eyelid_U': 'eyelid_1',
};
const ROOT_TARGET = 'bip01'; // как у родных анимаций: высота таза - в bip01_pelvis, bip01 и корень модели на нуле…
// …кроме клипов с ходом (root mover): ход и поворот D(k) - в корневой кости модели (root_stalker), её и двигает
// animation_movement_controller (xrGame), bip01 на нуле, таз - относительно корня.

// ---------------------------------------------------------------- слоты X-Ray: правила «клип FC2 → имя/флаги X-Ray»
// name: шаблон, {n} - счётчик правила (с from), {1}.. - группы регулярного выражения; part 65535 - всё тело (как у
// родных critical_hit), иначе номер части из --parts; aliases - ещё имена того же движения (оружейные слоты 1..3 у
// critical_hit - одни ключи, три описания). Без правила: PREFIX + короткое имя клипа, флаги 0, часть 65535.
interface SlotRule { match: string; name: string; from?: number; flags?: number; part?: number; aliases?: string[]; lua?: string }
const SIDE: Record<string, string> = { left: 'legs_left', right: 'legs_right', front: 'legs_left', back: 'legs_right' };
const UPPER: Record<string, string> = { left: 'hend_left', right: 'hend_right', front: 'torso', back: 'torso' };
const DEFAULT_SLOTS: SlotRule[] = [
  // критические попадания FC2 (hurt_critical{up,low}{dir}, с ходом) → norm_{оружие}_critical_hit_{часть}_{n}: как родные
  // (flags 18 = StopAtEnd|UseFootSteps, всё тело); «up» - торс/руки, «low» - ноги; нумерация с 2 (родные _0, _1)
  { match: 'hurt_?(?:move)?critical(up|low)(front|back|left|right)', name: 'norm_1_critical_hit_{P}_{n}', from: 2, flags: 18, part: 65535, aliases: ['norm_2_critical_hit_{P}_{n}', 'norm_3_critical_hit_{P}_{n}'] },
  { match: 'hurtspothead', name: 'norm_1_critical_hit_head_{n}', from: 2, flags: 18, part: 65535, aliases: ['norm_2_critical_hit_head_{n}', 'norm_3_critical_hit_head_{n}'] },
  // ранение на месте → падение в «раненого» (вход состояния Lua), лёжа - циклы, подъём - выход
  { match: 'hurtspot(l|r)(up|dwn)', name: 'fc2_fall_{n}', flags: 2, part: 65535, lua: 'into' },
  { match: 'lying(idle\\d|turn\\d|callph|drawph|fireph)', name: 'fc2_lying_{n}', flags: 0, part: 65535, lua: 'idle' },
  { match: 'lyingexpire', name: 'fc2_lying_die_{n}', flags: 2, part: 65535 },
  { match: 'getupmulti|kneerecover', name: 'fc2_getup_{n}', flags: 2, part: 65535, lua: 'out' },
  { match: 'diehead', name: 'fc2_die_{n}', flags: 2, part: 65535 },
  { match: 'hurt_minor', name: 'fc2_flinch_{n}', flags: 2, part: 65535 }, // родные damage_ - FX на кости; аддитивный перенос - отдельно
];
const slotRules: SlotRule[] = SLOTS ? JSON.parse(readFileSync(SLOTS, 'utf8')) : DEFAULT_SLOTS;
const slotCount = new Map<string, number>(); // счётчик {n} - на каждое итоговое имя (torso и legs нумеруются отдельно)
function applySlot(path: string): { name: string; def: OmfMotionDef; lua?: string } | null {
  for (const r of slotRules) {
    const m = new RegExp(r.match, 'i').exec(path);
    if (!m) continue;
    const sub = (t: string) => {
      let o = t;
      if (m[1] && m[2]) o = o.replace('{P}', (m[1].toLowerCase() === 'up' ? UPPER : SIDE)[m[2].toLowerCase()] ?? 'torso');
      return o.replace(/\{(\d)\}/g, (_, g) => m[Number(g)] ?? '');
    };
    const key = sub(r.name), n = slotCount.get(key) ?? (r.from ?? 0); slotCount.set(key, n + 1);
    const fill = (t: string) => sub(t).replace('{n}', String(n));
    return { name: fill(r.name), def: { flags: r.flags ?? 0, boneOrPart: r.part ?? 65535, aliases: r.aliases?.map(fill) }, lua: r.lua };
  }
  return null;
}

async function diskFile(path: string, rel: string): Promise<BlobFile> {
  const f = new File([await openAsBlob(path)], basename(path));
  Object.defineProperty(f, 'webkitRelativePath', { value: rel.replace(/\\/g, '/') });
  return f;
}
function walk(dir: string, out: string[]): void { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } }

// ---------------------------------------------------------------- источник
const files = await Promise.all((() => { const p: string[] = []; walk(FC2, p); return p; })().map((p) => diskFile(p, basename(FC2) + '/' + relative(FC2, p))));
const fat = files.find((f) => /\.fat$/i.test(f.name) && !/sound|shader/i.test(f.name));
if (!fat) throw new Error('в папке нет .fat');
const arc = await openDuniaArchive(fat, files);
if (!arc) throw new Error('архив Dunia не открылся');
const HUMAN = 'graphics/characters/_common/';
const skEntry = arc.lookup('graphics\\characters\\_common\\pelvis_ref.skeleton') ?? arc.entries.find((e) => e.path.toLowerCase() === HUMAN + 'pelvis_ref.skeleton');
if (!skEntry) throw new Error('скелет людей не найден');
const src: DuniaSkelBone[] = parseSkeleton(await arc.read(skEntry));
const srcIdx = new Map(src.map((b, i) => [b.name, i]));
const srcBindQ: Q[] = src.map((b) => pQ(qnorm(b.rot as Q)));
const srcBindP: V[] = src.map((b) => pV(b.pos as V));

// ---------------------------------------------------------------- цель
const ab = readFileSync(OGFP);
const ogf = parseOGF(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength) as ArrayBuffer);
const tgt = ogf.bones, tgtIdx = new Map(tgt.map((b, i) => [b.name.toLowerCase(), i]));
const xsk = new XraySkeleton(tgt);
// bindLocalV хранится построчно для вектора-строки; как column-major это и есть обычная матрица поворота
const tgtBindQ: Q[] = tgt.map((_, i) => matQ(xsk.bindLocalV[i]!));
const tgtBindP: V[] = tgt.map((_, i) => [xsk.bindLocalV[i]![12]!, xsk.bindLocalV[i]![13]!, xsk.bindLocalV[i]![14]!]);
const map: Record<string, string> = MAP ? JSON.parse(readFileSync(MAP, 'utf8')) : DEFAULT_MAP;
const pairs: Array<[number, number]> = [];
for (const [s, t] of Object.entries(map)) { const si = srcIdx.get(s), ti = tgtIdx.get(t.toLowerCase()); if (si !== undefined && ti !== undefined) pairs.push([si, ti]); else console.log(`! карта: ${s} → ${t}: ${si === undefined ? 'нет в FC2' : 'нет в модели'}`); }
const legLen = (names: string[], idx: Map<string, number>, P: V[]) => names.reduce((s, n) => { const i = idx.get(n); return i === undefined ? s : s + Math.hypot(...P[i]!); }, 0);
const legRatio = legLen(['bip01_l_calf', 'bip01_l_foot'], tgtIdx, tgtBindP) / (legLen(['L Calf', 'L Foot'], srcIdx, srcBindP) || 1);
const rootT = tgtIdx.get(ROOT_TARGET) ?? -1, pelvisS = srcIdx.get('Pelvis') ?? 0;
// мировые bind-позы обоих ригов и поворот G (вокруг Y), совмещающий ось таза (левое бедро → правое)
const worldOf = (par: number[], Lq: Q[], Lp: V[]): Array<{ q: Q; p: V }> => {
  const w: Array<{ q: Q; p: V }> = [];
  for (let i = 0; i < par.length; i++) { const pa = par[i]!; w[i] = pa < 0 ? { q: Lq[i]!, p: Lp[i]! } : { q: qnorm(qmul(w[pa]!.q, Lq[i]!)), p: (() => { const r = qrot(w[pa]!.q, Lp[i]!); return [r[0] + w[pa]!.p[0], r[1] + w[pa]!.p[1], r[2] + w[pa]!.p[2]] as V; })() }; }
  return w;
};
const srcPar = src.map((b) => b.parent), tgtPar = tgt.map((b) => b.parent);
const srcBindW = worldOf(srcPar, srcBindQ, srcBindP), tgtBindW = worldOf(tgtPar, tgtBindQ, tgtBindP);
const hipAxis = (idx: Map<string, number>, W: Array<{ q: Q; p: V }>, l: string, r: string): V | null => { const a = idx.get(l), b = idx.get(r); if (a === undefined || b === undefined) return null; return [W[a]!.p[0] - W[b]!.p[0], 0, W[a]!.p[2] - W[b]!.p[2]]; };
const hs = hipAxis(srcIdx, srcBindW, 'L Thigh', 'R Thigh'), ht = hipAxis(tgtIdx, tgtBindW, 'bip01_l_thigh', 'bip01_r_thigh');
const yaw = hs && ht ? Math.atan2(ht[0], ht[2]) - Math.atan2(hs[0], hs[2]) : 0;
const Gb: Q = [Math.cos(yaw / 2), 0, Math.sin(yaw / 2), 0], Gbi = conj(Gb); // по bind-позе: для опорной позы цели (refW)
// G для кадров анимации - ниже, после поправки Yb (анимации FC2 стоят не так, как .skeleton: ещё −90° курса)
let G: Q = Gb, Gi: Q = conj(Gb);
/** Минимальный поворот, переводящий единичный вектор a в b. */
const aimQ = (a: V, b: V): Q => {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) { const ax: V = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[1], a[0], 0]; const l = Math.hypot(...ax) || 1; return [0, ax[0] / l, ax[1] / l, ax[2] / l]; }
  return qnorm([1 + d, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
};
const boneDir = (q: Q): V => qrot(q, [1, 0, 0]);
// опорная поза цели: bind, довёрнутый так, чтобы оси костей смотрели как у FC2 (в системе X-Ray, после G)
const srcOf = new Map<number, number>(pairs.map(([si, ti]) => [ti, si]));
const tgtRefW: Q[] = tgt.map((_, ti) => { const si = srcOf.get(ti); if (si === undefined) return tgtBindW[ti]!.q; return qnorm(qmul(aimQ(boneDir(tgtBindW[ti]!.q), qrot(Gb, boneDir(srcBindW[si]!.q))), tgtBindW[ti]!.q)); });
console.log(`совмещение ригов: поворот G по bind ${(yaw * 180 / Math.PI).toFixed(1)}°`);
const YAW_OPT = opt('--yaw', ''); // ручная поправка курса анимаций к bind, градусы (иначе - по первому стоячему клипу)
/** Мировые позы источника в кадре t без дорожки корня (для оценки курса). */
function srcWorldAt(a: MabAnim, t: number): Array<{ q: Q; p: V }> {
  const sq: Q[] = srcBindQ.map((q) => q.slice() as Q), sp: V[] = srcBindP.map((p) => p.slice() as V);
  for (let si = 0; si < src.length; si++) { const q = sampleQ(a, si, t), p = sampleP(a, si, t); if (q) sq[si] = pQ(q); if (p) sp[si] = pV(p); }
  return worldOf(srcPar, sq, sp);
}
/** Курс анимаций FC2 относительно bind .skeleton (Yb): по оси таза стоячего клипа в кадре 0. Складывается в G. */
function applyBaseYaw(a: MabAnim | null, from: string): void {
  let yb = 0;
  if (YAW_OPT) yb = parseFloat(YAW_OPT) * Math.PI / 180;
  else if (a && hs) {
    const w = srcWorldAt(a, 0), l = srcIdx.get('L Thigh')!, r = srcIdx.get('R Thigh')!;
    const ha: V = [w[l]!.p[0] - w[r]!.p[0], w[l]!.p[1] - w[r]!.p[1], w[l]!.p[2] - w[r]!.p[2]];
    yb = Math.atan2(ha[0], ha[2]) - Math.atan2(hs[0], hs[2]);
  }
  const Yb: Q = [Math.cos(yb / 2), 0, Math.sin(yb / 2), 0];
  G = qnorm(qmul(Gb, conj(Yb))); Gi = conj(G);
  console.log(`курс анимаций к bind: ${(yb * 180 / Math.PI).toFixed(1)}° (${from}); G для кадров ${(2 * Math.atan2(G[2], G[0]) * 180 / Math.PI).toFixed(1)}°`);
}
console.log(`FC2 костей ${src.length}, X-Ray ${tgt.length}, пар ${pairs.length}, ноги ${legRatio.toFixed(3)}`);

// ---------------------------------------------------------------- перенос
const FPS = 30;
function sampleQ(a: MabAnim, b: number, t: number): Q | null {
  const keys = a.rotKeys.get(b);
  if (keys) { const f = Math.min(t * a.rate, keys.length - 1), k = Math.floor(f), k2 = Math.min(k + 1, keys.length - 1); return nlerp(keys[k] as Q, keys[k2] as Q, f - k); }
  const c = a.constRot.get(b); return c ? qnorm(c as Q) : null;
}
function sampleP(a: MabAnim, b: number, t: number): V | null {
  const keys = a.posKeys.get(b);
  if (keys) { const f = Math.min(t * a.rate, keys.length - 1), k = Math.floor(f), k2 = Math.min(k + 1, keys.length - 1); return lerp(keys[k] as V, keys[k2] as V, f - k); }
  const c = a.constPos.get(b); return c ? (c as V) : null;
}
function retarget(name: string, a: MabAnim): { motion: XrayMotion; report: string; rootMover: boolean } {
  const frames = Math.max(2, Math.round(a.duration * FPS) + 1);
  const rot: Int16Array[] = tgt.map(() => new Int16Array(frames * 4));
  const trans: Float32Array[] = tgt.map(() => new Float32Array(frames * 3));
  const nRoot = Math.max(a.rootPos?.length ?? 0, a.rootRot?.length ?? 0);
  const r0: Q = (a.rootRot?.[0] as Q | undefined) ?? [1, 0, 0, 0], p0: V = (a.rootPos?.[0] as V | undefined) ?? [0, 0, 0];
  const rootAt = (t: number): { q: Q; p: V } => {
    if (nRoot < 1) return { q: [1, 0, 0, 0], p: [0, 0, 0] };
    const f = Math.min(t * a.rate, nRoot - 1), k = Math.floor(f), k2 = Math.min(k + 1, nRoot - 1), u = f - k;
    const rk = nlerp((a.rootRot?.[k] as Q | undefined) ?? r0, (a.rootRot?.[k2] as Q | undefined) ?? r0, u);
    const pk = lerp((a.rootPos?.[k] as V | undefined) ?? p0, (a.rootPos?.[k2] as V | undefined) ?? p0, u);
    return { q: rk, p: pk };
  };
  let minFoot = Infinity, minPelvis = Infinity, maxPelvis = -Infinity;
  // ход корня за клип (по дорожке корня .mab) - решает, root mover ли это
  let travel = 0;
  if (nRoot > 1) { const e = rootAt(a.duration); const d = qrot(conj(r0), [e.p[0] - p0[0], e.p[1] - p0[1], 0]); travel = Math.hypot(d[0], d[1]); }
  const rootMover = travel >= ROOT_MOVE;
  for (let f = 0; f < frames; f++) {
    const t = Math.min(f / FPS, a.duration);
    // источник: локальные позы кадра (нет ключа - bind), таз - с дорожкой корня D(k) сверху
    const sq: Q[] = srcBindQ.map((q) => q.slice() as Q), sp: V[] = srcBindP.map((p) => p.slice() as V);
    for (let si = 0; si < src.length; si++) { const q = sampleQ(a, si, t), p = sampleP(a, si, t); if (q) sq[si] = pQ(q); if (p) sp[si] = pV(p); }
    const lpS = sampleP(a, pelvisS, t); // абсолютное положение таза в кадре анимации (Z вверх)
    const hSrc = tgtBindP[rootT >= 0 ? rootT : 0]![1] / (legRatio || 1); // высоты в .skeleton нет (таз в начале координат) - по сталкеру
    const pel: V = lpS ?? [0, 0, hSrc];
    let D: Q = [1, 0, 0, 0], pelPos: V = pel, rootRel: V = [0, 0, 0];
    if (nRoot > 0) {
      const r = rootAt(t);
      D = qmul(conj(r0), r.q);
      const dt: V = [r.p[0] - p0[0], r.p[1] - p0[1], r.p[2] - p0[2]];
      const rel = qrot(conj(r0), dt), rp = qrot(D, pel);
      rootRel = rel;
      pelPos = [rel[0] + rp[0], rel[1] + rp[1], rel[2] + rp[2]];
    }
    sq[pelvisS] = qnorm(qmul(pQ(D), sq[pelvisS]!)); sp[pelvisS] = pV(pelPos);
    const srcW = worldOf(srcPar, sq, sp);
    // цель: мировые повороты = G·Δw·G⁻¹·refW для сопоставленных костей; остальные держат локальный bind
    const lq: Q[] = tgtBindQ.map((q) => q.slice() as Q), lp: V[] = tgtBindP.map((p) => p.slice() as V);
    const tw: Q[] = [];
    // корень модели (root_stalker) и bip01: у root mover корень несёт D(k) и горизонтальный ход, иначе всё на нуле
    const rootM = tgtPar[rootT]! >= 0 ? tgtPar[rootT]! : rootT; // корневая кость модели (родитель bip01)
    const pelT = tgtIdx.get('bip01_pelvis') ?? -1;
    const pw = qrot(G, pV(pelPos)); const pelW: V = [pw[0] * legRatio, pw[1] * legRatio, pw[2] * legRatio]; // таз в мире
    // корень - только рыскание (курс): объект игры должен оставаться вертикальным (крен/тангаж D(k) падения - в тазу),
    // иначе XFORM сталкера наклоняется и логика сыплет исключениями (xrFrame fc2_fall_0: «error in stalker…» каждый кадр)
    const rq: Q = rootMover ? (() => { const fq = qnorm(qmul(G, qmul(pQ(D), Gi))), fw = qrot(fq, [0, 0, 1]), y = Math.atan2(fw[0], fw[2]); return [Math.cos(y / 2), 0, Math.sin(y / 2), 0] as Q; })() : [1, 0, 0, 0];
    const rtp: V = rootMover ? (() => { const r = qrot(G, pV(rootRel)); return [r[0] * legRatio, 0, r[2] * legRatio] as V; })() : [0, 0, 0];
    const tp: V[] = tgtBindP.map((p) => p.slice() as V); // мировые позиции для корня/bip01/таза считаем явно
    for (let ti = 0; ti < tgt.length; ti++) {
      const par = tgtPar[ti]!, si = srcOf.get(ti);
      if (ti === rootM) { tw[ti] = rq; lp[ti] = rtp; continue; }
      if (ti === rootT) { tw[ti] = rq; lp[ti] = [0, 0, 0]; continue; }
      if (si !== undefined) tw[ti] = qnorm(qmul(qmul(G, qmul(qmul(srcW[si]!.q, conj(srcBindW[si]!.q)), Gbi)), tgtRefW[ti]!)); // G·Δw·Gb⁻¹·refW: слева - G с поправкой курса анимаций, справа - Gb bind-позы (refW построен по Gb)
      else tw[ti] = par < 0 ? tgtBindQ[ti]! : qnorm(qmul(tw[par]!, tgtBindQ[ti]!));
      lq[ti] = par < 0 ? tw[ti]! : qnorm(qmul(conj(tw[par]!), tw[ti]!));
      if (ti === pelT) { const d: V = [pelW[0] - rtp[0], pelW[1] - rtp[1], pelW[2] - rtp[2]]; lp[ti] = qrot(conj(rq), d); }
    }
    void tp;
    // запись + отчёт (мировые высоты стоп и таза)
    const world: Array<{ q: Q; p: V }> = [];
    for (let i = 0; i < tgt.length; i++) {
      const par = tgt[i]!.parent;
      world[i] = par < 0 ? { q: lq[i]!, p: lp[i]! } : { q: qnorm(qmul(world[par]!.q, lq[i]!)), p: (() => { const r = qrot(world[par]!.q, lp[i]!); return [r[0] + world[par]!.p[0], r[1] + world[par]!.p[1], r[2] + world[par]!.p[2]] as V; })() };
      const qw = conj(lq[i]!); // X-Ray: Fmatrix::rotation(q) - матрица для вектора-строки, то есть обратный поворот
      const q16 = quantRot([qw[1], qw[2], qw[3], qw[0]]);
      rot[i]!.set(q16, f * 4); trans[i]!.set(lp[i]!, f * 3);
    }
    for (const n of ['bip01_l_foot', 'bip01_r_foot']) { const i = tgtIdx.get(n); if (i !== undefined) minFoot = Math.min(minFoot, world[i]!.p[1]); }
    const pi = tgtIdx.get('bip01_pelvis'); if (pi !== undefined) { minPelvis = Math.min(minPelvis, world[pi]!.p[1]); maxPelvis = Math.max(maxPelvis, world[pi]!.p[1]); }
  }
  const tracks: XrayTrack[] = tgt.map((_, i) => ({ rot: rot[i]!, trans: trans[i]!, constT: false }));
  const motion: XrayMotion = { kind: 'xray', name, frames, tracks, duration: frames / FPS };
  return { motion, rootMover, report: `${name}: кадров ${frames}, стопы min y ${minFoot.toFixed(2)}, таз y ${minPelvis.toFixed(2)}–${maxPelvis.toFixed(2)}${rootMover ? `, ход ${travel.toFixed(2)} м (root mover)` : ''}` };
}

// ---------------------------------------------------------------- клипы
const re = new RegExp(CLIPS, 'i');
const clips = arc.entries.filter((e) => e.path.toLowerCase().startsWith(HUMAN) && e.path.toLowerCase().endsWith('.mab') && re.test(e.path.slice(HUMAN.length)));
const picked = LIMIT > 0 ? clips.slice(0, LIMIT) : clips;
// поправка курса: первый стоячий клип (таз выше 0,6 м в кадре 0, ось таза горизонтальна)
{
  let ref: MabAnim | null = null, refName = 'нет стоячего клипа - без поправки';
  for (const e of picked) {
    try {
      const a = parseMab(await arc.read(e));
      const w = srcWorldAt(a, 0), l = srcIdx.get('L Thigh')!, r = srcIdx.get('R Thigh')!;
      const pel = sampleP(a, pelvisS, 0), hy = Math.abs(w[l]!.p[1] - w[r]!.p[1]), hxz = Math.hypot(w[l]!.p[0] - w[r]!.p[0], w[l]!.p[2] - w[r]!.p[2]);
      if (pel && pel[2] > 0.6 && hy < 0.3 * hxz) { ref = a; refName = e.path.slice(HUMAN.length); break; }
    } catch { /* не разобрался - дальше */ }
  }
  applyBaseYaw(ref, refName);
}
console.log(`клипов по «${CLIPS}»: ${clips.length}${LIMIT ? `, берём ${picked.length}` : ''}`);
mkdirSync(OUT, { recursive: true });
const motions: Array<{ motion: XrayMotion; def: OmfMotionDef }> = [];
const report: string[] = [];
const seen = new Set<string>();
const lua: Record<string, string[]> = { into: [], idle: [], out: [] };
for (const e of picked) {
  const rel = e.path.slice(HUMAN.length).replace(/\.mab$/i, '');
  let short = rel.split('/').pop()!;
  short = short.replace(/^(1st|3rd|mul|3d)ge_(fulb|uppb|lowb|syns|synm|gest)_/, '').replace(/_[+-]\d{3}(fw|lt|rt|bk)/, '').replace(/_(nowep|sedea|seade|prak\d)/, '').replace(/_i1$|_l1$|_ph$/, '');
  const slot = applySlot(rel);
  let name = (slot ? slot.name : PREFIX + short).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  for (let k = 2; seen.has(name); k++) name = `${slot ? slot.name : PREFIX + short}_${k}`.toLowerCase();
  seen.add(name);
  try {
    const a = parseMab(await arc.read(e));
    const r = retarget(name, a);
    const def: OmfMotionDef = slot ? { ...slot.def } : { flags: 0, boneOrPart: 65535 };
    if (r.rootMover) def.flags = (def.flags ?? 0) | ESM.ROOT_MOVER;
    motions.push({ motion: r.motion, def });
    if (slot?.lua) lua[slot.lua]!.push(name);
    report.push(r.report + (slot ? ` ← ${rel}` : ''));
  } catch (err) { report.push(`! ${e.path}: ${(err as Error).message}`); }
}
// части тела - как у модели (из её набора .omf): тогда part в описаниях и partition совпадают с родными
let parts: Array<{ name: string; bones: string[] }> | undefined;
if (PARTS) {
  const pb = readFileSync(PARTS), pab = pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength) as ArrayBuffer;
  const pc = readChunks(pab, 0, pab.byteLength).find((x) => x.id === OGF.S_SMPARAMS);
  const sm = pc ? parseSMParams(pab, pc) : null;
  if (sm) parts = sm.parts.map((p) => ({ name: p.name, bones: p.bones.filter((b) => tgtIdx.has(b.toLowerCase())) }));
}
const omf = writeOMF({ bones: tgt.map((b) => b.name), parts, motions });
// состояние «раненый» для state_mgr_animation_list.script (xr_wounded): вход - падение, цикл - лёжа, выход - подъём
if (lua.idle!.length) {
  const L = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ');
  const st = `\t\twounded_fc2 = { prop = { maxidle = 5, sumidle = 10, rnd = 70 },\n\t\t\tinto = { [0] = {${L(lua.into!.length ? lua.into! : [lua.idle![0]!])}} },\n\t\t\tout = { [0] = {${L(lua.out!.length ? lua.out! : [lua.idle![0]!])}} },\n\t\t\tidle = { [0] = "${lua.idle![0]}" },\n\t\t\trnd = { [0] = {${L(lua.idle!.slice(1))}} } },\n`;
  writeFileSync(join(OUT, 'state_mgr_animation_list_fc2.lua'), '-- вставить в таблицу animations state_mgr_animation_list.script (net1195); выбор состояния - wounded_state = wounded_fc2 в логике\n' + st);
}
const omfPath = join(OUT, `${PREFIX.replace(/_$/, '') || 'fc2'}_animation.omf`);
writeFileSync(omfPath, omf);
writeFileSync(join(OUT, 'retarget_report.txt'), report.join('\n') + '\n');
if (!existsSync(join(OUT, 'bone_map.json'))) writeFileSync(join(OUT, 'bone_map.json'), JSON.stringify(map, null, 1));
console.log(`написано: ${omfPath} (${motions.length} движений, ${omf.length} байт); отчёт ${join(OUT, 'retarget_report.txt')}`);
if (REPORT) console.log(report.join('\n'));
