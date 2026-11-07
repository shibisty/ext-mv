// EA Black Box (Need for Speed: World): JDLZ, EA HUFF (повторы, литералы, конец), блоки 0x55441122, GEOMETRY.bin машины,
// TPK со сжатыми записями, правила видимости деталей.
import { describe, expect, it } from 'vitest';
import { eaHuff } from '../src/core/codecs/eahuff';
import { jdlz } from '../src/core/codecs/jdlz';
import { bbBlocks, binHash, decodeBbTexture, readTpks } from '../src/engines/ea/blackbox';
import { loadNfsCar, nfsPartVisible, parseNfsGeometry } from '../src/engines/ea/nfsgeom';
import { block, cat, huffBlock, huffEncode, jdlzSample, nfsGeometry, nfsObject, nfsTpk } from './helpers/blackbox';

const text = (u: Uint8Array) => new TextDecoder().decode(u);

describe('EA Black Box: сжатие', () => {
  it('JDLZ: литералы и ссылка назад', () => {
    expect(text(jdlz(jdlzSample()))).toBe('abcabcabc');
  });
  it('EA HUFF 0x30FB: каноничные коды, «прыжки» по символам, повтор через clue', () => {
    const data = new TextEncoder().encode('abcccccabba');
    expect(text(eaHuff(huffEncode(data, 0x7a)))).toBe('abcccccabba');
  });
  it('блоки 0x55441122: JDLZ, HUFF и несжатый блок в один буфер по смещениям вывода', () => {
    const tail = new TextEncoder().encode('XYZ');
    const u = cat(block(jdlzSample(), 9, 0), huffBlock(new TextEncoder().encode('aabbbbc'), 0x7a, 9), block(tail, 3, 16));
    expect(text(bbBlocks(u, 0, u.length, 19))).toBe('abcabcabcaabbbbcXYZ');
  });
  it('хеш имён: h·33 + c от 0xFFFFFFFF', () => {
    expect(binHash('BLACK')).toBe(0x027ff2dc);
  });
});

describe('Need for Speed: World — машина', () => {
  const tex = 0x1234abcd;
  const geo = nfsGeometry([{ hash: 1, data: nfsObject('CAR_BASE_A', tex), packed: true }, { hash: 2, data: nfsObject('CAR_KIT01_SKIRT_A', 0xe1c9231e) }, { hash: 3, data: nfsObject('CAR_BASE_B', tex) }]);
  it('объекты из таблицы 0x134004: имя, подмеш, вершины s16/4096, нормали', () => {
    const { parts, total } = parseNfsGeometry(geo);
    expect(total).toBe(3);
    expect(parts.map((p) => p.name)).toEqual(['CAR_BASE_A', 'CAR_KIT01_SKIRT_A', 'CAR_BASE_B']);
    const s = parts[0]!.subs[0]!;
    expect(s.texture).toBe(tex);
    expect(Array.from(s.pos)).toEqual([0, 0, 0, 1, 0, 0, 0, 0.5, 0.25]);
    expect(Array.from(s.uv)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(Array.from(s.indices)).toEqual([0, 1, 2]);
    expect(Array.from(s.nor.subarray(0, 3))).toEqual([0, 0, 1]);
  });
  it('TPK: сжатая запись (HUFF) с TextureInfo в конце → DXT1', () => {
    const px = new Uint8Array([0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0]); // 4×4 DXT1, весь блок красный
    const t = readTpks(nfsTpk(tex, 'CAR_SKIN1', 4, 4, 'DXT1', px, true)).get(tex)!;
    expect([t.name, t.width, t.height, t.pack]).toEqual(['CAR_SKIN1', 4, 4, 'CARTEMPLATETEXTURES_TEST']);
    const img = decodeBbTexture(t);
    expect(Array.from(img.rgba!.subarray(0, 4))).toEqual([255, 0, 0, 255]);
  });
  it('загрузка: LOD A, текстура из TEXTURES.BIN рядом, окраска кузова — цветом, обвесы скрыты', async () => {
    const px = new Uint8Array([0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0]), tpk = nfsTpk(tex, 'CAR_SKIN1', 4, 4, 'DXT1', px);
    const main = { name: 'GEOMETRY.bin', path: 'cars/car/geometry.bin', arrayBuffer: async () => geo.slice().buffer };
    const ctx = { files: [], archives: [], sibling: async (n: string) => (n.toUpperCase() === 'TEXTURES.BIN' ? tpk.slice().buffer : null), readPath: async () => null };
    const m = await loadNfsCar(main, ctx);
    expect(m.meshes.map((x) => x.name)).toEqual(['CAR_BASE_A · CAR_SKIN1', 'CAR_KIT01_SKIRT_A · окраска кузова (создаётся игрой)']);
    expect(m.meshes[0]!.image?.width).toBe(4);
    expect(m.meshes[0]!.defaultHidden).toBeUndefined();
    expect(m.meshes[1]!.color).toBeDefined();
    expect(m.meshes[1]!.defaultHidden).toBe(true);
  });
  it('видимость деталей по имени', () => {
    expect(['350Z_BASE_A', '350Z_KIT00_BODY_A', '350Z_KIT00_LEFT_BRAKELIGHT_A', '350Z_KIT00_HOOD_A'].every(nfsPartVisible)).toBe(true);
    expect(['350Z_KIT01_SKIRT_A', '350Z_KITW02_BODY_A', '350Z_STYLE05_HOOD_A', '350Z_KIT00_FRONT_TIRE_A', '350Z_KIT00_REAR_BRAKE_A', '350Z_KIT00_DRIVER_FEMALE_A', '350Z_KITW02_DAMAGE0_FRONT_B'].some(nfsPartVisible)).toBe(false);
  });
});
