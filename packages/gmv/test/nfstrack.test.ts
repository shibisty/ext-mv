// NFS World: трасса (секции STREAML5RA_*.BUN — объекты с float-вершинами, группы расстановки 0x80034100, «развёрнутые»
// экземпляры DEINST), список текстур объекта, колёса машины по аркам кузова.
import { describe, expect, it } from 'vitest';
import { parseObject, placeWheels, plateQuad } from '../src/engines/ea/nfsgeom';
import { decodeBbTexture, stpTexture } from '../src/engines/ea/blackbox';
import { loadNfsTrack, scanTrack } from '../src/engines/ea/nfstrack';
import type { Mesh } from '../src/core/types';
import { B, block, cat, chunk, nfsTpk } from './helpers/blackbox';
import { composeSkin, isFlat, parseVinyl } from '../src/engines/ea/nfscustom';

/** Объект трассы: заголовок (хеш @16, имя @0xA0), список текстур, треугольник с float-вершинами шага 36. */
function trackObject(hash: number, name: string, texList: number[], pts: number[][], deinst?: { mats: number[][]; ranges: number[][] }): Uint8Array {
  const hdr = new B().pad(16).u32(hash).pad(0xa0 - 20).str(name).u8(0);
  while (hdr.b.length % 4) hdr.u8(0);
  const sub = new B().u32(0).u32(0xdeadbeef).u32(2).u32(0);
  for (let k = 0; k < 6; k++) sub.f32(0);
  sub.pad(40 - sub.b.length).u8(texList.length - 1).pad(64 - 41).u32(pts.length).u32(3).u32(1).u32(0);
  sub.pad(116 - sub.b.length);
  const idx = new B().u16(0).u16(1).u16(2).u16(0);
  const vb = new B();
  for (const p of pts) { vb.f32(p[0]!).f32(p[1]!).f32(p[2]!).i16(0).i16(0).i16(32767).i16(32767).f32(p[0]!).f32(p[1]!).u32(0xff808080).u32(0xff000000); }
  const parts = [chunk(0x134b02, sub.u), chunk(0x134b03, idx.u)];
  if (deinst) {
    const m = new B(); for (const r of deinst.mats) for (const v of r) m.f32(v);
    const r = new B(); for (const [a, b, k] of deinst.ranges) r.u32(a!).u32(b!).u32(k!).u32(0);
    parts.push(chunk(0x134c06, m.u), chunk(0x134c05, r.u));
  }
  parts.push(chunk(0x134b01, vb.u));
  const tl = new B(); for (const t of texList) tl.u32(t).u32(0);
  return chunk(0x80134010, cat(chunk(0x134011, hdr.u), chunk(0x134012, tl.u), chunk(0x80134100, cat(...parts))));
}

/** Группа расстановки: SceneryInfo (имя, хеши 3 LOD) и экземпляры (габариты, позиция, поворот по строкам, номер info). */
function scenery(infos: Array<{ name: string; solid: number }>, insts: Array<{ info: number; pos: number[]; rot: number[] }>): Uint8Array {
  const ib = new B();
  for (const i of infos) { ib.str(i.name).pad(24 - i.name.length).u32(i.solid).u32(i.solid).u32(i.solid).pad(20).f32(1).pad(12); }
  const nb = new B();
  for (const n of insts) {
    nb.f32(n.pos[0]! - 1).f32(n.pos[1]! - 1).f32(n.pos[2]! - 1).u32(0).f32(n.pos[0]! + 1).f32(n.pos[1]! + 1).f32(n.pos[2]! + 1).u16(0).u16(0xffff);
    for (const v of n.pos) nb.f32(v);
    for (const v of n.rot) nb.f32(v);
    nb.u32(0x1234).u32(n.info).u32(8).u32(0);
  }
  return chunk(0x80034100, cat(chunk(0x34101, new B().pad(84).u), chunk(0x34103, nb.u), chunk(0x34102, ib.u)));
}

const TRI = [[0, 0, 0], [1, 0, 0], [0, 2, 0]];
const ROT90 = [0, 1, 0, -1, 0, 0, 0, 0, 1]; // локальная X → мировая Y

