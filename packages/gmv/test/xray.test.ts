import { describe, expect, it } from 'vitest';
import { levelModel } from '../src/engines/xray/level';
import { buildDetails, dmMesh, parseCForm, parseDetails, parseDM } from '../src/engines/xray/details';
import { evalEnvelope, parseSkl, parseSMotions, quatOfRows, smotionToXray, type Envelope } from '../src/engines/xray/smotion';
import { XraySkeleton } from '../src/engines/xray/skeleton';
import { parseOGF, type OgfBone } from '../src/engines/xray/ogf';
import { loadOgf } from '../src/engines/xray/load';
import { cornerWeights, type XrEditMesh } from '../src/engines/xray/object';
import { autoLayers } from '../src/core/motions';
import type { LoadContext } from '../src/core/plugin';
import type { Mesh, VFile, XrayMotion } from '../src/core/types';
import { Bin } from './helpers/bin';
import { makeOgf } from './helpers/fixtures';
import { lzhufCompress } from './helpers/xray';

const chunk = (b: Bin, id: number, body: Bin | Uint8Array) => { const u = body instanceof Bin ? body.toU8() : body; b.u32(id).u32(u.length).bytes(u); };
const vfile = (buf: ArrayBuffer, name: string): VFile => ({ name, arrayBuffer: async () => buf });

/** Точка p в мире после скининга вершины, привязанной к кости b. */
const skinPoint = (s: XraySkeleton, b: number, p: number[]) => { const M = s.skinV[b]!; return [0, 1, 2].map((c) => p[0]! * M[c]! + p[1]! * M[4 + c]! + p[2]! * M[8 + c]! + M[12 + c]!); };

describe('X-Ray: уровни (ЧН/ЗП)', () => {
  it('деревья TREE_PM берут самое подробное окно общих SWI (level.geom, чанк 11; визуал — чанк 20)', () => {
    const geom = new Bin();
    chunk(geom, 1, new Bin().u16(14).u16(0));
    const vb = new Bin().u32(1);
    // позиция float3 и UV SHORT4 (как у деревьев и MU-моделей)
    vb.u16(0).u16(0).u8(2).u8(0).u8(0).u8(0).u16(0).u16(12).u8(7).u8(0).u8(5).u8(0).u16(0xff).u16(0).u8(17).u8(0).u8(0).u8(0).u32(4);
    for (const [x, z] of [[0, 0], [1, 0], [0, 1], [1, 1]]) vb.f32s(x!, 0, z!).i16(x! * 2048).i16(z! * 2048).i16(100).i16(0);
    chunk(geom, 9, vb);
    // 3 треугольника в буфере: два — грубый уровень, первое окно (смещение 3, 2 треугольника) — подробный
    chunk(geom, 10, new Bin().u32(1).u32(9).u16(0).u16(1).u16(2).u16(0).u16(2).u16(1).u16(1).u16(3).u16(2));
    chunk(geom, 11, new Bin().u32(1).u32(0).u32(0).u32(0).u32(0).u32(2).u32(3).u16(2).u16(4).u32(0).u16(1).u16(3));
    const lvl = new Bin();
    chunk(lvl, 1, new Bin().u16(14).u16(0));
    chunk(lvl, 2, new Bin().u32(1).cstr('trees\\trees_bark/trees\\bark'));
    const vis = new Bin(), v0 = new Bin();
    chunk(v0, 21, new Bin().u32(0).u32(0).u32(4).u32(0).u32(0).u32(9));
    chunk(v0, 1, new Bin().u8(4).u8(11).u16(0).f32s(0, 0, 0, 1, 1, 1, 0, 0, 0, 1));
    chunk(v0, 12, new Bin().f32s(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1).zeros(40));
    chunk(v0, 20, new Bin().u32(0));
    chunk(vis, 0, v0);
    chunk(lvl, 3, vis);
    const m = levelModel(lvl.toU8(), geom.toU8(), 'test');
    expect(m.meshes[0]!.indices.length).toBe(6);
    expect(Array.from(m.meshes[0]!.uv.slice(0, 4))).toEqual([0, 0, 1, 0]); // SHORT4: UV × 2048
    expect(m.meshes[0]!.pos[0]).toBe(10); // TREEDEF2: перенос по X
  });
});

