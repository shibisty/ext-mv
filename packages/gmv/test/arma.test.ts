import { describe, expect, it } from 'vitest';
import { createRegistry, ViewerSession } from '../src/index';
import { allEngines } from '../src/engines/index';
import { lzo1xDecompress } from '../src/core/codecs/lzo';
import { lzssDecompress } from '../src/engines/arma/lzss';
import { parsePboHeader } from '../src/engines/arma/pbo';
import { decodePaa } from '../src/engines/arma/paa';
import { mergeRap, parseRap, rapGet } from '../src/engines/arma/rap';
import { parseOdol, lodKind } from '../src/engines/arma/odol';
import { file } from './helpers/bin';
import { LZO_SAMPLE_B64, lzoSampleInput, lzssLiterals, makeOdol, makePaaArgb, makePaaDxt1, makePbo, rapify, type OdolIn } from './helpers/arma';

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toAB = (u8: Uint8Array) => u8.slice().buffer;

describe('сжатие', () => {
  it('LZO1X: поток liblzo2 распаковывается байт в байт, позиция — за маркером конца', () => {
    const packed = b64(LZO_SAMPLE_B64), src = new Uint8Array(packed.length + 5);
    src.set(packed, 2);
    const want = lzoSampleInput(), out = new Uint8Array(want.length);
    expect(lzo1xDecompress(src, 2, out)).toBe(2 + packed.length);
    expect(out).toEqual(want);
  });
  it('LZO1X: повреждённый поток — ошибка, а не зависание', () => {
    const bad = b64(LZO_SAMPLE_B64).slice(0, 300);
    expect(() => lzo1xDecompress(bad, 0, new Uint8Array(5900))).toThrow(/LZO/);
  });
  it('LZSS BI: литералы и ссылка назад в окно с пробелами', () => {
    const lit = lzssLiterals(enc('ABCDEFGH'));
    expect(new TextDecoder().decode(lzssDecompress(lit, 0, 8).data)).toBe('ABCDEFGH');
    // флаг 0b00000011: 2 литерала «AB», затем ссылка на 2 байта назад длиной 3 -> «ABABA»
    const ref = Uint8Array.from([0x03, 65, 66, 2, 0x00]);
    const sum = 65 + 66 + 65 + 66 + 65;
    const src = new Uint8Array([...ref, sum & 255, sum >> 8, 0, 0]);
    expect(new TextDecoder().decode(lzssDecompress(src, 0, 5).data)).toBe('ABABA');
  });
});

describe('rapified-конфиг', () => {
  const cfg = rapify({
    CfgPatches: { test: { units: ['a'] } },
    CfgWeapons: {
      Base_F: { hiddenSelections: ['camo'], scope: 0 },
      Gun: { __base: 'Base_F', body: { model: '\\test\\gun.p3d', displayName: 'Ружьё', hiddenSelectionsTextures: ['\\test\\gun_co.paa'], scope: 2 } },
    },
  });
  it('классы, значения, массивы и наследование', () => {
    const root = parseRap(cfg), gun = root.classes.get('cfgweapons')!.classes.get('gun')!;
    expect(gun.base).toBe('Base_F');
    expect(rapGet(gun, 'displayname')).toBe('Ружьё');
    expect(rapGet(gun, 'hiddenSelections')).toEqual(['camo']);
    expect(rapGet(gun, 'scope')).toBe(2);
  });
  it('слияние конфигов разных PBO: базовый класс из другого файла', () => {
    const a = parseRap(rapify({ CfgWeapons: { Base_F: { hiddenSelections: ['camo1'] } } }));
    const b = parseRap(rapify({ CfgWeapons: { Gun: { __base: 'Base_F', body: { model: 'x' } } } }));
    const root = mergeRap([a, b]), gun = root.classes.get('cfgweapons')!.classes.get('gun')!;
    expect(rapGet(gun, 'hiddenselections', root)).toEqual(['camo1']);
  });
});

describe('PBO и PAA', () => {
  it('заголовок PBO: свойства и записи', () => {
    const h = parsePboHeader(makePbo('Mod\\Sub', { 'a.txt': enc('hi'), 'b\\c.paa': new Uint8Array(3) }))!;
    expect(h.props.prefix).toBe('Mod\\Sub');
    expect(h.entries.map((e) => e.name)).toEqual(['a.txt', 'b\\c.paa']);
    expect(parsePboHeader(makePbo('x', { 'a.txt': enc('hi') }).slice(0, 20))).toBeNull();
  });
  it('PAA DXT1 и ARGB8888 (LZSS)', () => {
    const d = decodePaa(toAB(makePaaDxt1()));
    expect([d.width, d.height]).toEqual([4, 4]);
    expect(Array.from(d.rgba!.slice(0, 4))).toEqual([255, 0, 0, 255]);
    const a = decodePaa(toAB(makePaaArgb()));
    expect(Array.from(a.rgba!)).toEqual([255, 0, 0, 255, 0, 255, 0, 128]);
  });
});

