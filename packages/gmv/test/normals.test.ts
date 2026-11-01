import { describe, expect, it } from 'vitest';
import { createRegistry, ViewerSession } from '../src/index';
import { allEngines } from '../src/engines/index';
import { analyzeNormalMap, computeTangents, normalCandidates } from '../src/core/normals';
import { file } from './helpers/bin';
import { makeDdsArgb, makeMd2 } from './helpers/fixtures';

const img = (w: number, h: number, px: (i: number) => [number, number, number, number]) => {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set(px(i), i * 4);
  return { width: w, height: h, rgba };
};

describe('карты нормалей', () => {
  it('имена по диффузной текстуре разных игр', () => {
    expect(normalCandidates('\\vsm_416\\textures\\gun_co.paa')).toContain('/vsm_416/textures/gun_nohq');
    expect(normalCandidates('trucks/jeep_exterior__d.tga')).toContain('trucks/jeep_exterior__n_d');
    expect(normalCandidates('uppr_diff_000_a_uni')).toEqual(expect.arrayContaining(['uppr_normal_000_a_uni', 'uppr_normal_000']));
    expect(normalCandidates('/vehicles/etki/etki_main_b.color.png')).toContain('/vehicles/etki/etki_main_nm.normal');
    expect(normalCandidates('models/rock_d.dds')).toContain('models/rock_n');
    expect(normalCandidates('textures/wall')).toEqual(expect.arrayContaining(['textures/wall_normal', 'textures/wall_local']));
    expect(normalCandidates('')).toEqual([]);
  });
  it('распознавание: RGB, RG (BC5), AG (DXT5nm) и «не нормали»', () => {
    expect(analyzeNormalMap(img(8, 8, (i) => [128 + (i % 3), 128, 255, 255]))).toEqual({ normal: true, packing: 'rgb' });
    expect(analyzeNormalMap(img(8, 8, (i) => [120 + (i % 9), 130, 0, 255]))).toEqual({ normal: true, packing: 'rg' });
    expect(analyzeNormalMap(img(8, 8, (i) => [255, 120 + (i % 7), 0, 100 + (i % 50)]))).toEqual({ normal: true, packing: 'ag' });
    expect(analyzeNormalMap(img(8, 8, () => [200, 40, 30, 255])).normal).toBe(false); // красная диффузная
    // Arma _nohq: R = 0, X в альфе почти ровный (гладкая поверхность), B высокий
    expect(analyzeNormalMap(img(8, 8, (i) => [0, 126 + (i % 2), 254, 128]))).toEqual({ normal: true, packing: 'ag' });
  });
  it('касательные: по направлению U, знак битангенса', () => {
    const quad = { vertexCount: 4, pos: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), nor: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]), indices: Uint16Array.from([0, 1, 2, 0, 2, 3]) };
    const t = computeTangents(quad);
    expect(Array.from(t.slice(0, 4))).toEqual([1, 0, 0, 1]);
    const mirrored = computeTangents({ ...quad, uv: Float32Array.from([0, 0, 1, 0, 1, -1, 0, -1]) });
    expect(mirrored[3]).toBe(-1);
    // без UV — всё равно единичная и перпендикулярная нормали
    const flat = computeTangents({ ...quad, uv: new Float32Array(8) });
    expect(Math.hypot(flat[0]!, flat[1]!, flat[2]!)).toBeCloseTo(1);
    expect(flat[2]).toBeCloseTo(0);
  });
  it('сессия: нормаль рядом с текстурой, проверка «похожести»', async () => {
    const s = new ViewerSession(createRegistry(allEngines));
    const a = s.addFolder([
      file(makeMd2(), 'tris.md2', 'm/tris.md2'),
      file(makeDdsArgb(4, 4, 0xffc83228), 'skin.dds', 'm/skin.dds'),
      file(makeDdsArgb(4, 4, 0xff8080ff), 'skin_n.dds', 'm/skin_n.dds'),
      file(makeDdsArgb(4, 4, 0xffc83228), 'skin_normal.dds', 'm/skin_normal.dds'), // красная — не нормаль, пропускается
    ]);
    await s.loadModel([a.fileOf(a.entries.find((e) => e.path.endsWith('.md2'))!)]);
    expect(s.model!.normalY).toBe('gl'); // id Tech — OpenGL-соглашение
    const t = await s.resolveTexture(0);
    const n = await s.resolveNormal(0, t.source);
    expect(n.ok).toBe(true);
    expect(n.label).toBe('N 4×4');
    expect(Array.from(n.image!.rgba!.slice(0, 3))).toEqual([128, 128, 255]);
  });
});
