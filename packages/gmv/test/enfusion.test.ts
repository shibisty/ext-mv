// Enfusion (Arma Reforger): архив PAK (дерево FILE, zlib), XOB9 (HEAD, цепочка LZ4 в LODS, секция со смещением UV и
// нормалью 11:11:10), EDDS (COPY/LZ4 мипы, берётся наибольший), материал .emat с наследованием.
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeEdds } from '../src/engines/enfusion/edds';
import { parseEmat } from '../src/engines/enfusion/emat';
import { openEnfusionPak } from '../src/engines/enfusion/pak';
import { anmCoverage, anmFits, loadXob } from '../src/engines/enfusion/xob';

class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); return this; }
  u16(v: number) { return this.u8(v).u8(v >> 8); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); return this; }
  be32(v: number) { for (let i = 3; i >= 0; i--) this.u8(v >>> (8 * i)); return this; }
  f32(v: number) { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); for (let i = 0; i < 4; i++) this.u8(d.getUint8(i)); return this; }
  str(s: string) { for (const c of new TextEncoder().encode(s)) this.u8(c); return this; }
  bytes(u: ArrayLike<number>) { for (let i = 0; i < u.length; i++) this.u8(u[i]!); return this; }
  get u() { return Uint8Array.from(this.b); }
}
const chunk = (tag: string, body: Uint8Array) => new W().str(tag).be32(body.length).bytes(body).u;
/** LZ4-блок только из литералов (токен + длина) — валидный поток. */
const lz4Literal = (data: Uint8Array) => {
  const w = new W(), n = data.length;
  if (n < 15) w.u8(n << 4); else { w.u8(0xf0); let r = n - 15; while (r >= 255) { w.u8(255); r -= 255; } w.u8(r); }
  return w.bytes(data).u;
};
/** Цепочка Enfusion: один блок {u24 размер, флаг 0x80}. */
const chain = (data: Uint8Array) => { const b = lz4Literal(data); return new W().u8(b.length).u8(b.length >> 8).u8(b.length >> 16).u8(0x80).bytes(b).u; };

function pak(files: Array<[string, Uint8Array, boolean?]>): Uint8Array {
  const data = new W(), recs: Array<{ name: string; off: number; cs: number; us: number; z: boolean }> = [];
  const base = 12 + 8 + 28 + 8;
  for (const [name, u, z] of files) { const s = z ? deflateSync(u) : u; recs.push({ name, off: base + data.b.length, cs: s.length, us: u.length, z: !!z }); data.bytes(s); }
  // дерево: корень → папка «Assets» → файлы
  const t = new W().u8(0).u8(0).u32(1).u8(0).u8(6).str('Assets').u32(recs.length);
  for (const r of recs) t.u8(1).u8(r.name.length).str(r.name).u32(r.off).u32(r.cs).u32(r.us).u32(0).u16(0).u8(r.z ? 1 : 0).u8(r.z ? 6 : 0).u32(0);
  const body = new W().str('PAC1').bytes(chunk('HEAD', new Uint8Array(28))).bytes(chunk('DATA', data.u)).bytes(chunk('FILE', t.u)).u;
  return new W().str('FORM').be32(body.length).bytes(body).u;
}

