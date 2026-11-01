import { describe, expect, it } from 'vitest';
import type { Model, NodeMotion, VertexMotion } from '../src/index';
import { loadMd2, loadMd3, loadMdl, loadMd5 } from '../src/engines/idtech/models';
import { parseMtr } from '../src/engines/idtech/mtr';
import { loadOgf } from '../src/engines/xray/load';
import { parseOGF } from '../src/engines/xray/ogf';
import { loadPsk } from '../src/engines/unreal/psk';
import { convertCast, parseCast } from '../src/engines/cast/cast';
import { convertDff } from '../src/engines/renderware/dff';
import { parseTxd } from '../src/engines/renderware/txd';
import { convertCgf } from '../src/engines/cryengine/cgf';
import { parseCryMtl } from '../src/engines/cryengine/mtl';
import { convertFce } from '../src/engines/ea/fce';
import { decodeVTF } from '../src/engines/valve/vtf';
import { vmtBase } from '../src/engines/valve/vmt';
import { matDiffuse } from '../src/engines/hpl/mat';
import { parseHeader } from '../src/engines/gamebryo/nif';
import { MotionOnlyError } from '../src/core/types';
import { vfile } from './helpers/bin';
import {
  CRY_MTL, MD5ANIM, MD5MESH, makeCastAnim, makeCastModel, makeCgf, makeDff, makeFce, makeMd2, makeMd3, makeOgf, makePsa, makePsk, makeQuakeMdl, makeTxd, makeVtf,
} from './helpers/fixtures';

const enc = (s: string) => new TextEncoder().encode(s);
/** Позиция вершины после скининга текущей позой. */
function skinned(m: Model, mesh: number, v: number): number[] {
  const me = m.meshes[mesh]!, sk = m.skeleton!, x = me.pos[v * 3]!, y = me.pos[v * 3 + 1]!, z = me.pos[v * 3 + 2]!, o = [0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const w = me.weight[v * 4 + k]!;
    if (!w) continue;
    const M = sk.skinV[me.bone[v * 4 + k]!]!;
    o[0] += w * (M[0]! * x + M[4]! * y + M[8]! * z + M[12]!);
    o[1] += w * (M[1]! * x + M[5]! * y + M[9]! * z + M[13]!);
    o[2] += w * (M[2]! * x + M[6]! * y + M[10]! * z + M[14]!);
  }
  return o.map((n) => Math.round(n * 1e4) / 1e4 + 0);
}
const valid = (m: Model) => {
  for (const me of m.meshes) {
    expect(me.pos.length).toBe(me.vertexCount * 3);
    expect(me.nor.length).toBe(me.vertexCount * 3);
    expect(me.uv.length).toBe(me.vertexCount * 2);
    expect(me.bone.length).toBe(me.vertexCount * 4);
    expect(me.indices.length % 3).toBe(0);
    for (const i of me.indices) expect(i).toBeLessThan(me.vertexCount);
  }
  expect(m.info.length).toBeGreaterThan(0);
};

