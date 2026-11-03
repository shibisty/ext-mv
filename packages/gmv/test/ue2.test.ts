// Unreal Engine 2 (Lineage II): расшифровка, таблицы пакета, текстура RGBA8 с хвостом материала Lineage (лиц. ≥ 16),
// Shader → базовая текстура, StaticMesh из другого пакета с материалом по импорту.
import { describe, expect, it } from 'vitest';
import { decodeL2, l2Version, UPackage } from '../src/engines/unreal/ue2pkg';
import { openUe2Package, unpackRgba } from '../src/engines/unreal/ue2archive';
import { loadUe2StaticMesh } from '../src/engines/unreal/ue2mesh';
import { l2Encrypt, makeUe2Package, props, W } from './helpers/ue2';

const blob = (u: Uint8Array, name: string) => Object.assign(new Blob([u.slice().buffer]), { name });

function texPackage(): Uint8Array {
  const names = ['None', 'Core', 'Engine', 'Package', 'Class', 'Texture', 'Shader', 'Format', 'USize', 'VSize', 'Diffuse', 'TwoSided', 'Wall', 'Wall_m', 'Walls'];
  // импорт классов: Engine (пакет), Texture и Shader из Engine
  const imports: Array<[string, string, number, string]> = [['Core', 'Package', 0, 'Engine'], ['Core', 'Class', -1, 'Texture'], ['Core', 'Class', -1, 'Shader'], ['Core', 'Class', -1, 'Package']];
  return makeUe2Package(names, imports, [
    { cls: -4, name: 'Walls', body: (ni) => new W().idx(ni('None')).u },
    { cls: -2, name: 'Wall', outer: 1, body: (ni) => {
      const w = props(ni, [['Format', 1, 5], ['USize', 2, 2], ['VSize', 2, 2]]);
      w.i32(0); // Lineage II: поле после свойств материала
      w.idx(1).i32(0).idx(16).bytes([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 255, 255, 255, 128]).i32(2).i32(2).u8(1).u8(1); // мип BGRA
      return w.u;
    } },
    { cls: -3, name: 'Wall_m', outer: 1, body: (ni) => props(ni, [['Diffuse', 5, 2], ['TwoSided', 3, true]]).i32(0).u },
  ]);
}

function meshPackage(): Uint8Array {
  const names = ['None', 'Core', 'Engine', 'Package', 'Class', 'StaticMesh', 'Shader', 'Materials', 'Material', 'Box', 'L2Tex', 'Walls', 'Wall_m'];
  const imports: Array<[string, string, number, string]> = [['Core', 'Package', 0, 'Engine'], ['Core', 'Class', -1, 'StaticMesh'], ['Core', 'Package', 0, 'L2Tex'], ['Core', 'Package', -3, 'Walls'], ['Engine', 'Shader', -4, 'Wall_m']];
  return makeUe2Package(names, imports, [{ cls: -2, name: 'Box', body: (ni) => {
    const mats = new W().idx(1); mats.bytes(props(ni, [['Material', 5, -5]]).u);
    const w = props(ni, [['Materials', 9, mats.u]]);
    w.bytes(new Uint8Array(25 + 16));
    w.idx(1).i32(0).u16(0).u16(0).u16(2).u16(1).u16(1); // секция: 1 треугольник с индекса 0
    w.bytes(new Uint8Array(25));
    w.idx(3); for (const p of [[0, 0, 0], [100, 0, 0], [0, 100, 0]]) { for (const c of p) w.f32(c); w.f32(0).f32(0).f32(1); } w.i32(0);
    w.idx(0).i32(0).idx(0).i32(0);
    w.idx(1).idx(3); for (const t of [[0, 0], [1, 0], [0, 1]]) w.f32(t[0]!).f32(t[1]!); w.i32(0).i32(0);
    w.idx(3).u16(0).u16(1).u16(2).i32(0);
    w.idx(0).i32(0).idx(0);
    return w.u;
  } }], 123, 12);
}

describe('Unreal Engine 2 (Lineage II)', () => {
  it('расшифровка Ver111 и Ver121 (ключ по сигнатуре пакета), таблицы пакета', () => {
    const plain = texPackage();
    for (const enc of [l2Encrypt(plain, 111), l2Encrypt(plain, 121, 0x37)]) {
      expect(l2Version(enc)).toBeGreaterThan(100);
      const pkg = UPackage.fromBytes(decodeL2(enc));
      expect([pkg.ver, pkg.lic]).toEqual([123, 16]);
      expect(pkg.exports.map((e) => `${e.className}:${e.name}`)).toEqual(['Package:Walls', 'Texture:Wall', 'Shader:Wall_m']);
      expect(pkg.objPath(3)).toBe('Walls.Wall_m');
    }
    const rsa = l2Encrypt(plain, 111); rsa.set([...'Lineage2Ver413'].flatMap((c) => [c.charCodeAt(0), 0]));
    expect(() => decodeL2(rsa)).toThrow(/RSA/);
  });

  it('пакеты как архивы: Shader ведёт к текстуре, меш берёт материал из другого пакета, Y отражается, сантиметры → метры', async () => {
    const tex = await openUe2Package(blob(l2Encrypt(texPackage(), 121, 0x91), 'L2Tex.utx'));
    expect(tex.entries.map((e) => e.path)).toEqual(['l2tex/walls/wall.utex', 'l2tex/walls/wall_m.utex']);
    const img = unpackRgba((await tex.read(tex.entries[1]!)).slice().buffer);
    expect([img.width, img.height]).toEqual([2, 2]);
    expect(Array.from(img.rgba.subarray(0, 8))).toEqual([255, 0, 0, 255, 0, 255, 0, 255]); // BGRA → RGBA
    const arc = await openUe2Package(blob(l2Encrypt(meshPackage(), 111), 'Boxes.usx'));
    expect(arc.entries.map((e) => e.path)).toEqual(['boxes/box.ue2sm']);
    const m = await loadUe2StaticMesh(arc.fileOf(arc.entries[0]!));
    expect(m.meshes).toHaveLength(1);
    const g = m.meshes[0]!;
    expect(g.texture).toBe('L2Tex.Walls.Wall_m');
    expect(g.image?.width).toBe(2);
    expect(Array.from(g.pos).map((v) => Math.round(v * 100) / 100 + 0)).toEqual([0, 0, 0, 1, 0, 0, 0, -1, 0]);
    expect(Array.from(g.indices)).toEqual([0, 1, 2]);
  });
});