/** XOB9: один материал, один LOD, секция-треугольник с одним набором UV. */
function xob(matPath: string): Uint8Array {
  const strings = ['Mat', matPath], strBytes = new TextEncoder().encode(strings.join('\0') + '\0');
  const sec = new W();
  for (const i of [0, 1, 2, 0, 1, 2]) sec.u16(i); // индексы и «касательные» индексы
  for (const p of [[0, 0, 0], [1, 0, 0], [0, 2, 0]]) for (const c of p) sec.f32(c);
  for (let i = 0; i < 3; i++) sec.u32((1023 << 21) | (1023 << 10) | 1023); // нормаль (0, 0, 1)… после нормировки
  for (const [a, b] of [[-32767, -32767], [32767, -32767], [-32767, 32767]]) sec.u16(a).u16(b);
  for (let i = 0; i < 3; i++) sec.u32(i).u32(0).u32(0); // касательные вершины
  const lodData = sec.u, packed = chain(lodData);
  const head = new W().u32(0);
  for (let i = 0; i < 10; i++) head.f32(0);
  head.u16(1).u16(0).u8(1).u8(0).u16(0).u32(0).u32(strBytes.length).bytes(strBytes);
  head.u16(0).u16(1); // материал: имя, путь
  const headLen = () => head.b.length + 32 + 64 + 20;
  const lodsOff = 12 + 8 + headLen() + 8; // FORM, HEAD, LODS
  head.str('LZO4').u32(1).u32(0).f32(0.5).u32(0).u32(lodsOff).u32(packed.length).u32(lodData.length);
  head.u32(0); for (let i = 0; i < 10; i++) head.f32(0); // секция: формат, габариты, вектор
  head.u16(1).u16(3).u16(3).u16(0).u16(0).u16(0xffff).u16(0).u8(1).u8(0).u16(0).u16(0);
  head.f32(0).f32(2).f32(0).f32(1).f32(1); // UV: u 0..2, v 0..1
  const body = new W().str('XOB9').bytes(chunk('HEAD', head.u)).bytes(chunk('LODS', packed)).u;
  return new W().str('FORM').be32(body.length).bytes(body).u;
}

/** EDDS: RGBA8 (DXGI 28) 2×2, мипы 1×1 (COPY) и 2×2 (LZ4). */
function edds(): Uint8Array {
  const h = new W().u32(0x20534444).u32(124).u32(0).u32(2).u32(2).u32(0).u32(0).u32(2);
  while (h.b.length < 76) h.u8(0);
  h.u32(32).u32(4).u32(0x30315844); while (h.b.length < 128) h.u8(0);
  h.u32(28).u32(3).u32(0).u32(1).u32(0);
  const big = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]), lz = chain(big);
  const lzPayload = new W().u32(big.length).bytes(lz.subarray(0, 3)).u8(1).bytes(lz.subarray(4)).u; // флаг последнего у EDDS — ненулевой байт
  h.str('COPY').u32(4).str('LZ4 ').u32(lzPayload.length);
  return h.bytes([9, 9, 9, 255]).bytes(lzPayload).u;
}

const blob = (u: Uint8Array, name: string) => Object.assign(new Blob([u.slice().buffer]), { name });