function section(): Uint8Array {
  const list = chunk(0x80134000, cat(
    trackObject(0xa1, 'TRN_ROAD_CHOP', [0x7e1], [[100, 200, 5], [101, 200, 5], [100, 202, 5]]),
    trackObject(0xb2, 'XO_POST', [0x7e2, 0x7e3], TRI),
    trackObject(0xc3, 'XT_BUSH_DEINST1', [0x7e4], TRI, { mats: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 50, 60, 1, 1]], ranges: [[0, 2, 0]] }),
  ));
  const grp = scenery(
    [{ name: 'TRN_Road_CHOP_F7', solid: 0xa1 }, { name: 'XO_Post_1b_00', solid: 0xb2 }, { name: 'XT_Bush_DEINST1', solid: 0xc3 }, { name: 'SHADOW_Road', solid: 0xa1 }],
    [{ info: 0, pos: [0, 0, 0], rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, { info: 1, pos: [10, 20, 3], rot: ROT90 }, { info: 2, pos: [0, 0, 0], rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, { info: 3, pos: [0, 0, 0], rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
  );
  return cat(list, grp);
}

describe('NFS World: трасса', () => {
  it('секция: объекты по хешу, SceneryInfo и экземпляры', () => {
    const sc = scanTrack(section());
    expect([...sc.objects.keys()]).toEqual([0xa1, 0xb2, 0xc3]);
    expect(sc.objects.get(0xb2)!.name).toBe('XO_POST');
    const g = sc.groups[0]!;
    expect(g.infos.map((i) => i.name)).toEqual(['TRN_Road_CHOP_F7', 'XO_Post_1b_00', 'XT_Bush_DEINST1', 'SHADOW_Road']);
    expect(g.insts[1]!.info).toBe(1);
    expect(Array.from(g.insts[1]!.m.subarray(9))).toEqual([10, 20, 3]);
  });
  it('объект: float-вершины шага 36 с нормалью s16 @12, текстура — из списка объекта по номеру @40', () => {
    const o = scanTrack(section()).objects.get(0xb2)!;
    const p = parseObject(o.data, 0xb2, o.name), s = p.subs[0]!;
    expect(s.texture).toBe(0x7e3);
    expect(s.key).toBe(0xdeadbeef);
    expect(Array.from(s.pos)).toEqual([0, 0, 0, 1, 0, 0, 0, 2, 0]);
    expect(Array.from(s.nor.subarray(0, 3))).toEqual([0, 0, 1]);
    // слот 1 (@41) — карта нормалей, цвет вершины @28 — запечённый свет
    expect(s.normal).toBe(0x7e2);
    expect(Array.from(s.shade!.subarray(0, 4))).toEqual([0x80, 0x80, 0x80, 0xff]);
  });
  it('DEINST: вершины копии переносятся её матрицей (0x134c06 + диапазоны 0x134c05)', () => {
    const o = scanTrack(section()).objects.get(0xc3)!;
    expect(Array.from(parseObject(o.data, 0xc3, o.name).subs[0]!.pos)).toEqual([50, 60, 1, 51, 60, 1, 50, 62, 1]);
  });
  it('загрузка секции: мировая нарезка как есть, экземпляр — поворот по строкам и перенос, тени скрыты', async () => {
    const u = section();
    const main = { name: 'STREAML5RA_5407.BUN', arrayBuffer: async () => u.slice().buffer };
    const m = await loadNfsTrack(main, { files: [], archives: [], sibling: async () => null, readPath: async () => null });
    const byTex = new Map(m.meshes.map((x) => [x.name, x]));
    expect(Array.from(byTex.get('0x000007e1')!.pos)).toEqual([100, 200, 5, 101, 200, 5, 100, 202, 5]);
    // (1,0,0) → строка 0 (0,1,0) + перенос (10,20,3); (0,2,0) → 2·строка 1 (−1,0,0)
    expect(Array.from(byTex.get('0x000007e3')!.pos)).toEqual([10, 20, 3, 10, 21, 3, 8, 20, 3]);
    expect(Array.from(byTex.get('0x000007e4')!.pos)).toEqual([50, 60, 1, 51, 60, 1, 50, 62, 1]);
    expect(m.meshes).toHaveLength(3);
    expect(m.info.join('\n')).toMatch(/SHADOW_\*\): 1/);
  });
});

describe('NFS World: колёса по аркам', () => {
  const mesh = (name: string, pts: number[][]): Mesh => ({ name, texture: '', vertexCount: pts.length, pos: Float32Array.from(pts.flat()), nor: new Float32Array(pts.length * 3), uv: new Float32Array(pts.length * 2), bone: new Float32Array(0), weight: new Float32Array(0), indices: new Uint16Array([0, 1, 2]), skinned: false });
  it('арки — участки боковины с поднятым низом; шина и диск ставятся на 4 места', () => {
    const side: number[][] = [];
    for (let x = -2; x <= 2.001; x += 0.05) {
      const arch = Math.abs(Math.abs(x) - 1.3) < 0.3;
      for (const y of [-0.9, 0.9]) side.push([x, y, arch ? 0.6 : 0.1], [x, y, 0.9]);
    }
    const meshes = [mesh('CAR_KIT00_BODY_A · paint', side), mesh('CAR_KIT00_FRONT_TIRE_A · TIRE', [[-0.3, 0, -0.3], [0.3, 0.2, 0.3], [0, 0.1, 0]]), mesh('CAR_KIT00_FRONT_BRAKE_A · ROTOR', [[-0.15, 0, -0.15], [0.15, 0.05, 0.15], [0, 0, 0]])];
    meshes[1]!.defaultHidden = meshes[2]!.defaultHidden = true;
    const w = placeWheels(meshes)!;
    expect(w.front).toBeCloseTo(1.3, 1);
    expect(w.rear).toBeCloseTo(-1.3, 1);
    expect(w.half).toBeCloseTo(0.8, 5);
    const placed = meshes.filter((m) => m.name.startsWith('колесо'));
    expect(placed).toHaveLength(6); // 4 шины (задней нет — берётся передняя) и 2 передних диска
    const fl = placed.find((m) => m.name.startsWith('колесо переднее левое') && /TIRE/.test(m.name))!;
    // наружная сторона шины — у y = 0: слева разворот на 180°, она оказывается на half + width/2; высота — верх арки − радиус − 0.01
    expect(fl.pos[1]).toBeCloseTo(0.9, 5);
    expect(fl.pos[2]).toBeCloseTo(-0.3 + 0.6 - 0.3 - 0.01, 2);
  });
});

describe('NFS World: номер и внешние записи TPK', () => {
  it('.stp: блоки с начала файла — данные и TextureInfo в конце', () => {
    const px = new Uint8Array([0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0]);
    const info = new B().pad(12).u32(0xa9aa415f).pad(8).u32(8).u32(0).u32(4).u32(4);
    info.pad(144 - info.b.length).u8(19).str('LICENSEPLATE_WORLD').u8(0).pad(192 - 164).str('DXT1').pad(16);
    const stp = cat(block(px, 8, 0), block(info.u, 212, 8));
    const t = stpTexture({ hash: 0xa9aa415f, off: 0, csize: stp.length, usize: 220, infoSize: 212, pack: 'LICENSEPLATES' }, stp);
    expect([t.name, t.width, t.height]).toEqual(['LICENSEPLATE_WORLD', 4, 4]);
    expect(Array.from(decodeBbTexture(t).rgba!.subarray(0, 4))).toEqual([255, 0, 0, 255]);
  });
  it('номер 30×15 см в плоскости маркера: строка 1 — ширина, строка 0 — высота, сдвиг по нормали', () => {
    // маркер REAR_LICENSE_PLATE: нормаль назад (−X), высота — Z, ширина — Y; центр (−2, 0, 0.5)
    const m = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, -2, 0, 0.5, 1]);
    const q = plateQuad(m, { width: 2, height: 1, rgba: new Uint8Array(8) }, 'номер');
    expect(Array.from(q.pos.subarray(0, 3)).map((v) => +v.toFixed(3))).toEqual([-2.003, 0.15, 0.575]);
    expect(Array.from(q.pos.subarray(6, 9)).map((v) => +v.toFixed(3))).toEqual([-2.003, -0.15, 0.425]);
    expect(Array.from(q.nor.subarray(0, 3))).toEqual([-1, 0, 0]);
  });
});

