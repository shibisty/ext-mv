// Vampire: The Masquerade – Bloodlines (Troika Source): VPK packNNN (каталог в конце), текстуры .tth + .ttz,
// MDL v2531 со сжатыми вершинами + VTX v107, карты BSP v17 (грань 104 байта).
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { openTroikaVpk } from '../src/engines/valve/vpkTroika';
import { tthToVtf } from '../src/engines/valve/tth';
import { decodeVTF } from '../src/engines/valve/vtf';
import { loadVtmb, pickIdle } from '../src/engines/valve/mdl';
import { angleMatrix, loadSourceBsp, vmtScreenFx } from '../src/engines/valve/bsp';
import { vmtInfo } from '../src/engines/valve/vmt';
import { decodeVtmbAnim, vtmbAnimList, vtmbBones, vtmbCompose } from '../src/engines/valve/vtmbanim';
import { B } from './helpers/blackbox';
import { NodeSkeleton } from '../src/core/skeleton';
import { vtmbSeqList } from '../src/engines/valve/vtmbanim';

const blob = (u: Uint8Array, name: string) => Object.assign(new Blob([u.slice().buffer]), { name }) as unknown as File;
const ab = (u: Uint8Array) => u.slice().buffer;

/** VTF 7.1, RGBA8888 (формат 0), без миниатюры, 1 мип. */
function vtf(w: number, h: number, rgba: number[]): Uint8Array {
  const b = new B().str('VTF\0').u32(7).u32(1).u32(64).u16(w).u16(h).u32(0).u16(1).u16(0).pad(4).f32(0).f32(0).f32(0).pad(4).f32(1).u32(0).u8(1).u32(0xffffffff).u8(0).u8(0);
  b.pad(64 - b.b.length);
  return b.bytes(rgba).u;
}

/** Карта BSP v17 из одной грани-квадрата 64×64 (плоскость z = 0, нормаль +Z): флаги texinfo и данные карты освещения задаются. */
function bspV17(o: { flags?: number; light?: number[]; mat?: string } = {}) {
  const lumps = new Map<number, Uint8Array>();
  lumps.set(0, new TextEncoder().encode('{\n"classname" "worldspawn"\n"skyname" "sky"\n}\n\0'));
  lumps.set(1, new B().f32(0).f32(0).f32(1).f32(0).u32(2).u);
  lumps.set(2, new B().f32(0.5).f32(0.5).f32(0.5).u32(0).u32(64).u32(64).u32(64).u32(64).u);
  lumps.set(3, new B().f32(0).f32(0).f32(0).f32(0).f32(64).f32(0).f32(64).f32(64).f32(0).f32(64).f32(0).f32(0).u);
  const ti = new B().f32(1).f32(0).f32(0).f32(0).f32(0).f32(1).f32(0).f32(0).f32(1 / 64).f32(0).f32(0).f32(0).f32(0).f32(1 / 64).f32(0).f32(0).u32(o.flags ?? 0).u32(0);
  lumps.set(6, ti.u);
  const face = new B().pad(32).u16(0).u8(0).u8(0).u32(0).i16(4).i16(0).i16(-1).i16(0).u8(0).pad(7, 255).pad(16).u32(0).f32(4096).u32(0).u32(0).u32(1).u32(1).pad(12);
  lumps.set(7, face.u);
  lumps.set(8, new B().bytes(o.light ?? [128, 128, 128, 0, 128, 128, 128, 0, 128, 128, 128, 0, 128, 128, 128, 0]).u);
  lumps.set(12, new B().u16(0).u16(0).u16(0).u16(1).u16(1).u16(2).u16(2).u16(3).u16(3).u16(0).u);
  lumps.set(13, new B().u32(1).u32(2).u32(3).u32(4).u);
  lumps.set(14, new B().pad(36).u32(0).u32(0).u32(1).u);
  lumps.set(43, new TextEncoder().encode((o.mat ?? 'TEST/MAT') + '\0'));
  lumps.set(44, new B().u32(0).u);
  const hdr = new B().str('VBSP').u32(17);
  let ofs = 8 + 64 * 16 + 4;
  const body = new B();
  for (let i = 0; i < 64; i++) {
    const d = lumps.get(i);
    if (d) { hdr.u32(ofs).u32(d.length).u32(0).u32(0); body.bytes(d); while (body.b.length % 4) body.u8(0); ofs = 8 + 64 * 16 + 4 + body.b.length; } else hdr.pad(16);
  }
  hdr.u32(1).bytes(body.u);
  const bsp = hdr.u;
  return { name: 'test.bsp', arrayBuffer: async () => ab(bsp) };
}

