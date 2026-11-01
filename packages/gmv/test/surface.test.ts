import { describe, expect, it } from 'vitest';
import { createRegistry, ViewerSession } from '../src/index';
import { allEngines } from '../src/engines/index';
import { decodeDDS } from '../src/core/images/dds';
import { composeSurface, surfaceCandidates } from '../src/core/surface';
import { parseMeshCache } from '../src/engines/spintires/mesh';
import { Bin, file } from './helpers/bin';
import { makeDdsArgb, makeMd2 } from './helpers/fixtures';
import { makeMeshCache } from './helpers/spintires';

const img = (w: number, h: number, px: [number, number, number, number]) => ({ width: w, height: h, rgba: Uint8Array.from({ length: w * h * 4 }, (_, i) => px[i % 4]!) });

describe('PBR-поверхность', () => {
  it('сведение каналов: metal/rough, gloss → шероховатость, множители, масштаб', () => {
    const orm = img(2, 2, [200, 100, 255, 255]), smdi = img(4, 4, [255, 90, 230, 255]);
    const a = composeSurface({ ao: { map: 'o', channel: 0 }, roughness: { map: 'o', channel: 1 }, metallic: { map: 'o', channel: 2 }, roughnessFactor: 0.5 }, new Map([['o', orm]]));
    expect(Array.from(a.rgba!.slice(0, 4))).toEqual([200, 50, 255, 128]);
    const b = composeSurface({ specular: { map: 's', channel: 1 }, gloss: { map: 's', channel: 2 } }, new Map([['s', smdi]]));
    expect([b.width, Array.from(b.rgba!.slice(0, 4))]).toEqual([4, [255, 25, 0, 90]]);
    const c = composeSurface({ roughnessFactor: 0.2, metallicFactor: 1 }, new Map());
    expect([c.width, Array.from(c.rgba!)]).toEqual([1, [255, 51, 255, 128]]);
  });
  it('имена упакованных карт по диффузной', () => {
    expect(surfaceCandidates('models/rock_d.dds').map((s) => s.ao?.map ?? s.roughness?.map)).toContain('models/rock_orm');
    expect(surfaceCandidates('\\gun\\gun_co.paa').find((s) => s.specular)?.specular?.map).toBe('/gun/gun_smdi');
  });
  it('DDS 8 бит: яркость (L8, карты блеска MudRunner) и альфа (A8)', () => {
    const l8 = (flags: number) => {
      const b = new Bin().ascii('DDS ').u32(124).u32(0x100f).u32(1).u32(2).u32(2).u32(0).u32(1).zeros(44);
      b.u32(32).u32(flags).u32(0).u32(8).u32(flags === 2 ? 0 : 0xff).u32(0).u32(0).u32(flags === 2 ? 0xff : 0).u32(0x1000).zeros(16).u8(10).u8(200);
      return b.toArrayBuffer();
    };
    expect(Array.from(decodeDDS(l8(0x20000)).rgba!)).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
    expect(Array.from(decodeDDS(l8(0x2)).rgba!)).toEqual([255, 255, 255, 10, 255, 255, 255, 200]);
  });
  it('SnowRunner ShadingMap и MudRunner SpecularMap из XML меша', () => {
    const xml = (attr: string) => `<CombineXMesh>\n<Material MeshParts="body" AlbedoMap="t/a__d.tga" ${attr} Name="m"/>\n</CombineXMesh>`;
    const sn = parseMeshCache(makeMeshCache({ xml: xml('ShadingMap="t/a__sh_d.tga"'), node: 'body', translate: [0, 0, 0], snow: true }).slice().buffer);
    expect(sn.materials[0]!.shading).toBe('t/a__sh_d.tga');
    const mr = parseMeshCache(makeMeshCache({ xml: xml('SpecularMap="t/a__s_d.tga"'), node: 'body', translate: [0, 0, 0] }).slice().buffer);
    expect(mr.materials[0]!.specular).toBe('t/a__s_d.tga');
  });
  it('сессия: упакованная карта _orm рядом с текстурой', async () => {
    const s = new ViewerSession(createRegistry(allEngines));
    const a = s.addFolder([
      file(makeMd2(), 'tris.md2', 'm/tris.md2'),
      file(makeDdsArgb(4, 4, 0xffc83228), 'skin_d.dds', 'm/skin_d.dds'),
      file(makeDdsArgb(4, 4, 0xffff40c0), 'skin_orm.dds', 'm/skin_orm.dds'), // R 255 AO, G 64 шероховатость, B 192 металл
    ]);
    await s.loadModel([a.fileOf(a.entries.find((e) => e.path.endsWith('.md2'))!)]);
    const t = await s.resolveTexture(0);
    const sf = await s.resolveSurface(0, t.source);
    expect(sf.label).toBe('PBR M·R·AO');
    expect(Array.from(sf.image!.rgba!.slice(0, 4))).toEqual([255, 64, 192, 128]);
  });
});

import { smdiSurface } from '../src/engines/arma/model';
describe('Arma _smdi', () => {
  it('файл: G — блик, B — глянец; процедурный цвет — множители', () => {
    expect(smdiSurface('a\\b_smdi.paa')).toMatchObject({ specular: { channel: 1 }, gloss: { channel: 2 } });
    expect(smdiSurface('#(argb,8,8,3)color(1,0.3,0.6,1,smdi)')).toMatchObject({ specularFactor: 0.3, roughnessFactor: 0.4 });
    expect(smdiSurface(undefined)).toBeUndefined();
  });
});