describe('NFS World: окраска и винилы', () => {
  /** .vyl: заголовок 0x3ce01 (1 слой), слой 0x3ce02 (цвет @64, хеш маски @204, порог @208) и TPK с маской L8 4×4. */
  function vyl(mask: number[]): Uint8Array {
    const head = new B().u32(0).u32(0).u32(1).u32(0).u32(0x2c7617).f32(1).pad(20);
    const layer = new B().pad(64).u32(0xff0000ff).pad(204 - 68).u32(0x51).u32(0x80).pad(8);
    // TPK первым: смещения сжатых записей помощник считает от начала файла
    return cat(nfsTpk(0x51, 'SDM_TEST_0', 4, 4, 'L8\0\0', Uint8Array.from(mask)), chunk(0x8003ce00, cat(chunk(0x3ce01, head.u), chunk(0x3ce02, layer.u))));
  }
  it('.vyl: слои — маска поля расстояний и цвет ARGB', () => {
    const v = parseVinyl(vyl(new Array(16).fill(0)))!;
    expect(v.hash).toBe(0x2c7617);
    expect(v.layers).toHaveLength(1);
    expect(v.layers[0]!.color).toEqual([0, 0, 1]);
    expect(v.layers[0]!.threshold).toBe(0x80);
  });
  it('кожа: цвет окраски, винил на капоте — внутри фигуры (ниже порога) цвет слоя', () => {
    const v = parseVinyl(vyl(new Array(16).fill(0)))!; // вся маска «внутри»
    const img = composeSkin(64, [1, 0, 0], v, 'hood');
    const px = (u: number, w: number) => Array.from(img.rgba!.subarray(((w * 64 + u) | 0) * 4, ((w * 64 + u) | 0) * 4 + 3));
    expect(px(2, 2)).toEqual([255, 0, 0]); // вне места винила — окраска
    expect(px(32, 14)).toEqual([0, 0, 255]); // середина капота — слой винила
    expect(isFlat(composeSkin(16, [0.5, 0.5, 0.5], null))).toBe(true);
  });
});