/** .dm: квадрат 1×1 на земле. */
const makeDm = (tex: string) => {
  const b = new Bin().cstr('details\\blend').cstr(tex).u32(0).f32(1).f32(1).u32(4).u32(6);
  for (const [x, z, u, v] of [[-0.5, -0.5, 0, 1], [0.5, -0.5, 1, 1], [0.5, 0.5, 1, 0], [-0.5, 0.5, 0, 0]]) b.f32s(x!, 0.5, z!, u!, v!);
  for (const i of [0, 1, 2, 0, 2, 3]) b.u16(i);
  return b.toU8();
};

describe('X-Ray: трава (.dm, level.details, level.cform)', () => {
  it('.dm читается и становится мешем с вырезанием по альфе', () => {
    const d = parseDM(makeDm('detail\\grass'));
    expect(d.texture).toBe('detail\\grass');
    expect(d.indices.length).toBe(6);
    const m = dmMesh(d, 'g');
    expect(m.alphaTest).toBe(true);
    expect(m.vertexCount).toBe(4);
  });

  // карта 2×1 ячейки (offs 1, 0): ячейка 0 — x ∈ [−2, 0], плотность максимальная; ячейка 1 — пустая
  const makeMap = () => {
    const f = new Bin(), objs = new Bin();
    chunk(objs, 0, makeDm('detail\\grass'));
    chunk(f, 1, objs);
    const slots = new Bin();
    // y_base: (−1 + 200) / 0.2 = 995, y_height 30 (3 м), id0 = 0, остальные пустые
    slots.u32(995 | (30 << 12) | (0 << 20) | (63 << 26)).u32(63 | (63 << 6)).u16(0xffff).u16(0).u16(0).u16(0);
    slots.u32(0xfff00000).u32(0xfff).u16(0).u16(0).u16(0).u16(0);
    chunk(f, 2, slots);
    chunk(f, 0, new Bin().u32(3).u32(1).u32(1).u32(0).u32(2).u32(1));
    return f.toU8();
  };
  // земля: плоскость y = 0.5 на x ∈ [−10, 10], z ∈ [−10, 10]
  const makeCForm = () => {
    const c = new Bin().u32(4).u32(4).u32(2).f32s(-10, 0, -10, 10, 1, 10);
    c.f32s(-10, 0.5, -10, 10, 0.5, -10, 10, 0.5, 10, -10, 0.5, 10);
    c.u32(0).u32(1).u32(2).u32(0).u32(0).u32(2).u32(3).u32(0);
    return c.toU8();
  };

  it('расстановка: точки ячейки на высоте коллизии, пустая ячейка пропущена', () => {
    const map = parseDetails(makeMap());
    expect([map.sizeX, map.sizeZ, map.offsX, map.models.length]).toEqual([2, 1, 1, 1]);
    const r = buildDetails(map, parseCForm(makeCForm()));
    expect(r.items).toBeGreaterThan(30);
    expect(r.keep).toBe(1);
    const m = r.meshes[0]!;
    expect(m.texture).toBe('detail\\grass');
    let minX = Infinity, maxX = -Infinity, minY = Infinity;
    for (let i = 0; i < m.vertexCount; i++) { minX = Math.min(minX, m.pos[i * 3]!); maxX = Math.max(maxX, m.pos[i * 3]!); minY = Math.min(minY, m.pos[i * 3 + 1]!); }
    expect(minX).toBeGreaterThan(-3.5); // ячейка −2..0 плюс размер модели
    expect(maxX).toBeLessThan(1.5);
    expect(minY).toBeGreaterThanOrEqual(0.5 + 0.25 - 1e-4); // низ модели (0.5 × масштаб ≥ 0.5) над землёй
  });

  it('прореживание по бюджету треугольников', () => {
    const r = buildDetails(parseDetails(makeMap()), parseCForm(makeCForm()), 20);
    expect(r.keep).toBeLessThan(1);
    expect(r.meshes.reduce((a, m) => a + m.indices.length / 3, 0)).toBeLessThan(r.candidates * 2);
  });
});