describe('Enfusion (Arma Reforger)', () => {
  it('PAK: дерево FILE, zlib-записи, поиск по ссылке с GUID без учёта регистра', async () => {
    const a = await openEnfusionPak(blob(pak([['A.txt', new TextEncoder().encode('hello'), true], ['b.bin', Uint8Array.from([1, 2, 3])]]), 'data.pak'));
    expect(a.entries.map((e) => e.path)).toEqual(['assets/a.txt', 'assets/b.bin']);
    expect(new TextDecoder().decode(await a.read(a.lookup('{0123456789ABCDEF}Assets/A.txt')!))).toBe('hello');
    expect(Array.from(await a.read(a.lookup('assets/b.bin')!))).toEqual([1, 2, 3]);
  });

  it('EDDS: берётся наибольший мип из цепочки LZ4', () => {
    const img = decodeEdds(edds().slice().buffer);
    expect([img.width, img.height]).toEqual([2, 2]);
    expect(Array.from(img.rgba!.subarray(0, 8))).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it('EMAT: класс, родитель, ключи и вложенные блоки', () => {
    const e = parseEmat('MatPBRMulti : "{4DCA5160040E0F0D}Assets/Base.emat" {\n BCR_1 "{33E9}Assets/x_BCR.edds"\n UVTransform_1 MatUVTransform "{0D}" {\n  TilingU 12\n }\n Color_1 0.1 0.2 0.3 1\n}');
    expect([e.cls, e.parent]).toEqual(['MatPBRMulti', '{4DCA5160040E0F0D}Assets/Base.emat']);
    expect(e.props.get('BCR_1')).toBe('{33E9}Assets/x_BCR.edds');
    expect(e.props.get('UVTransform_1.TilingU')).toBe('12');
  });

  it('XOB9: LOD из цепочки LZ4, UV в границах набора, материал наследует BCRMap от родителя', async () => {
    const files: Array<[string, Uint8Array, boolean?]> = [
      ['m.xob', xob('{1111111111111111}Assets/child.emat'), true],
      ['child.emat', new TextEncoder().encode('MatPBRBasic : "{2222222222222222}Assets/base.emat" {\n Color 1 1 1 1\n}'), true],
      ['base.emat', new TextEncoder().encode('MatPBRBasic {\n BCRMap "{3333333333333333}Assets/t_BCR.edds"\n}')],
      ['t_BCR.edds', edds()],
    ];
    const a = await openEnfusionPak(blob(pak(files), 'data.pak'));
    const ctx = { files: [], archives: [a], sibling: async () => null, readPath: async (p: string) => { const e = a.lookup(p); return e ? a.read(e) : null; } };
    const m = await loadXob(a.fileOf(a.lookup('assets/m.xob')!), ctx);
    expect(m.meshes).toHaveLength(1);
    const g = m.meshes[0]!;
    expect(Array.from(g.pos)).toEqual([0, 0, 0, 1, 0, 0, 0, 2, 0]);
    expect(Array.from(g.uv)).toEqual([0, 0, 2, 0, 0, 1]);
    expect(Array.from(g.indices)).toEqual([0, 1, 2]);
    expect(g.image?.width).toBe(2);
    expect(g.image?.rgba?.[3]).toBe(255); // альфа BCR — шероховатость, не прозрачность
    expect(m.flipZ).toBe(true);
  });
});

describe('Enfusion: префабы, анимации, миры', () => {
  it('текст префаба: наследование сливает блоки по заголовку, свойства потомка поверх', async () => {
    const { parseEnfText, mergeEnf, enfChild, enfProp } = await import('../src/engines/enfusion/entext');
    const base = parseEnfText('GenericEntity {\n components {\n  MeshObject "{AAAA}" {\n   Object "{1}Assets/a.xob"\n  }\n  SlotManagerComponent "{BBBB}" {\n   Slots {\n    RegisteringComponentSlotInfo Door {\n     MergePhysics 1\n    }\n   }\n  }\n }\n}').children[0]!;
    const child = parseEnfText('GenericEntity : "{C0FFEE0000000000}Prefabs/base.et" {\n components {\n  SlotManagerComponent "{BBBB}" {\n   Slots {\n    RegisteringComponentSlotInfo Door {\n     Prefab "{2}Prefabs/door.et"\n     "Sort Priority" 3\n    }\n   }\n  }\n }\n}').children[0]!;
    expect(child.parent).toBe('{C0FFEE0000000000}Prefabs/base.et');
    const m = mergeEnf(base, child), comps = enfChild(m, 'components')!;
    expect(enfProp(enfChild(comps, 'MeshObject'), 'Object')).toBe('{1}Assets/a.xob');
    const door = enfChild(enfChild(enfChild(comps, 'SlotManagerComponent'), 'Slots'), 'RegisteringComponentSlotInfo')!;
    expect([enfProp(door, 'MergePhysics'), enfProp(door, 'Prefab'), enfProp(door, 'Sort Priority')]).toEqual(['1', '{2}Prefabs/door.et', '3']);
  });

  it('слот: Offset + Angles (Y·X·Z), кости XOB от родителя к ребёнку', async () => {
    const { slotMat, boneWorld } = await import('../src/engines/enfusion/prefab');
    const m = slotMat([1, 2, 3], [0, 90, 0]);
    // поворот 90° вокруг Y переводит X в −Z
    expect([m[0], m[2], m[12], m[13], m[14]].map((v) => Math.round(v! * 1000) / 1000 + 0)).toEqual([0, -1, 1, 2, 3]);
    const h = { strings: [], materials: [], lods: [], bones: [
      { name: 'root', t: [0, 1, 0], q: [0, 0, 0, 1], next: 0xffff, child: 1 },
      { name: 'wheel', t: [2, 0, 0], q: [0, 0, 0, 1], next: 0xffff, child: 0xffff },
    ] } as never;
    const w = boneWorld(h).get('wheel')!;
    expect([w[12], w[13], w[14]]).toEqual([2, 1, 0]);
  });

  it('ANM: кадры ключей, квантование позиции и поворота', async () => {
    const { parseAnm } = await import('../src/engines/enfusion/anm');
    const names = new TextEncoder().encode('Hips\0'), head = new W().u16(4).u16(30).u16(1).u16(names.length).bytes(names);
    head.u16(1).u16(2).u32(0).f32(0).f32(0.001).f32(0).f32(1 / 65535).f32(1).f32(0);
    const data = new W().u16(0).u16(100).u16(200).u16(300) // позиция: 1 ключ (кадр 0)
      .u16(0).u16(3) // поворот: 2 ключа — кадры 0 и 3
      .u16(0).u16(0).u16(0).u16(65535).u16(65535).u16(0).u16(0).u16(0);
    const set = new W().bytes(chunk('HEAD', head.u)).bytes(chunk('DATA', data.u)).u;
    const u = new W().str('FORM').be32(4 + 8 + set.length).str('ANIM').bytes(chunk('SET7', set)).u;
    const a = parseAnm(u);
    expect([a.frames, a.fps, a.tracks[0]!.name]).toEqual([4, 30, 'Hips']);
    expect(a.tracks[0]!.pos[0]![1].map((v) => Math.round(v * 1000) / 1000)).toEqual([0.1, 0.2, 0.3]);
    expect(a.tracks[0]!.rot.map(([t, q]) => [t, q.map((v) => Math.round(v * 1000) / 1000)])).toEqual([[0, [1, 0, 0, 0]], [3, [0, 1, 0, 0]]]); // [w, x, y, z]
  });

  it('EBIN: группа экземпляров одного префаба и одиночная сущность с coords/angles/scale', async () => {
    const { parseEbin, parseRdb } = await import('../src/engines/enfusion/world');
    const strings = ['World', ':', '$grp', 'Tree', 'coords', 'angles', 'scale'];
    const w = new W().str('EBIN').u32(1).u16(strings.length).u16(2);
    for (const s of strings) w.u16(s.length).str(s);
    w.u32(0x11111111).u32(0x22222222).u32(0x33333333).u32(0x44444444); // GUID 0, 1
    const inst = (x: number, yaw: number) => { const b = new W().u8(0).u8(0).u8(0).u8(0x0d).u16(4).u8(0x08).f32(x).f32(0).f32(5).u8(0x0d).u16(5).u8(0x08).f32(0).f32(yaw).f32(0).u; return new W().u8(0x0e).u32(4 + b.length).bytes(b).u; };
    const items = new W().bytes(inst(1, 0)).bytes(inst(2, 90)).u;
    w.u8(0x0d).u16(2).u8(0x0d).u16(3).u8(0x0d).u16(1).u8(0x05).u16(1).u8(0x0e).u32(4 + items.length).bytes(items);
    const one = new W().u8(0).u8(0).u8(0).u8(0x0d).u16(4).u8(0x08).f32(7).f32(8).f32(9).u8(0x0d).u16(6).u8(0x06).f32(2).u;
    w.u8(0x0d).u16(0).u8(0x43).u16(1).str('A').u8(0x0d).u16(1).u8(0x05).u16(0).u8(0x0e).u32(4 + one.length).bytes(one);
    const e = parseEbin(w.u);
    expect(e.guids.map((g) => g.toString(16))).toEqual(['2222222211111111', '4444444433333333']);
    expect(e.instances.map((i) => [i.ref, i.coords?.[0], i.angles?.[1] ?? 0, i.scale])).toEqual([[1, 1, 0, 1], [1, 2, 90, 1], [0, 7, 0, 2]]);
    // RDB: «путь\0» с длиной перед ним, затем тип 6, u16, u64 GUID
    const path = 'Prefabs/Tree.et', r = new W().str('FORM').u32(0).u32(path.length + 1).str(path).u8(0).u32(6).u16(0).u32(0x33333333).u32(0x44444444).u32(0).u32(0);
    expect(parseRdb(r.u).get(0x4444444433333333n)).toBe(path);
  });
  it('ANM: аддитивная дорожка (флаг 0x10000) — от позы привязки, абсолютная — как есть', async () => {
    const { anmMotion } = await import('../src/engines/enfusion/anm');
    const { NodeSkeleton } = await import('../src/core/skeleton');
    const { quatMat, identity } = await import('../src/core/math');
    const sk = new NodeSkeleton([{ name: 'Neck1', parent: -1, local: quatMat([Math.SQRT1_2, Math.SQRT1_2, 0, 0], [0, 0.29, 0]), offset: identity() }, { name: 'Head', parent: 0, local: quatMat([1, 0, 0, 0], [0, 0.04, 0]), offset: identity() }]);
    const tr = (name: string, additive: boolean) => ({ name, flags: additive ? 0x7010000 : 0x7200000, additive, pos: [[0, [0, 0.01, 0]]] as Array<[number, number[]]>, rot: [[0, [1, 0, 0, 0]]] as Array<[number, number[]]> });
    const m = anmMotion({ frames: 1, fps: 30, tracks: [tr('Neck1', true), tr('Head', false)] }, 'x', new Map([['neck1', 0], ['head', 1]]), sk);
    const neck = m.chan.get(0)!, head = m.chan.get(1)!;
    expect(neck.pos![0]![1].map((v) => +v.toFixed(3))).toEqual([0, 0.3, 0]);
    expect(neck.rot![0]![1].map((v) => +v.toFixed(3))).toEqual([0.707, 0.707, 0, 0]);
    expect(head.pos![0]![1]).toEqual([0, 0.01, 0]);
  });
  it('ANM: список по скелету — у людей без животных и анимаций оружия, проверка совпадения костей', () => {
    const fits = (p: string, human: boolean, animal = false, prefix = '') => anmFits(p, human, animal, prefix);
    expect(fits('anims/anm/player/locomotion/p_rfl_erc_idle.anm', true)).toBe(true);
    expect(fits('anims/anm/animals/hare/walk.anm', true)).toBe(false);
    expect(fits('anims/anm/player/locomotion/rifles/p_rfl_erc_idle_ras_breath_ADD.anm', true)).toBe(false);
    expect(fits('anims/anm/player/actions/gestures/p_pointing_pose_erc_ras_offset.anm', true)).toBe(false);
    expect(fits('anims/anm/player/weaponswitch/rpg22/w_rpg22_hide.anm', true)).toBe(false);
    expect(fits('assets/weapons/rifles/ak74/anims/anm/p_ak74_ik.anm', true)).toBe(true);
    expect(fits('assets/weapons/rifles/ak74/anims/anm/m_ak74_fire.anm', true)).toBe(false);
    const ak = 'assets/weapons/rifles/ak74/';
    expect(fits('assets/weapons/rifles/ak74/anims/anm/m_ak74_fire.anm', false, false, ak)).toBe(true);
    expect(fits('assets/weapons/rifles/ak74/anims/anm/p_ak74_ik.anm', false, false, ak)).toBe(false);
    expect(fits('anims/anm/animals/hare/walk.anm', false, true, 'assets/animals/hare/')).toBe(true);
    const bones = new Map([['hips', 0], ['spine1', 1], ['head', 2]]);
    const anm = (names: string[]) => ({ frames: 1, fps: 30, tracks: names.map((name) => ({ name, pos: [], rot: [], flags: 0, additive: false })) });
    expect(anmCoverage(anm(['Scene_Root', 'EntityPosition', 'Hips', 'Spine1', 'Head']), bones)).toEqual({ hit: 3, total: 3 });
    expect(anmCoverage(anm(['Hips', 'LeftUpLeg', 'Tail1', 'Ear_L']), bones)).toEqual({ hit: 1, total: 4 });
  });
  it('EBIN: дети сущности — относительно родителя; массив значений и объект со строковым классом', async () => {
    const { parseEbin } = await import('../src/engines/enfusion/world');
    const strings = ['GenericEntity', ':', 'coords', 'Labels', 'Data', 'Pt', 'Position'];
    const w = new W().str('EBIN').u32(1).u16(strings.length).u16(1);
    for (const s of strings) w.u16(s.length).str(s);
    w.u32(0x11111111).u32(0x22222222);
    const vec = (b: W, k: number, x: number, y: number, z: number) => b.u8(0x0d).u16(k).u8(0x08).f32(x).f32(y).f32(z);
    const body = (inner: Uint8Array) => new W().u8(0x0e).u32(4 + 3 + inner.length).u8(0).u8(0).u8(0).bytes(inner).u;
    // ребёнок: coords (1, 0, 0), префаб 0
    const child = new W().u8(0x0d).u16(0).u8(0x0d).u16(1).u8(0x05).u16(0).bytes(body(vec(new W(), 2, 1, 0, 0).u)).u;
    // родитель: coords (10, 5, 0); Labels — массив u32 (0x81); Data — список с объектом «0x43 класс строкой»
    const arr = new W().u8(0x0d).u16(3).u8(0x81).u32(2).u32(7).u32(9).u;
    const objBody = body(vec(new W(), 6, 0, 1, 0).u);
    const item = new W().u8(0x0d).u16(5).u8(0x43).u16(3).str('Foo').bytes(objBody).u;
    const list = new W().u8(0x0d).u16(4).u8(0x0e).u32(4 + item.length).bytes(item).u;
    const kids = new W().u8(0x0e).u32(4 + child.length).bytes(child).u;
    const inner = new W().bytes(vec(new W(), 2, 10, 5, 0).u).bytes(arr).bytes(list).bytes(kids).u;
    w.u8(0x0d).u16(0).bytes(body(inner));
    const e = parseEbin(w.u);
    expect(e.error).toBeUndefined();
    expect(e.entities.map((x) => [x.cls, x.parent])).toEqual([['GenericEntity', -1], ['GenericEntity', 0]]);
    expect(Array.from(e.entities[1]!.world.slice(12, 15))).toEqual([11, 5, 0]);
    const data = e.entities[0]!.props.get('Data') as Array<{ cls: string }>;
    expect(data.map((d) => d.cls)).toEqual(['Foo']);
    expect(e.instances.map((i) => i.ref)).toEqual([0]);
  });
  it('WST: группы ячейки (конец, префаб) и экземпляры по 36 байт', async () => {
    const { parseWst } = await import('../src/engines/enfusion/world');
    const be = (v: number) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
    const chunk = (t: string, d: Uint8Array) => new W().str(t).bytes(new Uint8Array(be(d.length))).bytes(d).u;
    const pref = new W(); for (const p of ['{0000000000000001}Prefabs/A.et\0', '{0000000000000002}Prefabs/B.et\0']) pref.u32(p.length).str(p);
    const inst = (x: number) => new W().f32(x).f32(1).f32(2).f32(1).f32(0).f32(0).f32(0).f32(1).u32(0x503).u;
    const cell = new W().u32(1).u32(0).u32(3).u32(1).bytes(inst(1)).bytes(inst(2)).bytes(inst(3)).u;
    const pre = new W().str('FORM').u32(0).str('WSTR').bytes(chunk('VERS', new W().u32(1).u)).bytes(chunk('PREF', pref.u)).u;
    const headLen = 24 + 16, gridOff = pre.length + 8 + headLen + 8;
    const head = new W().u32(0).u32(0).u32(100).u32(100).u16(1).u16(1).u32(100).u32(0).u32(2).u32(3).u32(gridOff).u;
    const u = new W().bytes(pre).bytes(chunk('HEAD', head)).bytes(chunk('GRID', cell)).u;
    const r = parseWst(u);
    expect(r.prefabs).toEqual(['{0000000000000001}Prefabs/A.et', '{0000000000000002}Prefabs/B.et']);
    expect(Array.from(r.prefab)).toEqual([0, 1, 1]);
    expect([r.data[0], r.data[8], r.data[16]]).toEqual([1, 2, 3]);
  });
  it('сплайны: Катмулл — Ром проходит через точки, озеро триангулируется', async () => {
    const { sampleSpline, earcut } = await import('../src/engines/enfusion/splines');
    const s = sampleSpline([{ p: [0, 0, 0] }, { p: [10, 0, 0] }, { p: [10, 0, 10] }], false, 2);
    expect(s[0]!.p).toEqual([0, 0, 0]);
    expect(s[s.length - 1]!.p).toEqual([10, 0, 10]);
    expect(s.some((x) => Math.abs(x.p[0] - 10) < 1e-9 && Math.abs(x.p[2]) < 1e-9)).toBe(true);
    // невыпуклый многоугольник «П»: 8 вершин → 6 треугольников
    const P: Array<[number, number]> = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]];
    expect(earcut(P)).toHaveLength(6);
  });
  it('TMAT: квадродерево материалов (листья, сырой лист 8×8, блок без хвоста)', async () => {
    const { decodeTmat } = await import('../src/engines/enfusion/world');
    // блок 1: материалы [7, 14]; корень — узел 0: три листа «материал 1» и узел 1; узел 1: лист 0, сырой 0, лист 1, лист 1
    // уровень узла 1 — 16×16, значит сырой лист 16×16 = 256 текселей по 1 биту (32 байта: шахматка по строкам)
    const raw = new W(); for (let j = 0; j < 16; j++) raw.u16(j % 2 ? 0xffff : 0);
    const b1 = new W().u16(1).u16(2).u16(2).u16(7).u16(14).u16(2).u16(0)
      .u16(0x8001).u16(0x8001).u16(0x8001).u16(1).u16(0x8000).u16(0x4000).u16(0x8001).u16(0x8001)
      .u16(1).u32(256).bytes(raw.u).u;
    // блок 2: без сырых листьев — хвоста нет
    const b2 = new W().u16(0).u16(0).u16(2).u16(3).u16(5).u16(1).u16(0).u16(0x8000).u16(0x8001).u16(0x8001).u16(0x8001).u;
    const bm = (b: Uint8Array) => new W().str('BMAT').be32(b.length).bytes(b).u;
    const tm = new W().bytes(bm(b1)).bytes(bm(b2)).u;
    const u = new W().str('FORM').be32(0).str('TERR').bytes(chunk('TMAT', tm)).u;
    const got: Array<[number, number, Uint8Array]> = [];
    decodeTmat(u, (bx, bz, ids) => got.push([bx, bz, ids.slice()]));
    expect(got.map(([x, z]) => [x, z])).toEqual([[1, 2], [0, 0]]);
    const a = got[0]![2];
    expect(a[0]).toBe(14); // (0,0) — верхний левый квадрант 32×32 — лист 1
    expect(a[40 + 0 * 64]).toBe(14);
    // узел 1 — нижний правый квадрант (32..63): его (1,0) — сырой лист 16×16 в x 48..63, z 32..47
    expect(a[32 * 64 + 48]).toBe(7); // строка 0 сырого листа — нули → материал 7
    expect(a[33 * 64 + 48]).toBe(14); // строка 1 — единицы
    expect(a[32 * 64 + 32]).toBe(7); // (0,0) узла 1 — лист 0
    expect(got[1]![2][0]).toBe(3);
    expect(got[1]![2][63]).toBe(5);
  });
  it('слои: аддитивный слой складывается с основой, абсолютный в маске заменяет её; подбор слоя прицеливания', async () => {
    const { NodeSkeleton } = await import('../src/core/skeleton');
    const { quatMat, identity } = await import('../src/core/math');
    const { autoAimLayer } = await import('../src/engines/enfusion/xob');
    const sk = new NodeSkeleton([{ name: 'Hips', parent: -1, local: quatMat([1, 0, 0, 0], [0, 1, 0]), offset: identity() }, { name: 'Spine1', parent: 0, local: quatMat([1, 0, 0, 0], [0, 0.1, 0]), offset: identity() }]);
    const key = (v: number[]): Array<[number, number[]]> => [[0, v]];
    const base = { kind: 'node' as const, name: 'b', tps: 30, duration: 1, chan: new Map([[0, { pos: key([0, 2, 0]), rot: null, scl: null }]]) };
    const add = { kind: 'node' as const, name: 'a', tps: 30, duration: 1, chan: new Map([[0, { pos: null, rot: null, scl: null, add: { pos: key([0.5, 0, 0]), rot: null } }]]) };
    const abs = { kind: 'node' as const, name: 'c', tps: 30, duration: 1, chan: new Map([[0, { pos: key([9, 9, 9]), rot: null, scl: null }], [1, { pos: key([0, 0.3, 0]), rot: null, scl: null }]]) };
    sk.pose({ ...base, layers: [{ motion: add }, { motion: abs, frame: 0, mask: new Set([1]) }] }, 0, true);
    expect(Array.from(sk.worldV[0]!.slice(12, 15))).toEqual([0.5, 2, 0]); // база + смещение; абсолютный слой маской не трогает таз
    expect(Array.from(sk.worldV[1]!.slice(12, 15)).map((v) => +v.toFixed(3))).toEqual([0.5, 2.3, 0]);
    // «дополнение»: узел 0 есть в основе — слой не трогает
    sk.pose({ ...base, layers: [{ motion: abs, frame: 0, fill: true }] }, 0, true);
    expect(Array.from(sk.worldV[0]!.slice(12, 15))).toEqual([0, 2, 0]);
    expect(Array.from(sk.worldV[1]!.slice(12, 15)).map((v) => +v.toFixed(3))).toEqual([0, 2.3, 0]);
    const by = new Map([['p_rfl_erc_aimspace_body_ras', 'player/locomotion/rifles/debugturns/p_rfl_erc_aimspace_body_ras'], ['p_rfl_cro_aimspace_ads', 'x/p_rfl_cro_aimspace_ads']]);
    expect(autoAimLayer('player/locomotion/rifles/p_rfl_erc_idle_ras', by)).toEqual(['player/locomotion/rifles/debugturns/p_rfl_erc_aimspace_body_ras']);
    expect(autoAimLayer('player/locomotion/rifles/p_rfl_cro_idle_ads', by)).toEqual(['x/p_rfl_cro_aimspace_ads']);
    expect(autoAimLayer('npc/male/body/others/semi_low_idle_sk', by)).toEqual([]);
  });
  it('сетка поз: билинейное смешение 4 соседних кадров (прицел)', async () => {
    const { NodeSkeleton } = await import('../src/core/skeleton');
    const { quatMat, identity } = await import('../src/core/math');
    const sk = new NodeSkeleton([{ name: 'Hips', parent: -1, local: quatMat([1, 0, 0, 0], [0, 0, 0]), offset: identity() }]);
    // 3×3 кадра: позиция x = столбец, y = строка
    const pos: Array<[number, number[]]> = []; for (let f = 0; f < 9; f++) pos.push([f, [f % 3, Math.floor(f / 3), 0]]);
    const aim = { kind: 'node' as const, name: 'aim', tps: 30, duration: 8 / 30, chan: new Map([[0, { pos, rot: null, scl: null }]]) };
    const base = { kind: 'node' as const, name: 'b', tps: 30, duration: 1, chan: new Map() };
    const grid = { cols: 3, rows: 3, x: 1.5, y: 0.25 };
    sk.pose({ ...base, layers: [{ motion: aim, grid }] }, 0, true);
    expect(Array.from(sk.worldV[0]!.slice(12, 15)).map((v) => +v.toFixed(3))).toEqual([1.5, 0.25, 0]);
    grid.x = 2; grid.y = 2;
    sk.pose({ ...base, layers: [{ motion: aim, grid }] }, 0, true);
    expect(Array.from(sk.worldV[0]!.slice(12, 15))).toEqual([2, 2, 0]);
  });
});
