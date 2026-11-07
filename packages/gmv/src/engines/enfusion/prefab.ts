// Префабы Enfusion (.et): сущность = модель из MeshObject (+ замены материалов) и дочерние префабы в слотах.
// Слоты: SlotManagerComponent (двери, колёса, крыша, стёкла техники — PivotID кость родителя + Offset + Angles),
// BaseLoadoutManagerComponent (одежда и снаряжение персонажа — на общем скелете, без смещения), AttachmentSlotComponent
// (обвес оружия), VisualIdentity (голова и тело персонажа). Наследование префабов — «Класс : "{GUID}родитель.et"».
// Оси Enfusion: X вправо, Y вверх, Z вперёд (левая система) — в просмотрщике flipZ.
import { boundsOf, skinnedBounds, sumTris, sumVerts } from '../../core/geometry';
import type { NodeSkeleton } from '../../core/skeleton';
import { xobSkeleton } from './anm';
import type { LoadContext } from '../../core/plugin';
import type { Mesh, Model, VFile } from '../../core/types';
import { enfChild, enfProp, enfVec, mergeEnf, parseEnfText, type EnfNode } from './entext';
import { enfusionPath } from './pak';
import { listAnms, xobMeshes, type XobHead } from './xob';

type M4 = Float64Array;
const ident = (): M4 => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
const mul = (a: M4, b: M4): M4 => {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!; o[c * 4 + r] = s; }
  return o;
};
/** Кватернион [x, y, z, w] + перенос → матрица (столбцы). */
export function quatMat(q: readonly number[], t: readonly number[]): M4 {
  const [x, y, z, w] = q as [number, number, number, number], m = ident();
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y);
  m[12] = t[0]!; m[13] = t[1]!; m[14] = t[2]!;
  return m;
}
/** Offset + Angles (градусы вокруг X, Y, Z; порядок Y·X·Z). */
export function slotMat(off: readonly number[] | null, ang: readonly number[] | null): M4 {
  const r = (ang ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(r[0]!), sx = Math.sin(r[0]!), cy = Math.cos(r[1]!), sy = Math.sin(r[1]!), cz = Math.cos(r[2]!), sz = Math.sin(r[2]!);
  const rx = ident(), ry = ident(), rz = ident();
  rx[5] = cx; rx[6] = sx; rx[9] = -sx; rx[10] = cx;
  ry[0] = cy; ry[2] = -sy; ry[8] = sy; ry[10] = cy;
  rz[0] = cz; rz[1] = sz; rz[4] = -sz; rz[5] = cz;
  const m = mul(ry, mul(rx, rz));
  if (off) { m[12] = off[0]!; m[13] = off[1]!; m[14] = off[2]!; }
  return m;
}

/** Мировые матрицы костей XOB (переносы и повороты — относительно родителя; дерево — «первый ребёнок / следующий брат»). */
export function boneWorld(h: XobHead): Map<string, M4> {
  const out = new Map<string, M4>(), NONE = 0xffff;
  const visit = (i: number, parent: M4, depth: number): void => {
    for (let guard = 0; i !== NONE && i < h.bones.length && guard < 4096 && depth < 128; guard++) {
      const b = h.bones[i]!, g = mul(parent, quatMat(b.q, b.t));
      if (!out.has(b.name)) out.set(b.name, g);
      if (b.child !== NONE) visit(b.child, g, depth + 1);
      i = b.next;
    }
  };
  if (h.bones.length) visit(0, ident(), 0);
  return out;
}

interface Cache { key: unknown; prefabs: Map<string, Promise<EnfNode | null>> }
let cache: Cache = { key: null, prefabs: new Map() };

/** Префаб с применённым наследованием (корневая сущность). */
export function resolvePrefab(ref: string, ctx: LoadContext, depth = 0): Promise<EnfNode | null> {
  const key = enfusionPath(ref), k0 = ctx.archives[0] ?? null;
  if (cache.key !== k0) cache = { key: k0, prefabs: new Map() };
  let p = cache.prefabs.get(key);
  if (!p) {
    p = (async () => {
      const u = await ctx.readPath(key);
      if (!u) return null;
      const ent = parseEnfText(new TextDecoder().decode(u)).children[0];
      if (!ent) return null;
      if (ent.parent && depth < 16) {
        const base = await resolvePrefab(ent.parent, ctx, depth + 1);
        if (base) return mergeEnf(base, ent);
      }
      return ent;
    })().catch(() => null);
    cache.prefabs.set(key, p);
  }
  return p;
}

const SLOT_CLS = /SlotInfo$|StorageSlot$/;
/** Слоты, которые не дают видимых частей (свет, экипаж, инвентарь, служебные). */
const SKIP_SLOT = /Emissive|Light|Compartment|Salvage|EquipmentStorage|Probe/;
const HIDE_SLOT = /^(SupplyStorage|ShadowAO|Shadow)|Shadow/i;
/** Компоненты, внутри которых ищем слоты. */
const SLOT_HOSTS = /^(SlotManagerComponent|BaseLoadoutManagerComponent|BaseLoadoutClothComponent|AttachmentSlotComponent|WeaponComponent|MuzzleComponent|SightsComponent|.*AttachmentSlot.*|components|Slots)$/;

export interface PrefabPart {
  name: string; xob: string; world: M4; remap: Map<string, string>; hidden: boolean;
  /** Кость общего скелета, к которой часть прикреплена жёстко (оружие в руке, двери на кости машины) — следует анимации. */
  bindBone?: string;
  /** Тело персонажа (VisualIdentity Body): его секции скрываются под одеждой. */
  body?: boolean;
}

export interface CollectOptions {
  world?: M4; label?: string; depth?: number; hidden?: boolean; parentBones?: Map<string, M4>;
  bindBone?: string; childPivot?: string; slotHide?: string[];
}
interface Walk { out: PrefabPart[]; warn: string[]; ctx: LoadContext; hide: Set<string>; bodyMap: Map<string, string[]> | null; weapons: boolean }

/** Обойти префаб: модель, слоты (рекурсивно), идентичность персонажа, оружие. Секции тела под одеждой — в hideBody. */
export async function collectParts(ref: string, ctx: LoadContext, opt: CollectOptions = {}, warn: string[] = [], hideBody?: Set<string>, weapons = true): Promise<PrefabPart[]> {
  const w: Walk = { out: [], warn, ctx, hide: new Set(), bodyMap: null, weapons };
  await walkPrefab(ref, w, opt);
  if (hideBody) for (const k of w.hide) for (const n of w.bodyMap?.get(k.toLowerCase()) ?? [`basebody_${k}`, `basebody_${k}_wound`]) hideBody.add(n.toLowerCase());
  return w.out;
}

const inv = (m: M4): M4 => {
  // обратная жёсткого преобразования: Rᵀ, −Rᵀt
  const o = ident();
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c]!;
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r]! * m[12]! + o[4 + r]! * m[13]! + o[8 + r]! * m[14]!);
  return o;
};

