// Мост assimp на настоящем assimpjs (WASM в Node): проверка имён полей 'assjson' и конвертации сцены.
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureAssimp, type AssimpJs } from '../src/engines/assimp/index';
import { loadWithAssimp, readScene } from '../src/engines/assimp/runtime';
import { vfile } from './helpers/bin';

const require = createRequire(import.meta.url);
const enc = (s: string) => new TextEncoder().encode(s);

/** glTF: треугольник со скином на 2 костях и анимация сдвига кости b1 по X (0 -> 2 за 1 с). */
function skinnedGltf(): string {
  const buf = new ArrayBuffer(264), dv = new DataView(buf);
  const f = (o: number, ...v: number[]) => v.forEach((x, i) => dv.setFloat32(o + i * 4, x, true));
  f(0, 0, 0, 0, 1, 0, 0, 0, 1, 1);
  [0, 1, 2].forEach((x, i) => dv.setUint16(36 + i * 2, x, true));
  new Uint8Array(buf, 44, 12).set([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
  f(56, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0);
  f(104, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  f(168, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 1);
  f(232, 0, 1);
  f(240, 0, 0, 1, 2, 0, 1);
  const b64 = Buffer.from(buf).toString('base64');
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'body', mesh: 0, skin: 0 }, { name: 'root', children: [2] }, { name: 'b1', translation: [0, 0, 1] }],
    meshes: [{ name: 'tri', primitives: [{ attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 1, material: 0 }] }],
    materials: [{ name: 'skinmat', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: 'body_d.png' }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 4 }],
    animations: [{ name: 'slide', channels: [{ sampler: 0, target: { node: 2, path: 'translation' } }], samplers: [{ input: 5, output: 6, interpolation: 'LINEAR' }] }],
    buffers: [{ byteLength: 264, uri: 'data:application/octet-stream;base64,' + b64 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }, { buffer: 0, byteOffset: 44, byteLength: 12 },
      { buffer: 0, byteOffset: 56, byteLength: 48 }, { buffer: 0, byteOffset: 104, byteLength: 128 }, { buffer: 0, byteOffset: 232, byteLength: 8 }, { buffer: 0, byteOffset: 240, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 2, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'MAT4' },
      { bufferView: 5, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 6, componentType: 5126, count: 2, type: 'VEC3' },
    ],
  });
}

describe('assimp (настоящий assimpjs)', () => {
  beforeAll(() => {
    configureAssimp({ factory: () => (require('assimpjs') as () => Promise<AssimpJs>)() });
  });

  it('OBJ + MTL: имена полей assjson и текстура из материала', async () => {
    const obj = vfile(enc('mtllib a.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl red\nf 1/1 2/2 3/3\nf 1/1 3/3 4/1\n'), 'a.obj');
    const mtl = vfile(enc('newmtl red\nKd 1 0 0\nmap_Kd textures/red.png\n'), 'a.mtl');
    const scene = await readScene([obj, mtl], obj);
    expect(Object.keys(scene)).toEqual(expect.arrayContaining(['rootnode', 'meshes', 'materials']));
    expect(scene.rootnode.transformation).toHaveLength(16);
    expect(Object.keys(scene.meshes![0]!)).toEqual(expect.arrayContaining(['vertices', 'faces', 'texturecoords', 'numuvcomponents', 'materialindex']));
    const m = await loadWithAssimp([obj, mtl], obj);
    expect(m.meshes).toHaveLength(1);
    expect(m.meshes[0]!.texture).toBe('textures/red.png');
    expect(m.meshes[0]!.material).toBe('red');
    expect(m.meshes[0]!.indices.length).toBe(6);
    expect(m.meshes[0]!.uv[3]).toBeCloseTo(1); // v перевёрнута: 1 - 0
  });

  it('glTF: скин, кости и анимация (каналы, ключи, ticks per second)', async () => {
    const g = vfile(enc(skinnedGltf()), 'skinned.gltf');
    const scene = await readScene([g], g);
    const anim = scene.animations![0]!;
    expect(Object.keys(anim)).toEqual(expect.arrayContaining(['name', 'tickspersecond', 'duration', 'channels']));
    expect(Object.keys(anim.channels![0]!)).toEqual(expect.arrayContaining(['name', 'positionkeys', 'rotationkeys', 'scalingkeys']));
    expect(Object.keys(scene.meshes![0]!.bones![0]!)).toEqual(expect.arrayContaining(['name', 'offsetmatrix', 'weights']));
    const m = await loadWithAssimp([g], g);
    expect(m.motions).toHaveLength(1);
    expect(m.motions[0]!.name).toBe('slide');
    expect(m.motions[0]!.duration).toBeCloseTo(1, 3);
    expect(m.meshes[0]!.texture).toBe('body_d.png');
    const me = m.meshes[0]!, sk = m.skeleton!;
    const at = (t: number) => {
      sk.pose(m.motions[0]!, t, false);
      const v = 2, o = [0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const w = me.weight[v * 4 + k]!;
        if (!w) continue;
        const M = sk.skinV[me.bone[v * 4 + k]!]!;
        for (let r = 0; r < 3; r++) o[r] += w * (M[r]! * me.pos[v * 3]! + M[4 + r]! * me.pos[v * 3 + 1]! + M[8 + r]! * me.pos[v * 3 + 2]! + M[12 + r]!);
      }
      return o.map((x) => Math.round(x * 1000) / 1000 + 0);
    };
    expect(at(0)).toEqual([0, 1, 1]);
    expect(at(1)).toEqual([2, 1, 1]);
    expect(at(0.5)).toEqual([1, 1, 1]);
  });
});
