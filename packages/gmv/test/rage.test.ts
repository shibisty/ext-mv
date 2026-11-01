import { describe, expect, it } from 'vitest';
import { createRegistry, ViewerSession } from '../src/index';
import { allEngines } from '../src/engines/index';
import { joaat, openResource, sizeFromFlags } from '../src/engines/rage/rsc';
import { file } from './helpers/bin';
import { makeYdd, makeYdr, makeYtd } from './helpers/rage';

const ab = (u8: Uint8Array) => u8.slice().buffer;

describe('RAGE (GTA V)', () => {
  it('размеры сегментов по флагам и joaat', () => {
    expect(sizeFromFlags(1 << 17)).toBe(0x2000);
    expect(sizeFromFlags((1 << 17) | 2)).toBe(0x8000);
    expect(joaat('DiffuseSampler')).toBe(joaat('diffusesampler'));
    expect(joaat('a')).toBe(0xca2e9442);
  });
  it('не RSC7 / RSC8 — понятные ошибки', async () => {
    await expect(openResource(new Uint8Array(32).buffer)).rejects.toThrow(/RSC7/);
    const g9 = new Uint8Array(32); new DataView(g9.buffer).setUint32(0, 0x38435352, true);
    await expect(openResource(g9.buffer)).rejects.toThrow(/RSC8/);
  });
  it('.ydr: геометрия, UV, текстура из встроенного словаря', async () => {
    const s = new ViewerSession(createRegistry(allEngines), 'gta5');
    const m = (await s.loadModel([file(makeYdr(), 'prop.ydr')]))!;
    expect(m.meshes).toHaveLength(1);
    const me = m.meshes[0]!;
    expect(Array.from(me.pos)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(me.uv)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(Array.from(me.nor.slice(0, 3))).toEqual([0, 0, 1]);
    expect(me.texture).toBe('body_diff');
    expect(m.defaultZUp).toBe(true);
    const t = await s.resolveTexture(0);
    expect(t.ok).toBe(true);
    expect(Array.from(t.image!.rgba!.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });
  it('.ydd + .ytd из папки: словарь drawable, текстура по имени файла .ytd (внутреннее имя у модов другое)', async () => {
    const s = new ViewerSession(createRegistry(allEngines), 'gta5');
    const a = s.addFolder([file(makeYdd('uppr_diff_000_a_uni'), 'uppr_000_u.ydd', 'ped/uppr_000_u.ydd'), file(makeYtd(['decl_diff_009_a_uni']), 'uppr_diff_000_a_uni.ytd', 'ped/uppr_diff_000_a_uni.ytd')]);
    const m = (await s.loadModel([a.fileOf(a.entries.find((e) => e.path.endsWith('.ydd'))!)]))!;
    expect(m.meshes).toHaveLength(2);
    expect(m.meshes[1]!.pos[2]).toBe(2);
    expect((await s.resolveTexture(1)).ok).toBe(true);
  });
});