describe('id Tech', () => {
  it('MD2: кадры группируются в анимацию, вершины интерполируются', () => {
    const m = loadMd2(makeMd2());
    valid(m);
    expect(m.meshes[0]!.texture).toBe('models/test/skin.pcx');
    expect(m.motions).toHaveLength(1);
    const mo = m.motions[0] as VertexMotion;
    expect([mo.kind, mo.name, mo.count]).toEqual(['vertex', 'stand', 2]);
    m.animate!(mo, 0.05, false); // половина между кадрами при 10 fps
    expect(m.meshes[0]!.pos[0]).toBeCloseTo(5);
  });
  it('MD3', () => {
    const m = loadMd3(makeMd3());
    valid(m);
    expect(m.meshes[0]!.name).toBe('body');
    expect(m.meshes[0]!.texture).toBe('models/test/body');
    expect(Array.from(m.meshes[0]!.pos.subarray(3, 6))).toEqual([1, 0, 0]);
    m.animate!(m.motions[0]!, 1 / 15, false);
    expect(m.meshes[0]!.pos[7]).toBeCloseTo(2);
  });
  it('Quake MDL: встроенный скин через палитру', () => {
    const pal = new Uint8Array(768);
    pal.set([200, 100, 50], 3);
    const m = loadMdl(makeQuakeMdl(), pal);
    valid(m);
    expect(Array.from(m.meshes[0]!.image!.rgba!.subarray(0, 4))).toEqual([200, 100, 50, 255]);
    expect(loadMdl(makeQuakeMdl(), null).info.join()).toMatch(/Палитра Quake не найдена/);
  });
  it('MD5mesh + md5anim: скелет и анимация', async () => {
    const m = loadMd5(MD5MESH);
    valid(m);
    expect(m.skeleton!.n).toBe(2);
    expect(Array.from(m.meshes[0]!.pos.subarray(6, 9))).toEqual([0, 1, 1]);
    const [anim] = await m.loadMotions!(vfile(enc(MD5ANIM), 'walk.md5anim'));
    expect(anim!.name).toBe('walk');
    expect((anim as NodeMotion).tps).toBe(24);
    m.skeleton!.pose(anim!, 1 / 24, false);
    expect(skinned(m, 0, 2)).toEqual([2, 1, 1]);
    m.skeleton!.pose(null, 0, false);
    expect(skinned(m, 0, 2)).toEqual([0, 1, 1]);
  });
  it('материалы .mtr', () => {
    const map = parseMtr(`// комментарий
      table sinTable { { 0 1 } }
      models/test/skin { qer_editorimage textures/editor.tga { blend diffusemap map models/test/skin_d.tga } }
      models/other { diffusemap textures/other.tga }
      models/weapons/mflash { deform sprite { blend add map clamp textures/particles/flash.tga } }`);
    expect(map.get('models/weapons/mflash')).toBe('textures/particles/flash.tga');
    expect(map.get('models/test/skin')).toBe('models/test/skin_d.tga');
    expect(map.get('models/other')).toBe('textures/other.tga');
  });
});

describe('X-Ray OGF', () => {
  it('статичный меш', async () => {
    const m = await loadOgf(vfile(makeOgf(false), 'box.ogf'));
    valid(m);
    expect(m.flipZ).toBe(true);
    expect(m.skeleton).toBeNull();
    expect(m.meshes[0]!.texture).toBe('act\\act_stalker');
  });
  it('скелетный меш со встроенной анимацией', async () => {
    const raw = parseOGF(makeOgf(true));
    expect(raw.bones.map((b) => b.name)).toEqual(['root']);
    expect(raw.motions).toHaveLength(1);
    expect(raw.motions[0]!.tracks[0]!.constT).toBe(true);
    const m = await loadOgf(vfile(makeOgf(true), 'stalker.ogf'));
    expect(m.skeleton!.n).toBe(1);
    m.skeleton!.pose(m.motions[0]!, 0, true);
    expect(skinned(m, 0, 1)).toEqual([1, 0.5, 0]); // кость сдвинута на 0.5 по Y
  });
  it('неверная версия', () => {
    const buf = new Uint8Array(makeOgf(false));
    buf[8] = 3;
    expect(() => parseOGF(buf.buffer)).toThrow(/версии 4/);
  });
});

describe('Unreal ActorX', () => {
  it('PSK + PSA', async () => {
    const m = loadPsk(makePsk());
    valid(m);
    expect(m.meshes[0]!.texture).toBe('M_Test');
    expect(m.skeleton!.n).toBe(2);
    expect(skinned(m, 0, 2)).toEqual([0, 0, 1]);
    const [walk] = await m.loadMotions!(vfile(makePsa(), 'anims.psa'));
    expect([walk!.name, walk!.frames]).toEqual(['walk', 2]);
    m.skeleton!.pose(walk!, 0.1, false); // второй кадр при 10 fps
    expect(skinned(m, 0, 2)).toEqual([2, 0, 1]);
  });
});