const GUN: OdolIn = {
  boundingCenter: [0, 0.5, 0],
  pos: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], [5, 5, 5], [6, 5, 5], [5, 6, 5]],
  uv: [[0, 0], [0.5, 0], [0, 0.5], [0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5], [0, 0], [0, 0], [0, 0]],
  sections: [
    { texture: 'test\\body_co.paa', faces: [[0, 1, 2]] },
    { texture: '', faces: [[3, 4, 5, 6]], selection: 'camo' },
    { texture: '', faces: [[7, 8, 9]] }, // треугольник прокси
  ],
  proxies: [{ model: '\\a3\\data_f\\proxies\\weapon_slots\\top', pos: [0, 2, 0], section: 2 }],
};

describe('ODOL', () => {
  it('LOD, секции, четырёхугольники, прокси, скелет', () => {
    const o = parseOdol(makeOdol(GUN));
    expect(o.version).toBe(73);
    expect(o.resolutions).toEqual([1, Math.fround(1e15)]);
    expect(lodKind(o.resolutions[1]!)).toBe('память');
    expect(o.skeleton?.name).toBe('TestSkeleton');
    const l = o.lod(0);
    expect(l.faces.map((f) => f.length)).toEqual([3, 4, 3]);
    expect(l.sections.map((s) => [s.faceLo, s.faceHi])).toEqual([[0, 16], [16, 36], [36, 52]]);
    expect(l.proxies[0]!.model).toMatch(/weapon_slots\\top$/);
    expect(Array.from(l.proxies[0]!.matrix.slice(9))).toEqual([0, 2, 0]);
    expect(l.uv[2]).toBeCloseTo(0.5, 3);
    expect(Array.from(l.nor.slice(0, 3)).map((x) => Math.round(x) + 0)).toEqual([0, 1, 0]);
    expect(o.lod(1).faces).toHaveLength(0);
  });
  it('не ODOL / MLOD — понятные ошибки', () => {
    expect(() => parseOdol(enc('MLOD\x01\0\0\0'))).toThrow(/MLOD/);
    expect(() => parseOdol(enc('XXXXXXXX'))).toThrow(/ODOL/);
  });
});

describe('Arma в сессии', () => {
  const config = rapify({
    CfgWeapons: {
      Gun_Base: { hiddenSelections: ['camo'] },
      Test_Gun: { __base: 'Gun_Base', body: { model: '\\test\\gun.p3d', displayName: 'Test Gun', hiddenSelectionsTextures: ['\\test\\camo_co.paa'],
        WeaponSlotsInfo: { CowsSlot: { linkProxy: '\\a3\\data_f\\proxies\\weapon_slots\\TOP', compatibleItems: ['Test_Optic'] } } } },
      Test_Optic: { model: '\\test\\optic.p3d', scope: 2, ItemInfo: { type: 201 } },
    },
  });
  const OPTIC: OdolIn = { pos: [[0, 0, 0], [0.1, 0, 0], [0, 0.1, 0]], uv: [[0, 0], [0, 0], [0, 0]], sections: [{ texture: 'test\\optic_co.paa', faces: [[0, 1, 2]] }] };
  const pbo = makePbo('test', {
    'config.bin': config, 'gun.p3d': makeOdol(GUN), 'optic.p3d': makeOdol(OPTIC),
    'body_co.paa': makePaaDxt1(), 'camo_co.paa': makePaaDxt1(),
  });
  const open = async () => {
    const s = new ViewerSession(createRegistry(allEngines), 'arma3');
    await s.addArchives([file(pbo, 'test.pbo')]);
    const a = (s as unknown as { archives: Array<{ kind: string; entries: Array<{ path: string }>; fileOf(e: unknown): never }> }).archives[0]!;
    return { s, a };
  };
  it('PBO: префикс в путях и виртуальные классы из config.bin', async () => {
    const { a } = await open();
    expect(a.kind).toBe('pbo');
    const paths = a.entries.map((e) => e.path);
    expect(paths).toContain('test/gun.p3d');
    expect(paths).toContain('test/config/weapons/test_gun.armacfg');
    expect(paths).not.toContain('test/config/weapons/gun_base.armacfg');
  });
  it('P3D: прокси скрыт, камуфляж из конфига, центр модели', async () => {
    const { s, a } = await open();
    const m = (await s.loadModel([a.fileOf(a.entries.find((e) => e.path === 'test/gun.p3d'))]))!;
    expect(m.meshes).toHaveLength(2);
    expect(m.meshes[1]!.name).toBe('camo');
    expect(m.meshes[1]!.texture).toBe('test/camo_co.paa');
    expect(m.meshes[1]!.indices).toHaveLength(6);
    expect(m.meshes[0]!.pos[1]).toBeCloseTo(0.5); // + boundingCenter
    expect(m.flipZ).toBe(true);
    expect((await s.resolveTexture(0)).ok).toBe(true);
    expect((await s.resolveTexture(1)).ok).toBe(true);
  });
  it('класс оружия: совместимый прицел ставится в прокси слота', async () => {
    const { s, a } = await open();
    const m = (await s.loadModel([a.fileOf(a.entries.find((e) => e.path.endsWith('test_gun.armacfg')))]))!;
    expect(m.meshes.map((x) => x.name)).toEqual(['Test_Gun · секция 0', 'Test_Gun · camo', 'Test_Optic · секция 0']);
    const optic = m.meshes[2]!;
    expect(optic.pos[1]).toBeCloseTo(2.5); // прокси (0,2,0) + центр оружия 0.5
    expect(m.info.join('\n')).toMatch(/CowsSlot: Test_Optic \(совместимый\)/);
  });
});