describe('X-Ray: скелет и анимации', () => {
  const bones: OgfBone[] = [
    { name: 'root', parent: -1, rot: [0, 0, 0], pos: [0, 0, 0] },
    { name: 'pelvis', parent: 0, rot: [0.3, -0.7, 1.2], pos: [0, 1, 0] },
    { name: 'spine', parent: 1, rot: [-0.4, 0.2, 0.5], pos: [0.5, 0, 0] },
  ];

  it('setXYZi: вектор-строка, сначала Z, затем X, затем Y (поворот на 90° вокруг Z: X → Y)', () => {
    const s = new XraySkeleton([{ name: 'b', parent: -1, rot: [0, 0, Math.PI / 2], pos: [0, 0, 0] }]);
    const M = s.bindWorldV[0]!;
    expect([M[0], M[1], M[2]].map((v) => Math.round(v! * 1000) / 1000)).toEqual([0, 1, 0]);
    const o = new Float32Array(16);
    s.local([0.2, 0.3, 0.4], [0, 0, 0], o);
    const R = (k: string, a: number) => { const c = Math.cos(a), si = Math.sin(a); return k === 'x' ? [1, 0, 0, 0, c, si, 0, -si, c] : k === 'y' ? [c, 0, -si, 0, 1, 0, si, 0, c] : [c, si, 0, -si, c, 0, 0, 0, 1]; };
    const mul = (a: number[], b: number[]) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!));
    const want = mul(mul(R('z', 0.4), R('x', 0.2)), R('y', 0.3));
    [0, 1, 2, 4, 5, 6, 8, 9, 10].forEach((k, i) => expect(o[k]).toBeCloseTo(want[i]!, 5));
  });

  it('анимация с bind-углами (через кватернион) не двигает меш; без инверсии кватерниона', () => {
    const s = new XraySkeleton(bones), o = new Float32Array(16);
    const tracks = bones.map((b) => { s.local(b.rot, b.pos, o); const [x, y, z, w] = quatOfRows(o); return { rot: Int16Array.from([x, y, z, w].map((v) => Math.round(v * 32767))), trans: Float32Array.from(b.pos), constT: true }; });
    const m: XrayMotion = { kind: 'xray', name: 'bind', frames: 1, duration: 1 / 30, tracks };
    s.pose(m, 0, true);
    expect(skinPoint(s, 2, [1, 2, 3]).map((v) => +v.toFixed(3))).toEqual([1, 2, 3]);
    const mesh: Mesh = { name: '', texture: '', vertexCount: 3, pos: Float32Array.from([0, 1, 0, 0.5, 1, 0, 0.5, 1.3, 0.2]), nor: new Float32Array(9), uv: new Float32Array(6), bone: Float32Array.from([1, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0]), weight: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), indices: Uint16Array.from([0, 1, 2]), skinned: true };
    expect(s.motionError([mesh], m, false)).toBeLessThan(1e-3);
  });

  it('слои: кость без трека основной анимации берётся из анимации другой части', () => {
    const s = new XraySkeleton(bones);
    const q = Int16Array.from([0, 0, 0, 32767]);
    const torso: XrayMotion = { kind: 'xray', name: 'norm_torso_2_walk_0', frames: 1, duration: 1, tracks: [, , { rot: q, trans: Float32Array.from([0.5, 0, 0]), constT: true }] as never, part: 'torso' };
    const legs: XrayMotion = { kind: 'xray', name: 'norm_walk_fwd_0', frames: 1, duration: 1, tracks: [, { rot: q, trans: Float32Array.from([0, 2, 0]), constT: true }] as never, part: 'legs' };
    const idle: XrayMotion = { ...legs, name: 'norm_turn_left_0' };
    expect(autoLayers(torso, [torso, idle, legs]).map((x) => x.name)).toEqual(['norm_walk_fwd_0']);
    s.pose({ ...torso, layers: [legs] }, 0, true);
    expect(s.worldV[1]![13]).toBeCloseTo(2, 5); // таз — из анимации ног
    s.pose(torso, 0, true);
    expect(s.worldV[1]![13]).toBeCloseTo(1, 5); // без слоя — bind
  });

  // анимация SDK: кость «spine» поворачивается вокруг Z (канал B) с 0 до 90° за 10 кадров, позиция постоянна
  const env = (keys: Array<[number, number]>, shape = 3): Envelope => ({ behavior: [1, 1], keys: keys.map(([time, value]) => ({ value, time, shape, tension: 0, continuity: 0, bias: 0, param: [0, 0, 0, 0] })) });
  const writeEnv = (b: Bin, e: Envelope) => { b.u8(e.behavior[0]).u8(e.behavior[1]).u16(e.keys.length); for (const k of e.keys) { b.f32(k.value).f32(k.time).u8(k.shape); if (k.shape !== 4) for (let i = 0; i < 7; i++) b.u16(32768); } };
  const writeSMotion = (b: Bin) => {
    b.cstr('bend').u32(0).u32(10).f32(10).u16(7).u8(0).u16(0xffff).f32s(1, 2, 2, 1).u16(1);
    b.cstr('spine').u8(0);
    for (const e of [env([[0, 0.5]]), env([[0, 0]]), env([[0, 0]]), env([[0, 0]]), env([[0, 0]]), env([[0, 0], [1, Math.PI / 2]])]) writeEnv(b, e);
    b.u32(1).ascii('step\r\n').u32(1).f32s(0, 0.5);
  };

  it('огибающие: линия, TCB через ключи, ступень, поведение за краями', () => {
    expect(evalEnvelope(env([[0, 0], [1, 10]]), 0.25)).toBeCloseTo(2.5);
    expect(evalEnvelope(env([[0, 0], [1, 10]]), 5)).toBe(10);
    const tcb = env([[0, 0], [1, 10], [2, 0]], 0);
    expect(evalEnvelope(tcb, 1)).toBe(10);
    expect(evalEnvelope(tcb, 0.5)).toBeGreaterThan(5);
    expect(evalEnvelope(env([[0, 3], [1, 7]], 4), 0.9)).toBe(3);
  });

  it('.skl / .skls: чтение и перевод в треки скелета (поворот B = вокруг Z)', () => {
    const one = new Bin(); writeSMotion(one);
    const skl = new Bin(); chunk(skl, 0x1200, one);
    const sm = parseSkl(skl.toU8());
    expect([sm.name, sm.frameEnd, sm.version, sm.bones[0]!.name]).toEqual(['bend', 10, 7, 'spine']);
    const list = new Bin().u32(1); writeSMotion(list);
    expect(parseSMotions(list.toU8())).toHaveLength(1);
    const s = new XraySkeleton([{ name: 'root', parent: -1, rot: [0, 0, 0], pos: [0, 0, 0] }, { name: 'spine', parent: 0, rot: [0, 0, 0], pos: [0.5, 0, 0] }]);
    const m = smotionToXray(sm, ['root', 'spine'], (r, p, o) => s.local(r, p, o));
    expect([m.frames, m.tracks.length, !!m.tracks[1]]).toEqual([10, 2, true]);
    s.pose(m, 0, false);
    expect(skinPoint(s, 1, [1.5, 0, 0]).map((v) => +v.toFixed(3))).toEqual([1.5, 0, 0]);
    s.pose(m, 9 / 30, false); // кадр 9 → 81°
    const a = (Math.PI / 2) * 0.9, p = skinPoint(s, 1, [1.5, 0, 0]);
    expect(p[0]).toBeCloseTo(0.5 + Math.cos(a), 2);
    expect(p[1]).toBeCloseTo(Math.sin(a), 2);
  });

  it('веса вершин .object: до 4 костей по весовым картам, нормированные', () => {
    const vm = (name: string, w: number[]) => ({ name, dim: 1, poly: false, type: 1, data: Float32Array.from(w), vertices: new Uint32Array(w.length), faces: null });
    const m = { vmaps: [{ name: 'uv', dim: 2, poly: false, type: 0, data: new Float32Array(2), vertices: new Uint32Array(1), faces: null }, vm('a', [0.2]), vm('b', [0.6])], vmrefs: [[[0, 0], [1, 0], [2, 0]], []] } as unknown as XrEditMesh;
    const map = new Map([['a', 3], ['b', 5]]);
    const [bi, w] = cornerWeights(m, 0, map);
    expect(bi.slice(0, 2)).toEqual([5, 3]);
    expect(w[0]).toBeCloseTo(0.75);
    expect(cornerWeights(m, 1, map)).toEqual([[0, 0, 0, 0], [1, 0, 0, 0]]);
  });
});

