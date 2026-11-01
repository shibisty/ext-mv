import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { binary, buildDiagnostics, decodeDDS, decodePCX, decodeTGA, geometry, hexDump, inflateRaw, inflateZlib, lz4Frame, math } from '../src/index';
import { lz4MatchFrame, lz4RawFrame, makeDdsArgb, makeDdsDxt1, makePcx, makeTga } from './helpers/fixtures';
import { file } from './helpers/bin';

describe('binary', () => {
  it('half -> float', () => {
    expect(binary.half(0x3c00)).toBe(1);
    expect(binary.half(0xc000)).toBe(-2);
    expect(binary.half(0x3800)).toBe(0.5);
    expect(binary.half(0x7c00)).toBe(Infinity);
    expect(binary.half(0)).toBe(0);
  });
  it('строки, расширения, пути', () => {
    const u8 = new TextEncoder().encode('abc\0def');
    expect(binary.cstr(u8, 0, 10)).toBe('abc');
    expect(binary.extOf('A/B/model.OGF')).toBe('ogf');
    expect(binary.extOf('noext')).toBe('');
    expect(binary.normPath('Meshes\\Armor\\X.NIF')).toBe('meshes/armor/x.nif');
    expect(binary.stripExt('a/b.c/d.dds')).toBe('a/b.c/d');
    expect(binary.fourCC('cast')).toBe(0x74736163);
    expect(binary.hasMagic(new TextEncoder().encode('IDP2xx'), 'IDP2')).toBe(true);
  });
});

describe('math', () => {
  it('quatMat · rigidInv = I', () => {
    const s = Math.SQRT1_2, M = math.quatMat([s, 0, s, 0], [1, 2, 3]), I = math.mulCol(M, math.rigidInv(M));
    for (let i = 0; i < 16; i++) expect(I[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 6);
  });
  it('matToTRS обратна compose (с отражением)', () => {
    const q = [Math.cos(0.3), 0, Math.sin(0.3), 0], M = math.quatMat(q, [5, -1, 2], [-2, 3, 4]), r = math.matToTRS(M), M2 = math.quatMat(r.q, r.t, r.s);
    for (let i = 0; i < 16; i++) expect(M2[i]).toBeCloseTo(M[i]!, 5);
  });
  it('интерполяция ключей', () => {
    const keys: Array<[number, number[]]> = [[0, [0, 0, 0]], [10, [10, 0, 0]]];
    expect(math.sampleVec(keys, 5)).toEqual([5, 0, 0]);
    expect(math.sampleVec(keys, -1)).toEqual([0, 0, 0]);
    expect(math.sampleVec(keys, 99)).toEqual([10, 0, 0]);
    const q = math.sampleQuat([[0, [1, 0, 0, 0]], [1, [-1, 0, 0, 0]]], 0.5); // кратчайшая дуга: тот же поворот
    expect(Math.abs(q[0]!)).toBeCloseTo(1);
  });
});

describe('geometry', () => {
  it('нормали треугольника', () => {
    const n = geometry.computeNormals([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(Array.from(n)).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });
  it('strip -> треугольники с чередованием и без вырожденных', () => {
    expect(geometry.stripToTris([0, 1, 2, 3, 3, 4])).toEqual([0, 1, 2, 1, 3, 2]);
  });
  it('индексы нужной ширины', () => {
    expect(geometry.makeIndices(10, [0, 1, 2])).toBeInstanceOf(Uint16Array);
    expect(geometry.makeIndices(70000, [0, 1, 2])).toBeInstanceOf(Uint32Array);
  });
  it('границы', () => {
    expect(geometry.boundsOf([{ pos: [1, 2, 3, -1, 5, 0] }])).toEqual({ min: [-1, 2, 0], max: [1, 5, 3] });
  });
});

describe('кодеки', () => {
  it('zlib и raw deflate', async () => {
    const data = new TextEncoder().encode('hello hello hello hello');
    expect(new TextDecoder().decode(await inflateZlib(new Uint8Array(deflateSync(data))))).toBe('hello hello hello hello');
    expect(new TextDecoder().decode(await inflateRaw(new Uint8Array(deflateRawSync(data))))).toBe('hello hello hello hello');
  });
  it('LZ4 frame: несжатый и сжатый блоки', () => {
    const raw = new TextEncoder().encode('raw block');
    expect(new TextDecoder().decode(lz4Frame(lz4RawFrame(raw), raw.length))).toBe('raw block');
    expect(new TextDecoder().decode(lz4Frame(lz4MatchFrame(), 13))).toBe('abcdabcdabcdx');
  });
  it('LZ4: ошибка на неверной сигнатуре', () => {
    expect(() => lz4Frame(new Uint8Array(16), 4)).toThrow(/сигнатуры/);
  });
});

describe('картинки', () => {
  it('DDS DXT1', () => {
    const img = decodeDDS(makeDdsDxt1(4, 4));
    expect([img.width, img.height]).toEqual([4, 4]);
    expect(Array.from(img.rgba!.subarray(0, 4))).toEqual([255, 0, 0, 255]);
  });
  it('DDS DXT1 не кратный 4', () => {
    const img = decodeDDS(makeDdsDxt1(5, 3));
    expect(img.rgba!.length).toBe(5 * 3 * 4);
  });
  it('DDS A8R8G8B8 по маскам', () => {
    const img = decodeDDS(makeDdsArgb(2, 1, 0x80112233));
    expect(Array.from(img.rgba!.subarray(0, 4))).toEqual([0x11, 0x22, 0x33, 0x80]);
  });
  it('DDS: не DDS', () => { expect(() => decodeDDS(new ArrayBuffer(200))).toThrow(/Не DDS/); });
  it.each([false, true])('TGA (rle=%s), ориентация снизу вверх', (rle) => {
    const img = decodeTGA(makeTga(rle));
    expect(Array.from(img.rgba!.subarray(0, 4))).toEqual([0, 0, 255, 255]); // верхний ряд — синий
    expect(Array.from(img.rgba!.subarray(8, 12))).toEqual([255, 0, 0, 255]);
  });
  it('PCX 8 бит с палитрой', () => {
    const img = decodePCX(makePcx());
    expect([img.width, img.height]).toEqual([2, 1]);
    expect(Array.from(img.rgba!)).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
  });
});

describe('диагностика', () => {
  it('hex-дамп и текст отчёта', async () => {
    expect(hexDump(new TextEncoder().encode('IDP2'))).toBe('0000  49 44 50 32                                      IDP2');
    const text = await buildDiagnostics({ file: file(new TextEncoder().encode('BADMAGIC'), 'x.ogf'), format: 'xray-ogf', error: 'boom', appVersion: '12.0.0' });
    expect(text).toContain('Формат: xray-ogf');
    expect(text).toContain('Сигнатура: BADM');
    expect(text).toContain('(8 байт)');
  });
});

describe('варианты имени текстуры', () => {
  it('абсолютные пути художника, Data\\ и ./', async () => {
    const { TextureLibrary } = await import('../src/core/textures');
    expect(TextureLibrary.candidates('P:/Doom/base/textures/base_trim/sfltrim2.TGA')).toEqual(
      ['doom/base/textures/base_trim/sfltrim2', 'base/textures/base_trim/sfltrim2', 'textures/base_trim/sfltrim2', 'base_trim/sfltrim2', 'sfltrim2']);
    expect(TextureLibrary.candidates('Data\\Textures\\LOD\\a.dds')[0]).toBe('textures/lod/a');
    expect(TextureLibrary.candidates('./models/x.png')[0]).toBe('models/x');
  });
});
