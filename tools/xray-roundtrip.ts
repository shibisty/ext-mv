// Проверка записи .object: прочитать объекты SDK → записать заново → прочитать → сравнить треугольники
// (позиции, нормали по сглаживанию, UV) как мультимножества.
//   npx tsx tools/xray-roundtrip.ts <файлы .object…>
import { readFileSync } from 'node:fs';
import { objectMeshes, parseObject } from '../packages/gmv/src/engines/xray/object';
import { writeObject } from '../packages/gmv/src/engines/xray/write-object';

const r4 = (x: number) => (Math.abs(x) < 5e-5 ? 0 : x).toFixed(4);
/** Треугольники: ключ (поверхность, позиции и UV углов с сохранением обхода) -> нормали углов. */
const tris = (ms: ReturnType<typeof objectMeshes>) => {
  const out = new Map<string, number[][][]>();
  for (const m of ms) for (let t = 0; t < m.indices.length; t += 3) {
    const v = [0, 1, 2].map((k) => m.indices[t + k]!);
    const c = v.map((i) => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]].map((x) => r4(x!)).join(',') + '/' + [m.uv[i * 2], m.uv[i * 2 + 1]].map((x) => r4(x!)).join(','));
    const s = c.indexOf([...c].sort()[0]!), ord = [s, (s + 1) % 3, (s + 2) % 3];
    const key = `${m.surface?.texture}|${ord.map((k) => c[k]).join(' ')}`;
    (out.get(key) ?? out.set(key, []).get(key)!).push(ord.map((k) => [m.nor[v[k]! * 3]!, m.nor[v[k]! * 3 + 1]!, m.nor[v[k]! * 3 + 2]!]));
  }
  return out;
};
const compare = (a: Map<string, number[][][]>, b: Map<string, number[][][]>) => {
  let geom = 0, normals = 0, total = 0;
  for (const [k, list] of a) {
    total += list.length;
    const other = b.get(k);
    if (!other || other.length !== list.length) { geom += list.length; continue; }
    list.forEach((n, i) => { if (n.some((x, j) => x[0]! * other[i]![j]![0]! + x[1]! * other[i]![j]![1]! + x[2]! * other[i]![j]![2]! < 0.995)) { normals++; if (process.env.DBG && normals < 4) console.log(k, JSON.stringify(n.map((x) => x.map((y) => +y.toFixed(3)))), JSON.stringify(other[i]!.map((x) => x.map((y) => +y.toFixed(3))))); } });
  }
  for (const k of b.keys()) if (!a.has(k)) geom++;
  return { geom, normals, total };
};
let ok = 0, bad = 0;
for (const f of process.argv.slice(2)) {
  const b = readFileSync(f), o = parseObject(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const ms = objectMeshes(o);
  const surfaces = o.surfaces.map((s) => ({ name: s.name, texture: s.texture, eshader: s.eshader, cshader: s.cshader, gamemtl: s.gamemtl, twoSided: !!(s.flags & 1) }));
  // поверхности одного меша собираются обратно в один меш: сглаживание в SDK идёт через границы поверхностей
  const byMesh = new Map<string, { pos: number[]; nor: number[]; uv: number[]; idx: number[]; surf: number[] }>();
  for (const m of ms) {
    const name = m.name.slice(0, m.name.indexOf(': ')), g = byMesh.get(name) ?? byMesh.set(name, { pos: [], nor: [], uv: [], idx: [], surf: [] }).get(name)!;
    const base = g.pos.length / 3, si = Math.max(0, o.surfaces.indexOf(m.surface!));
    g.pos.push(...m.pos); g.nor.push(...m.nor); g.uv.push(...m.uv);
    for (let i = 0; i < m.indices.length; i++) g.idx.push(base + m.indices[i]!);
    for (let t = 0; t < m.indices.length / 3; t++) g.surf.push(si);
  }
  const out = writeObject({ surfaces, meshes: [...byMesh].map(([name, g]) => ({ name, pos: g.pos, nor: g.nor, uv: g.uv, indices: g.idx, surface: g.surf })) });
  const o2 = parseObject(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer), ms2 = objectMeshes(o2);
  const r = compare(tris(ms), tris(ms2));
  if (r.geom || r.normals) { bad++; console.log('РАЗЛИЧИЕ', f, r); }
  else ok++;
}
console.log(`совпало ${ok}, различий ${bad}`);