describe('X-Ray OGF: сжатые чанки и ссылки на .omf', () => {
  /** Перечитать OGF, сжав чанк id (LZHUF) или дописав чанк. */
  const rebuild = (buf: ArrayBuffer, f: (id: number, body: Uint8Array, out: Bin) => void) => {
    const u = new Uint8Array(buf), dv = new DataView(buf), out = new Bin();
    for (let p = 0; p + 8 <= u.length;) { const id = dv.getUint32(p, true), n = dv.getUint32(p + 4, true); f(id, u.subarray(p + 8, p + 8 + n), out); p += 8 + n; }
    return out.toArrayBuffer();
  };
  it('чанки со старшим битом распаковываются LZHUF', () => {
    const buf = rebuild(makeOgf(false), (id, body, out) => { if (id === 3) { const z = lzhufCompress(body); out.u32(id | 0x80000000).u32(z.length).bytes(z); } else chunk(out, id, body); });
    const m = parseOGF(buf);
    expect(m.meshes[0]!.vertexCount).toBe(3);
    expect(m.meshes[0]!.pos[3]).toBe(1);
  });
  it('S_MOTION_REFS_1 (чанк 24): .omf подгружаются из открытых архивов', async () => {
    const buf = rebuild(makeOgf(true), (id, body, out) => { if (id !== 14) chunk(out, id, body); });
    const withRefs = new Bin().bytes(new Uint8Array(buf));
    chunk(withRefs, 24, new Bin().u32(1).cstr('actors\\test_anim'));
    // .omf: S_MOTIONS с той же анимацией, что во встроенной модели
    const src = parseOGF(makeOgf(true));
    expect(src.motions).toHaveLength(1);
    const omf = new Bin(), motions = new Bin();
    chunk(motions, 0, new Bin().u32(1));
    chunk(motions, 1, new Bin().cstr('walk').u32(2).u8(2).i16(0).i16(0).i16(0).i16(32767).f32s(0, 0.5, 0));
    chunk(omf, 14, motions);
    const asked: string[] = [];
    const ctx = { readPath: async (p: string) => { asked.push(p); return p === 'meshes/actors/test_anim.omf' ? omf.toU8() : null; } } as unknown as LoadContext;
    const m = await loadOgf(vfile(withRefs.toArrayBuffer(), 'a.ogf'), ctx);
    expect(asked[0]).toBe('meshes/actors/test_anim.omf');
    expect(m.motions.map((x) => [x.name, x.source])).toEqual([['walk', 'test_anim.omf']]);
    expect(m.info.join('\n')).toMatch(/подключено 1/);
  });
});