describe('Cast', () => {
  it('модель, материалы, веса и анимация', async () => {
    const m = convertCast(parseCast(makeCastModel()));
    valid(m);
    expect(m.meshes[0]!.texture).toBe('images/gun_col.png');
    expect(m.skeleton!.n).toBe(2);
    const [fire] = await m.loadMotions!(vfile(makeCastAnim(), 'fire.cast'));
    expect([fire!.name, fire!.frames]).toEqual(['fire', 10]);
    m.skeleton!.pose(fire!, 9 / 30, false);
    expect(skinned(m, 0, 2)).toEqual([3, 1, 0]); // j_bolt сдвинута по X на 3 (ty/tz — из позы покоя)
  });
  it('файл анимации вместо модели -> MotionOnlyError', () => {
    expect(() => convertCast(parseCast(makeCastAnim()))).toThrow(MotionOnlyError);
  });
});

describe('RenderWare', () => {
  it('DFF: кадр, материал, текстура', () => {
    const m = convertDff(makeDff());
    valid(m);
    expect(m.meshes[0]!.name).toBe('chassis');
    expect(m.meshes[0]!.texture).toBe('body');
    expect(m.meshes[0]!.color![0]).toBe(1);
    expect(Array.from(m.meshes[0]!.indices)).toEqual([0, 1, 2]);
  });
  it('TXD: 8888', () => {
    const { textures, errors } = parseTxd(makeTxd());
    expect(errors).toEqual([]);
    expect(textures[0]!.name).toBe('body');
    expect(Array.from(textures[0]!.rgba!)).toEqual([255, 0, 0, 255]);
  });
});

describe('CryEngine', () => {
  it('CGF CrCh: потоки, подмеш, имя материала', () => {
    const m = convertCgf(makeCgf());
    valid(m);
    expect(m.meshes[0]!.matId).toBe(2);
    expect(m.meta!.mtlName).toBe('objects/props/box');
    expect(Array.from(m.meshes[0]!.uv)).toEqual([0, 0, 1, 0, 0, 1]);
  });
  it('CryT и #ivo — подсказка про конвертер', () => {
    expect(() => convertCgf(enc('CryTek\0\0\0\0\0\0\0\0\0\0').buffer)).toThrow(/Cryengine Converter/);
    expect(() => convertCgf(enc('#ivo\0\0\0\0').buffer)).toThrow(/Star Citizen/);
  });
  it('.mtl: Diffuse по MatID', () => {
    expect(parseCryMtl(CRY_MTL)).toEqual(['textures/a_ddn.dds', '', 'textures/box_diff.dds']);
  });
});

describe('EA', () => {
  it('FCE3: части и оси по габаритам', () => {
    const m = convertFce(makeFce());
    valid(m);
    expect(m.meshes[0]!.name).toBe(':HB (tex 0)');
    expect(m.meshes[0]!.texture).toBe('car00');
    expect(m.bounds.max).toEqual([2, 0, 4]); // длинная ось -> Z, короткая -> Y
  });
});

describe('Valve / HPL / Gamebryo', () => {
  it('VTF RGBA8888', () => {
    const img = decodeVTF(makeVtf());
    expect(Array.from(img.rgba!)).toEqual([255, 0, 0, 255, 0, 255, 0, 128]);
  });
  it('VMT $basetexture', () => {
    expect(vmtBase('"VertexLitGeneric"\n{\n  "$basetexture" "models\\props\\box"\n}')).toBe('models\\props\\box');
    expect(vmtBase('LightmappedGeneric { $basetexture concrete/wall01 }'.replace(' }', '\n}'))).toBe('concrete/wall01');
  });
  it('HPL .mat', () => {
    expect(matDiffuse('<Material><TextureUnits><Diffuse File="barrel.dds" Mipmaps="true"/></TextureUnits></Material>')).toBe('barrel.dds');
  });
  it('NIF: заголовок и неподдержанные версии', () => {
    expect(() => parseHeader(enc('Gamebryo File Format, Version 10.0.1.0\n').buffer)).toThrow(/10\.0\.1\.0/);
    expect(() => parseHeader(enc('garbage').buffer)).toThrow(/Не NIF/);
  });
});