describe('VTMB', () => {
  it('VPK Troika: каталог в хвосте файла', async () => {
    const d1 = new TextEncoder().encode('hello'), d2 = new TextEncoder().encode('"VertexLitGeneric" {}');
    const n1 = 'Models/A.mdl', n2 = 'materials/b.vmt';
    const dir = new B().u32(n1.length).str(n1).u32(0).u32(d1.length).u32(n2.length).str(n2).u32(d1.length).u32(d2.length);
    const file = new B().bytes(d1).bytes(d2).bytes(dir.u).u32(2).u32(d1.length + d2.length).u8(0).u;
    const a = await openTroikaVpk(blob(file, 'pack001.vpk'));
    expect(a.entries.map((e) => e.path)).toEqual(['models/a.mdl', 'materials/b.vmt']);
    expect(new TextDecoder().decode(await a.read(a.lookup('materials/b.vmt')!))).toContain('VertexLitGeneric');
  });

  it('TTH + TTZ -> VTF', async () => {
    const px = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 128];
    const full = vtf(2, 2, px), head = full.subarray(0, 64), rest = full.subarray(64);
    // мипов 1: записи (мипов+1) — конец в VTF / конец в .ttz
    const tth = new B().str('TTH\0').u8(1).u8(0).u8(1).u8(0).u32(64).u32(64).u32(0).u32(full.length).u32(0).bytes(head).u;
    const img = decodeVTF(await tthToVtf(tth, new Uint8Array(deflateSync(rest))));
    expect([img.width, img.height]).toEqual([2, 2]);
    expect(Array.from(img.rgba as ArrayLike<number>)).toEqual(px);
  });

  it('VMT: patch/include, $basetexture, $alphatest', () => {
    expect(vmtInfo('"patch"\n{\n "include" "materials/wood/a.vmt"\n}').include).toBe('materials/wood/a.vmt');
    const v = vmtInfo('VertexLitGeneric\n{\n\t"$baseTexture" "Models\\X\\Y" // c\n\t"$alphatest" "1"\n}');
    expect([v.shader, v.base, v.alphaTest, v.translucent]).toEqual(['vertexlitgeneric', 'Models\\X\\Y', true, false]);
  });

  it('MDL v2531 (вершины типа 1: u16 × масштаб) + VTX v107 (вершина 2 байта)', () => {
    const m = new B().str('IDST').u32(2531).u32(0).str('test.mdl');
    m.pad(292 - m.b.length).u32(1).u32(400).u32(1).u32(420).u32(1).u32(1).u32(424).u32(1).u32(432);
    m.pad(400 - m.b.length).u32(48).pad(16); // текстура: имя @448
    m.u32(456); // cdtexture -> строка @456
    m.u16(0).pad(6); // скин @424
    m.u32(0).u32(1).u32(1).u32(48); // часть тела @432 -> модель @480
    m.str('Tex\0').pad(4).str('models/test/\0');
    m.pad(480 - m.b.length).str('ref.smd').pad(128 - 7).u32(0).f32(0).u32(1).u32(220).u32(3).u32(280).u32(0).u32(1);
    m.f32(10).f32(0).f32(0).f32(0.5).f32(0.5).f32(0.5);
    m.pad(700 - m.b.length).u32(0).u32(-220).u32(3).u32(0).pad(44);
    for (const [x, y, z, u, v] of [[0, 0, 0, 0, 0], [2, 0, 0, 255, 0], [0, 2, 0, 0, 255]]) m.u16(x!).u16(y!).u16(z!).u8(128).u8(128).u8(255).u8(u!).u8(0).u8(v!);
    m.pad(800 - m.b.length);
    const vtx = new B().u32(107).u32(24).u16(16).u16(9).u32(3).u32(0).u32(1).u32(0).u32(1).u32(36);
    vtx.u32(1).u32(8).u32(1).u32(8).u32(1).u32(12).f32(0).u16(1).u16(0).u32(8);
    vtx.u16(3).u16(3).u32(0).u32(20).u32(26).u32(0).u16(0).u16(1).u16(2).u16(0).u16(1).u16(2);
    const model = loadVtmb(ab(m.u), ab(vtx.u));
    expect(model.meshes).toHaveLength(1);
    const mesh = model.meshes[0]!;
    expect(mesh.materialPaths).toEqual(['materials/models/test/tex.vmt']);
    expect(Array.from(mesh.pos)).toEqual([10, 0, 0, 11, 0, 0, 10, 1, 0]);
    expect(mesh.uv[2]).toBeCloseTo(1); expect(mesh.uv[5]).toBeCloseTo(1);
    expect(Math.abs(mesh.nor[2]!)).toBeCloseTo(1); // нормали типа 1 пересчитываются по геометрии
  });

  it('BSP v17: грань-квадрат, UV по texinfo, карта освещения, порядок вершин', async () => {
    const main = bspV17();
    const model = await loadSourceBsp(main, { files: [], archives: [], sibling: async () => null, readPath: async () => null });
    expect(model.meshes).toHaveLength(1);
    const m = model.meshes[0]!;
    expect(m.texture).toBe('test/mat');
    expect(m.indices.length).toBe(6);
    expect(Math.max(...Array.from(m.uv))).toBeCloseTo(1);
    // треугольники смотрят по нормали плоскости (+Z)
    const P = (i: number) => [m.pos[i * 3]!, m.pos[i * 3 + 1]!, m.pos[i * 3 + 2]!];
    const [a, b, c] = [P(m.indices[0]!), P(m.indices[1]!), P(m.indices[2]!)];
    expect((b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!)).toBeGreaterThan(0);
    expect(model.lightmap?.rgb).toBe(true);
    expect(m.uv2).toBeDefined();
    expect(model.info.some((l) => l.includes('Небо: sky'))).toBe(true);
  });

  it('BSP: карты освещения рельефа (SURF_BUMPLIGHT) — за обычной картой ещё три по базису', async () => {
    // 2×2 сэмпла на блок: обычная (128), затем базис 0/1/2 — разная яркость (экспонента 0, R = G = B)
    const blk = (v: number) => [v, v, v, 0, v, v, v, 0, v, v, v, 0, v, v, v, 0];
    const main = bspV17({ flags: 0x800, light: [...blk(128), ...blk(255), ...blk(64), ...blk(16)] });
    const model = await loadSourceBsp(main, { files: [], archives: [], sibling: async () => null, readPath: async () => null });
    const lm = model.lightmap!, bump = lm.bump!;
    expect(bump).toHaveLength(3);
    const uv2 = model.meshes[0]!.uv2!, x = Math.floor(uv2[0]! * lm.width), y = Math.floor(uv2[1]! * lm.height), o = (y * lm.width + x) * 3;
    // гамма 1/2.2, половинная яркость: 255/255 -> 127/128, 64/255 -> ~68, 16/255 -> ~36
    expect(bump.map((b) => b[o])).toEqual([128, Math.round(Math.pow(64 / 255, 1 / 2.2) * 127.5), Math.round(Math.pow(16 / 255, 1 / 2.2) * 127.5)]);
    expect(lm.data[o]).toBe(Math.round(Math.pow(128 / 255, 1 / 2.2) * 127.5));
    expect(model.info.some((l) => l.includes('с рельефом'))).toBe(true);
    // без флага рельефа карт базиса нет
    const flat = await loadSourceBsp(bspV17(), { files: [], archives: [], sibling: async () => null, readPath: async () => null });
    expect(flat.lightmap!.bump).toBeUndefined();
  });

  it('BSP: вода (Water) — экранная поверхность с плоскостью, тонами и туманом; стекло Refract', async () => {
    const water = '"Water"\n{\n "$refracttexture" "_rt_WaterRefraction"\n "$refractamount" "22.0"\n "$refracttint" "[.3 .4 .2]"\n "$reflectamount" "60"\n "$reflecttint" "[.5 .5 .5]"\n "$normalmap" "dev/water_normal"\n "$fogenable" 1\n "$fogcolor" "{51 102 51}"\n "$fogstart" 1.00\n "$fogend" 600\n "Proxies" { "TextureScroll" { "texturescrollrate" .05 "texturescrollangle" 90 } }\n}';
    const readPath = async (p: string) => (p === 'materials/water/test.vmt' ? new TextEncoder().encode(water) : null);
    const model = await loadSourceBsp(bspV17({ mat: 'WATER/TEST' }), { files: [], archives: [], sibling: async () => null, readPath });
    const fx = model.meshes[0]!.screenFx!;
    expect(fx.kind).toBe('water');
    expect(fx.plane).toEqual([0, 0, 1, 0]);
    expect(fx.refractTint).toEqual([0.3, 0.4, 0.2]);
    expect(fx.fog!.color.map((x) => Math.round(x * 255))).toEqual([51, 102, 51]);
    expect([fx.fog!.start, fx.fog!.end]).toEqual([1, 600]);
    expect(fx.refract).toBeCloseTo(22 * 0.0008);
    expect(fx.scroll![0]).toBeCloseTo(0); expect(fx.scroll![1]).toBeCloseTo(0.05);
    const glass = vmtScreenFx('"Refract"\n{\n $dudvmap "x_dudv"\n $refractamount "2"\n $refracttint "[0.872 0.704 0.544]"\n $envmap "env_cubemap"\n $envmaptint "[0.3 0.2 0.2]"\n}', 'refract', false)!;
    expect(glass.kind).toBe('glass');
    expect(glass.refract).toBeCloseTo(0.02);
    expect(glass.reflectTint).toEqual([0.3, 0.2, 0.2]);
    expect(vmtScreenFx('"LightmappedGeneric" { "$basetexture" "a" }', 'lightmappedgeneric', true)).toBeNull();
  });

  it('углы Source: yaw 90 поворачивает +X в +Y', () => {
    const M = angleMatrix([0, 90, 0], [1, 2, 3]);
    expect(M[0]).toBeCloseTo(0); expect(M[1]).toBeCloseTo(1); expect(M.slice(12, 15)).toEqual([1, 2, 3]);
  });

  it('анимация v2531: поворот корня без −90° по Z, кость с флагом 0x2 — в системе корня', () => {
    const S = Math.SQRT1_2, sc = 1 / 32767;
    const bones = [{ n: 'root', p: -1, q: [0, 0, -S, S], f: 0 }, { n: 'a', p: 0, q: [0, 0, S, S], f: 0 }, { n: 'b', p: 1, q: [0, 0, 0, 1], f: 2 }];
    const m = new B().str('IDST').u32(2531);
    m.pad(240 - m.b.length).u32(3).u32(512);
    m.pad(264 - m.b.length).u32(1).u32(1024);
    m.pad(512 - m.b.length);
    bones.forEach((b, i) => {
      const o = m.b.length;
      m.u32(1000 + i * 8 - o).u32(b.p).pad(24).f32(0).f32(0).f32(0);
      for (const v of b.q) m.f32(v);
      m.f32(1).f32(1).f32(1).f32(sc).f32(sc).f32(sc).f32(sc).pad(48).u32(b.f).pad(20);
    });
    m.pad(1000 - m.b.length);
    for (const b of bones) m.str(b.n).pad(8 - b.n.length);
    m.pad(1024 - m.b.length).u32(1300 - 1024).f32(30).u32(1).u32(1).pad(32).u32(80).pad(20);
    m.pad(1104 - m.b.length);
    // записи костей по 32 байта (смещения потоков — от записи), потом данные: корень — (0,0,0,1); a — без потоков;
    // b — поворот +90° по Z в системе корня
    const rec = (data: number | null) => { m.f32(1).u32(0).u32(0).u32(0); for (let k = 0; k < 4; k++) m.u32(data === null ? 0 : data + k * 4); };
    rec(96); rec(null); rec(48);
    for (const rot of [[0, 0, 0, 1], [0, 0, S, S]]) for (const v of rot) m.u8(1).u8(1).i16(Math.round(v * 32767));
    m.pad(1300 - m.b.length).str('test\0');
    const buf = m.u.slice().buffer, src = vtmbBones(buf), list = vtmbAnimList(buf);
    expect(src.map((b) => b.flags)).toEqual([0, 0, 2]);
    expect(list).toHaveLength(1);
    const mot = decodeVtmbAnim(buf, list[0]!, src, new Map(src.map((b, i) => [b.name, i] as const)));
    const q0 = mot.chan.get(0)!.rot![0]![1], q2 = mot.chan.get(2)!.rot![0]![1];
    // [w, x, y, z]
    expect(q0[0]).toBeCloseTo(S, 3); expect(q0[3]).toBeCloseTo(-S, 3);
    expect(Math.abs(q2[0]!)).toBeCloseTo(1, 3);
    expect(mot.chan.has(1)).toBe(false);
  });

  it('поза персонажа на карте: idle NPC важнее анимаций игрока, заданная сущностью — важнее всего', () => {
    const mk = (name: string, source?: string) => ({ kind: 'node' as const, name, tps: 30, chan: new Map(), duration: 1, frames: 30, ...(source ? { source } : {}) });
    const list = [mk('ragdoll'), mk('idle01', 'pc_idles'), mk('idle01 (misc)', 'misc'), mk('cower_idle', 'misc')];
    expect(pickIdle(list)?.name).toBe('idle01 (misc)');
    expect(pickIdle(list, 'cower_idle')?.name).toBe('cower_idle');
    expect(pickIdle(list, 'None')?.name).toBe('idle01 (misc)');
    expect(pickIdle([mk('ragdoll')])?.name).toBe('ragdoll');
  });

  it('слои: частичная анимация поверх стойки (fill) и дельта (add)', () => {
    const S = Math.SQRT1_2, rest = [{ t: [0, 0, 0], q: [1, 0, 0, 0] }, { t: [1, 0, 0], q: [1, 0, 0, 0] }];
    const mot = (chan: Array<[number, { pos: Array<[number, number[]]> | null; rot: Array<[number, number[]]> | null }]>) =>
      ({ kind: 'node' as const, name: 'm', tps: 30, duration: 1 / 30, frames: 2, chan: new Map(chan.map(([i, c]) => [i, { ...c, scl: null }])) });
    const base = mot([[0, { pos: null, rot: [[0, [S, 0, 0, S]], [1, [S, 0, 0, S]]] }], [1, { pos: [[0, [2, 0, 0]], [1, [2, 0, 0]]], rot: null }]]);
    const layer = mot([[1, { pos: null, rot: [[0, [0, 1, 0, 0]], [1, [0, 1, 0, 0]]] }]]);
    const f = vtmbCompose(base, layer, 'fill', rest);
    expect(f.chan.get(0)).toBe(base.chan.get(0));
    expect(f.chan.get(1)).toBe(layer.chan.get(1));
    const delta = mot([[0, { pos: [[0, [0, 0, 1]], [1, [0, 0, 1]]], rot: [[0, [S, 0, 0, S]], [1, [S, 0, 0, S]]] }]]);
    const a = vtmbCompose(base, delta, 'add', rest);
    const q = a.chan.get(0)!.rot![0]![1], t = a.chan.get(0)!.pos![0]![1];
    // 90° + 90° по Z = 180°; позиция — покой + дельта
    expect(Math.abs(q[3]!)).toBeCloseTo(1, 5); expect(t).toEqual([0, 0, 1]);
    expect(a.chan.get(1)).toBe(base.chan.get(1));
  });

  it('смешивание анимаций по сетке (последовательности): общая фаза, линейно между соседями', () => {
    const sk = new NodeSkeleton([{ name: 'root', parent: -1, local: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], offset: null }]);
    const mo = (x: number, frames: number) => ({ kind: 'node' as const, name: 'a' + x, tps: 30, frames, duration: (frames - 1) / 30,
      chan: new Map([[0, { pos: [[0, [x, 0, 0]], [frames - 1, [x, 10, 0]]] as Array<[number, number[]]>, rot: null, scl: null }]]) });
    const a = mo(0, 11), b = mo(2, 21);
    const blended = { ...a, blend: { motions: [a, b], cols: 2, rows: 1, x: 0.5, y: 0 } };
    sk.pose(blended, a.duration / 2, true);
    // середина цикла у обеих: y = 5; x — среднее
    expect(sk.world[12]).toBeCloseTo(1, 5); expect(sk.world[13]).toBeCloseTo(5, 5);
  });

  it('последовательность v2531: сетка анимаций и параметр позы', () => {
    const m = new B().str('IDST').u32(2531);
    m.pad(272 - m.b.length).u32(1).u32(512);
    m.pad(384 - m.b.length).u32(1).u32(1400);
    m.pad(512 - m.b.length).u32(1300 - 512);
    m.pad(512 + 56 - m.b.length);
    for (let i = 0; i < 3; i++) { m.u32(10 + i); m.pad(28); }
    m.pad(512 + 572 - m.b.length).u32(3).u32(1).u32(0).u32(-1).f32(-180).f32(0).f32(180).f32(0);
    m.pad(1300 - m.b.length).str('walk\0');
    m.pad(1400 - m.b.length).u32(20).u32(1).f32(-180).f32(180).f32(360).str('move_yaw\0');
    const list = vtmbSeqList(m.u.slice().buffer);
    expect(list).toEqual([{ name: 'walk', cols: 3, rows: 1, anims: [10, 11, 12], params: [{ name: 'move_yaw', start: -180, end: 180 }] }]);
  });
});