async function walkPrefab(ref: string, w: Walk, o: CollectOptions): Promise<void> {
  if ((o.depth ?? 0) > 8) return;
  const ent = await resolvePrefab(ref, w.ctx);
  if (!ent) { w.warn.push(`нет префаба ${enfusionPath(ref)}`); return; }
  await walkEntity(ent, ref, w, o);
}

async function walkEntity(ent: EnfNode, ref: string, w: Walk, o: CollectOptions): Promise<void> {
  const depth = o.depth ?? 0;
  let world = o.world ?? ident();
  const comps = enfChild(ent, 'components');
  const mo = comps?.children.find((c) => c.header[0] === 'MeshObject');
  // одежда и снаряжение: на персонаже — «надетая» модель (WornModel), в MeshObject — модель предмета на земле
  const cloth = comps?.children.find((c) => c.header[0] === 'BaseLoadoutClothComponent');
  // скрыть части тела: список слота персонажа или OverrideMeshesToHide самой одежды
  const ov = enfChild(cloth, 'OverrideMeshesToHide');
  for (const k of ov ? ov.items : o.slotHide ?? []) w.hide.add(k);
  const obj = enfProp(cloth, 'WornModel') || enfProp(mo, 'Object');
  const remap = new Map<string, string>();
  for (const a of enfChild(mo, 'Materials')?.children ?? []) {
    const s = enfProp(a, 'SourceMaterial'), d = enfProp(a, 'AssignedMaterial');
    if (s && d) remap.set(s, d);
  }
  const base = o.label || enfusionPath(ref).replace(/^.*\//, '').replace(/\.et$/, '');
  let bones = new Map<string, M4>();
  const useObj = !!obj && !/common\/models\/default\.xob$/i.test(enfusionPath(obj));
  if (useObj) bones = new Map(await xobBones(obj!, w.ctx));
  // ChildPivotID: к точке родителя прикладывается кость самой части (snap_weapon магазина, глушителя, прицела)
  if (o.childPivot) {
    const cp = bones.get(o.childPivot) ?? [...bones].find(([k]) => k.toLowerCase() === o.childPivot!.toLowerCase())?.[1];
    if (cp) world = mul(world, inv(cp));
  }
  const isBody = /· тело$/.test(base);
  const same = useObj ? w.out.find((p) => enfusionPath(p.xob) === enfusionPath(obj!) && p.world.every((v, i) => Math.abs(v - world[i]!) < 1e-6)) : undefined;
  // тело персонажа часто совпадает с моделью самой сущности (MeshObject персонажа = Basebody) — помечаем её
  if (same) { if (isBody) same.body = true; }
  else if (useObj) w.out.push({ name: base, xob: obj!, world, remap, hidden: !!o.hidden, bindBone: o.bindBone, body: isBody });
  // кости родителя (одежда и навесное снаряжение сидят на скелете персонажа, детали двери — на скелете машины)
  if (o.parentBones) for (const [k, v] of o.parentBones) if (!bones.has(k)) bones.set(k, v);
  const boneOf = (name: string) => bones.get(name) ?? [...bones].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  // идентичность персонажа: голова и тело; таблица частей тела (PartType → секции модели)
  const vis = findDeep(comps, (n) => n.header.includes('VisualIdentity'));
  const bmc = vis?.children.find((c) => c.header[0] === 'BodyMeshesConfig');
  if (bmc?.parent && !w.bodyMap) w.bodyMap = await bodyMeshConfig(bmc.parent, w.ctx);
  for (const k of ['Body', 'Head']) {
    const r = enfProp(vis, k);
    if (r) await walkPrefab(r, w, { world, label: `${base} · ${k === 'Head' ? 'голова' : 'тело'}`, depth: depth + 1, hidden: o.hidden, parentBones: bones, bindBone: o.bindBone });
  }
  // слоты
  const slots: Array<{ s: EnfNode; host: EnfNode | undefined }> = [];
  const scan = (n: EnfNode | undefined, d: number): void => {
    for (const c of n?.children ?? []) {
      if ((SLOT_CLS.test(c.header[0] ?? '') || SLOT_CLS.test(c.header[1] ?? '') || c.header[0] === 'AttachmentSlot') && !SKIP_SLOT.test(c.header.join(' '))) slots.push({ s: c, host: n });
      else if (d < 6 && SLOT_HOSTS.test(c.header[0] ?? '')) scan(c, d + 1);
    }
  };
  scan(comps, 0);
  const place = async (pref: string, s: EnfNode, name: string, extra: CollectOptions = {}) => {
    const pivot = enfProp(s, 'PivotID') ?? enfProp(s.children.find((c) => c.props.has('PivotID')), 'PivotID');
    const pv = pivot ? boneOf(pivot) : undefined;
    if (pivot && !pv) w.warn.push(`${base}: нет кости ${pivot}`);
    const m = mul(world, mul(pv ?? ident(), slotMat(enfVec(s, 'Offset'), enfVec(s, 'Angles'))));
    // кость, к которой часть приклеена: у корневой сущности — сама точка крепления, глубже — унаследованная
    const bindBone = o.bindBone ?? (depth === 0 && pv ? pivot : undefined);
    await walkPrefab(pref, w, { world: m, label: `${base} · ${name}`, depth: depth + 1, hidden: !!o.hidden || HIDE_SLOT.test(name), parentBones: pv ? undefined : bones, bindBone, childPivot: enfProp(s, 'ChildPivotID'), ...extra });
  };
  for (const { s, host } of slots) {
    // магазин оружия: шаблон — в MuzzleComponent, точка — MagazinePosition
    const pref = enfProp(s, 'Prefab') || (s.header[0] === 'MagazinePosition' ? enfProp(host, 'MagazineTemplate') : undefined);
    if (!pref) continue;
    await place(pref, s, s.header[0] === 'MagazinePosition' ? 'магазин' : s.header[s.header.length - 1] ?? 'слот', { slotHide: enfChild(s, 'MeshesToHide')?.items });
  }
  // дочерние сущности префаба (блок «{ … }» без заголовка): свои координаты относительно родителя
  for (const blk of ent.children) if (!blk.header.length) for (const ch of blk.children) {
    if (depth >= 8) break;
    if (/Probe|Light|Sound|Trigger|Decal/i.test(ch.header[0] ?? '')) continue;
    let node: EnfNode | null = ch;
    if (ch.parent) { const b = await resolvePrefab(ch.parent, w.ctx); node = b ? mergeEnf(b, ch) : null; }
    if (!node || !enfChild(node, 'components')) continue;
    const m = mul(world, slotMat(enfVec(ch, 'coords'), enfVec(ch, 'angles')));
    await walkEntity(node, ch.parent ?? ref, w, { world: m, label: `${base} · ${ch.header[0] ?? 'дочерняя'}`, depth: depth + 1, hidden: o.hidden, bindBone: o.bindBone });
  }
  // оружие персонажа: основное (меньший WeaponSlotIndex) — в правой руке (RightHandProp), остальные — на своих местах за спиной
  if (w.weapons && comps) {
    const ws = comps.children.filter((c) => c.header[0] === 'CharacterWeaponSlotComponent' && enfProp(c, 'WeaponTemplate'))
      .sort((a, b) => +(enfProp(a, 'WeaponSlotIndex') ?? 9) - +(enfProp(b, 'WeaponSlotIndex') ?? 9));
    const hand = enfChild(comps.children.find((c) => c.header[0]?.endsWith('CharacterControllerComponent')), 'RightHandPosition');
    for (const [i, c] of ws.entries()) {
      const at = c.children.find((x) => x.header[0] === 'AttachType');
      if (i > 0 && (enfProp(c, 'HolsteredHidden') === '1' || !at)) continue;
      const slot: EnfNode = i === 0 ? (hand ?? { header: ['RightHand'], props: new Map([['PivotID', ['RightHandProp']]]), items: [], children: [] }) : at!;
      if (i === 0 && !enfProp(slot, 'PivotID')) slot.props.set('PivotID', ['RightHandProp']);
      await place(enfProp(c, 'WeaponTemplate')!, slot, i === 0 ? 'оружие в руке' : 'оружие за спиной');
    }
  }
}

/** BaseBodyMeshConfig.conf: PartType → секции модели тела (целая и раненая версии). */
async function bodyMeshConfig(ref: string, ctx: LoadContext): Promise<Map<string, string[]> | null> {
  const u = await ctx.readPath(enfusionPath(ref)).catch(() => null);
  if (!u) return null;
  const out = new Map<string, string[]>();
  const visit = (n: EnfNode): void => {
    const t = enfProp(n, 'PartType');
    if (t) out.set(t.toLowerCase(), [enfProp(n, 'HealthyVersion'), enfProp(n, 'WoundVersion')].filter((x): x is string => !!x));
    n.children.forEach(visit);
  };
  visit(parseEnfText(new TextDecoder().decode(u)));
  return out.size ? out : null;
}

function findDeep(n: EnfNode | undefined, pred: (n: EnfNode) => boolean, d = 0): EnfNode | undefined {
  for (const c of n?.children ?? []) { if (pred(c)) return c; const r = d < 6 ? findDeep(c, pred, d + 1) : undefined; if (r) return r; }
  return undefined;
}

const boneCache = new Map<string, Promise<Map<string, M4>>>();
async function xobBones(ref: string, ctx: LoadContext): Promise<Map<string, M4>> {
  const key = enfusionPath(ref);
  let p = boneCache.get(key);
  if (!p) {
    p = (async () => {
      const u = await ctx.readPath(key);
      if (!u) return new Map<string, M4>();
      const { parseXobHead, xobChunks } = await import('./xob');
      const h = xobChunks(u).get('HEAD');
      return h ? boneWorld(parseXobHead(u, h.off)) : new Map<string, M4>();
    })().catch(() => new Map<string, M4>());
    if (boneCache.size > 256) boneCache.clear();
    boneCache.set(key, p);
  }
  return p;
}

function transform(m: Mesh, w: M4): Mesh {
  const pos = new Float32Array(m.pos.length), nor = new Float32Array(m.nor.length);
  for (let i = 0; i < m.pos.length; i += 3) {
    const x = m.pos[i]!, y = m.pos[i + 1]!, z = m.pos[i + 2]!;
    pos[i] = w[0]! * x + w[4]! * y + w[8]! * z + w[12]!; pos[i + 1] = w[1]! * x + w[5]! * y + w[9]! * z + w[13]!; pos[i + 2] = w[2]! * x + w[6]! * y + w[10]! * z + w[14]!;
    const a = m.nor[i]!, b = m.nor[i + 1]!, c = m.nor[i + 2]!;
    nor[i] = w[0]! * a + w[4]! * b + w[8]! * c; nor[i + 1] = w[1]! * a + w[5]! * b + w[9]! * c; nor[i + 2] = w[2]! * a + w[6]! * b + w[10]! * c;
  }
  return { ...m, pos, nor };
}

export async function loadPrefabModel(main: VFile, ctx: LoadContext): Promise<Model> {
  const ref = main.path ?? main.name, warn: string[] = [], hideBody = new Set<string>();
  const parts = await collectParts(ref, ctx, {}, warn, hideBody);
  if (!parts.length) throw new Error('В префабе нет моделей (MeshObject) — это служебная сущность или конфиг');
  const meshes: Mesh[] = [], noTex = new Set<string>(), xobCache = new Map<string, Uint8Array | null>();
  const loaded: Array<{ part: PrefabPart; head: XobHead; meshes: Mesh[]; sections: string[] }> = [];
  for (const p of parts) {
    const key = enfusionPath(p.xob);
    if (!xobCache.has(key)) xobCache.set(key, await ctx.readPath(key));
    const u = xobCache.get(key);
    if (!u) { warn.push(`нет модели ${key}`); continue; }
    try {
      const r = await xobMeshes(u, ctx, p.remap);
      r.noTexture.forEach((t) => noTex.add(t));
      loaded.push({ part: p, head: r.head, meshes: r.meshes, sections: r.sections });
    } catch (e) { warn.push(`${key}: ${(e as Error).message}`); }
  }
  // общий скелет: самая «костистая» часть без смещения со скинингом (тело персонажа, корпус машины)
  const isIdent = (w: M4) => w.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6);
  const master = loaded.filter((l) => isIdent(l.part.world) && l.meshes.some((m) => m.skinned)).sort((a, b) => b.head.bones.length - a.head.bones.length)[0]
    ?? loaded.filter((l) => isIdent(l.part.world) && l.head.bones.length > 1).sort((a, b) => b.head.bones.length - a.head.bones.length)[0];
  let skeleton: NodeSkeleton | null = null;
  if (master) try { skeleton = xobSkeleton(master.head); } catch (e) { warn.push(`скелет: ${(e as Error).message}`); }
  const masterIdx = new Map((skeleton?.nodes ?? []).map((n, i) => [n.name.toLowerCase(), i]));
  let hiddenBody = 0, bound = 0;
  for (const { part: p, head, meshes: ms, sections } of loaded) {
    // кости части → кости общего скелета по именам (одежда, снаряжение)
    const map = skeleton && isIdent(p.world) ? head.bones.map((b) => masterIdx.get(b.name.toLowerCase()) ?? -1) : null;
    // жёсткое крепление к кости скелета (оружие в руке, двери, колёса) — часть двигается с анимацией
    const rigid = skeleton && p.bindBone ? masterIdx.get(p.bindBone.toLowerCase()) : undefined;
    for (const [mi, m] of ms.entries()) {
      const t = transform(m, p.world);
      t.name = `${p.name} · ${m.name}`;
      if (p.hidden) t.defaultHidden = true;
      if (p.body && hideBody.has((sections[mi] ?? '').toLowerCase())) { t.defaultHidden = true; hiddenBody++; }
      if (m.skinned && map && map.some((v) => v >= 0)) {
        const b = new Float32Array(m.bone.length);
        for (let i = 0; i < b.length; i++) { const v = map[m.bone[i]!] ?? -1; b[i] = v >= 0 ? v : 0; }
        t.bone = b;
      } else if (rigid !== undefined) {
        const n = t.vertexCount, b = new Float32Array(n * 4), wt = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) { b[i * 4] = rigid; wt[i * 4] = 1; }
        t.bone = b; t.weight = wt; t.skinned = true; bound++;
      } else t.skinned = false;
      meshes.push(t);
    }
  }
  if (!meshes.length) throw new Error(`Модели префаба не загрузились: ${warn.slice(0, 3).join('; ')}`);
  if (!meshes.some((m) => !m.defaultHidden)) for (const m of meshes) delete m.defaultHidden;
  const shown = meshes.filter((m) => !m.defaultHidden);
  const info = [`Enfusion префаб: частей ${parts.length} (моделей ${new Set(parts.map((p) => enfusionPath(p.xob))).size}), мешей ${meshes.length}, вершин ${sumVerts(shown)}, треугольников ${sumTris(shown)}`,
    'Части в слотах (двери, колёса, крыша, стёкла, одежда, снаряжение, обвес, магазин, оружие) поставлены по костям родителя; грузы и тень скрыты (включаются в списке мешей).'];
  if (hiddenBody) info.push(`Под одеждой скрыто частей тела: ${hiddenBody} (${[...hideBody].filter((x) => !/_wound$/.test(x)).join(', ')})`);
  if (bound) info.push(`Прикреплено к костям скелета (следуют анимации): мешей ${bound}`);
  if (noTex.size) info.push(`Без текстуры: ${[...noTex].slice(0, 6).join(', ')}${noTex.size > 6 ? '…' : ''}`);
  if (warn.length) info.push(`Замечания: ${[...new Set(warn)].slice(0, 6).join('; ')}`);
  // оружие в руке: его анимация хвата (assets/…/<оружие>/anims/…/p_<оружие>_ik.anm) — слоем по умолчанию: движок
  // кладёт её поверх анимации тела (поворот RightHandProp под оружие и пальцы на рукояти)
  let grip: string | undefined;
  const held = loaded.find((l) => l.part.bindBone?.toLowerCase() === 'righthandprop');
  if (held) {
    const dir = enfusionPath(held.part.xob).replace(/[^/]*$/, '');
    const cands = ctx.archives.flatMap((a) => a.entries.filter((e) => e.path.startsWith(dir) && /\/p_[^/]*_ik\.anm$/.test(e.path)).map((e) => e.path));
    grip = cands.sort((a, b) => a.length - b.length)[0];
  }
  const motions = skeleton && master ? listAnms(ctx, skeleton, enfusionPath(master.part.xob), grip) : [];
  if (grip) info.push(`Хват оружия: ${grip.replace(/^.*\//, '')} — слоем поверх анимаций тела`);
  if (skeleton) info.push(`Скелет: ${skeleton.n} костей (${master!.part.xob.replace(/^\{[0-9A-F]+\}/i, '')}), анимаций в списке ${motions.length}`);
  return { meshes, skeleton, motions, bounds: skeleton ? skinnedBounds(skeleton, shown) : boundsOf(shown), flipZ: true, info };
}
