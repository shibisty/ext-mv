// Мост через assimp (WASM): glTF, FBX, OBJ, Collada и ещё ~25 форматов. Используется и как «мост» для экспортов из утилит движков.
import { defineEngine, type GamePreset } from '../../core/plugin';

export const ASSIMP_EXTENSIONS = ['gltf', 'glb', 'fbx', 'obj', 'dae', '3ds', 'stl', 'ply', 'blend', 'x', 'md5mesh', 'md2', 'md3', 'bvh', 'lwo', 'off', 'dxf', 'ms3d', 'smd', '3mf', 'ase', 'ac', 'ifc', 'xgl', 'cob', 'b3d', 'ogex'];
const ui: GamePreset['ui'] = { zUp: true };
const fmt = (id: string, title: string, exts: string[], hint?: string): GamePreset => ({ id, group: 'Форматы (assimp)', title, engine: 'assimp', formats: ['assimp'], ui, status: 'bridge', hint, extensions: exts });

export const assimpEngine = defineEngine({
  id: 'assimp',
  title: 'assimp (мост)',
  formats: [
    {
      id: 'assimp', title: 'assimp (glTF, FBX, OBJ, DAE…)', engine: 'assimp', extensions: ASSIMP_EXTENSIONS, status: 'bridge',
      load: async (main, ctx) => (await import('./runtime')).loadWithAssimp(ctx.files, main),
    },
  ],
  games: [
    fmt('assimp-auto', 'Авто (любой формат assimp)', ASSIMP_EXTENSIONS, 'Для .obj/.gltf выберите вместе с моделью .mtl/.bin.'),
    fmt('gltf', 'glTF / GLB', ['gltf', 'glb']),
    fmt('fbx', 'FBX', ['fbx']),
    fmt('obj', 'Wavefront OBJ', ['obj'], 'Выберите .obj и .mtl одновременно (Ctrl/Shift).'),
    fmt('dae', 'Collada (DAE)', ['dae']),
    fmt('3ds', '3DS', ['3ds']),
    fmt('blend', 'Blender (.blend)', ['blend']),
    fmt('stl', 'STL', ['stl']),
    fmt('ply', 'PLY', ['ply']),
    fmt('x', 'DirectX (.x)', ['x']),
    fmt('md', 'Quake/Doom: MD2, MD3, MD5', ['md2', 'md3', 'md5mesh']),
    fmt('smd', 'Source: SMD', ['smd']),
    fmt('other', 'Прочие (LWO, BVH, DXF, 3MF, MS3D, ASE…)', ['lwo', 'bvh', 'dxf', '3mf', 'ms3d', 'ase', 'ac', 'off', 'ifc', 'xgl', 'cob', 'b3d', 'ogex']),
  ],
});
export { configureAssimp, ASSIMP_MISSING, type AssimpOptions, type AssimpJs } from './runtime';
export { convertScene, type AssScene } from './convert';
