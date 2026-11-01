// Быстрый разбор Collada (.dae) без DOM: только статическая геометрия, узлы с матрицами, материалы и текстуры.
// Нужен там, где assimp слишком медленный (BeamNG: dae на 80+ МБ) или где нужна выборка узлов по имени.
// Скин и анимации Collada по-прежнему читает мост assimp.
import { computeNormals, makeIndices } from '../../core/geometry';
import { identity, mulCol, transpose } from '../../core/math';
import type { Mesh } from '../../core/types';

export interface ColladaMesh extends Mesh {
  /** Имя узла сцены (name, иначе id). */
  nodeName: string;
  /** Мировая матрица узла (column-major); вершины уже переведены в мировые координаты. */
  world: Float64Array;
}
export interface ColladaScene {
  upAxis: 'Y_UP' | 'Z_UP' | 'X_UP';
  meshes: ColladaMesh[];
  /** Все имена узлов с геометрией. */
  nodeNames: string[];
}
export interface ColladaOptions {
  /** Брать только узлы с этими именами (регистр не важен). */
  nodes?: ReadonlySet<string>;
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1] : undefined;
};
const nums = (s: string): number[] => {
  const out: number[] = [];
  for (const t of s.trim().split(/\s+/)) if (t) out.push(+t);
  return out;
};

/** Найти парный закрывающий тег с учётом вложенности одноимённых тегов. */
function closeOf(xml: string, name: string, from: number): number {
  const open = new RegExp(`<${name}[\\s>/]|</${name}>`, 'g');
  open.lastIndex = from;
  let depth = 0, m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    if (m[0].startsWith('</')) { if (--depth === 0) return m.index; }
    else {
      const end = xml.indexOf('>', m.index);
      if (xml[end - 1] !== '/') depth++;
      else if (depth === 0) return end;
    }
  }
  return xml.length;
}

/** Все элементы <name ...>…</name> внутри [a, b) верхнего уровня. */
function elements(xml: string, name: string, a = 0, b = xml.length): Array<{ tag: string; body: string; start: number }> {
  const out: Array<{ tag: string; body: string; start: number }> = [], re = new RegExp(`<${name}[\\s>/]`, 'g');
  re.lastIndex = a;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && m.index < b) {
    const tagEnd = xml.indexOf('>', m.index), tag = xml.slice(m.index, tagEnd + 1);
    if (tag.endsWith('/>')) { out.push({ tag, body: '', start: m.index }); continue; }
    const close = closeOf(xml, name, m.index);
    out.push({ tag, body: xml.slice(tagEnd + 1, close), start: m.index });
    re.lastIndex = close + name.length + 3;
  }
  return out;
}
const first = (xml: string, name: string) => elements(xml, name)[0];

interface Source { data: number[]; stride: number }
interface Prim { material: string; inputs: Array<{ semantic: string; source: string; offset: number; set: number }>; count: number; vcount: number[] | null; p: number[] }

function readGeometry(body: string): { sources: Map<string, Source>; vertices: Map<string, string>; prims: Prim[] } {
  const sources = new Map<string, Source>(), vertices = new Map<string, string>(), prims: Prim[] = [];
  const mesh = first(body, 'mesh');
  if (!mesh) return { sources, vertices, prims };
  for (const s of elements(mesh.body, 'source')) {
    const fa = first(s.body, 'float_array'), acc = first(s.body, 'accessor');
    if (!fa) continue;
    sources.set(attr(s.tag, 'id') ?? '', { data: nums(fa.body), stride: +(acc ? attr(acc.tag, 'stride') ?? '1' : '1') });
  }
  for (const v of elements(mesh.body, 'vertices')) {
    const pos = elements(v.body, 'input').find((i) => attr(i.tag, 'semantic') === 'POSITION');
    if (pos) vertices.set(attr(v.tag, 'id') ?? '', (attr(pos.tag, 'source') ?? '').replace(/^#/, ''));
  }
  for (const kind of ['triangles', 'polylist', 'polygons']) {
    for (const t of elements(mesh.body, kind)) {
      const inputs = elements(t.body, 'input').map((i) => ({
        semantic: attr(i.tag, 'semantic') ?? '', source: (attr(i.tag, 'source') ?? '').replace(/^#/, ''), offset: +(attr(i.tag, 'offset') ?? 0), set: +(attr(i.tag, 'set') ?? 0),
      }));
      const vc = kind === 'polylist' ? first(t.body, 'vcount') : undefined;
      // <polygons> — по одному <p> на многоугольник
      const ps = elements(t.body, 'p');
      const p: number[] = [], vcount: number[] | null = kind === 'triangles' ? null : [];
      const stride = Math.max(...inputs.map((i) => i.offset)) + 1;
      for (const x of ps) { const a = nums(x.body); for (const v of a) p.push(v); if (kind === 'polygons') vcount!.push(a.length / stride); }
      if (vc) for (const v of nums(vc.body)) vcount!.push(v);
      prims.push({ material: attr(t.tag, 'material') ?? '', inputs, count: +(attr(t.tag, 'count') ?? 0), vcount, p });
    }
  }
  return { sources, vertices, prims };
}

function nodeMatrix(body: string): Float64Array {
  // учитываем только собственные трансформации узла (до первого вложенного <node>)
  const own = body.slice(0, (() => { const i = body.search(/<node[\s>]/); return i < 0 ? body.length : i; })());
  let m = identity();
  const re = /<(matrix|translate|rotate|scale)[^>]*>([^<]*)<\/\1>/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(own))) {
    const v = nums(x[2]!);
    let t = identity();
    if (x[1] === 'matrix') t = transpose(v);
    else if (x[1] === 'translate') { t[12] = v[0]!; t[13] = v[1]!; t[14] = v[2]!; }
    else if (x[1] === 'scale') { t[0] = v[0]!; t[5] = v[1]!; t[10] = v[2]!; }
    else {
      const [ax, ay, az, deg] = v as [number, number, number, number], l = Math.hypot(ax, ay, az) || 1, a = (deg * Math.PI) / 180;
      const u = [ax / l, ay / l, az / l], c = Math.cos(a), s = Math.sin(a), C = 1 - c;
      const R = [c + u[0]! * u[0]! * C, u[0]! * u[1]! * C - u[2]! * s, u[0]! * u[2]! * C + u[1]! * s,
        u[1]! * u[0]! * C + u[2]! * s, c + u[1]! * u[1]! * C, u[1]! * u[2]! * C - u[0]! * s,
        u[2]! * u[0]! * C - u[1]! * s, u[2]! * u[1]! * C + u[0]! * s, c + u[2]! * u[2]! * C];
      for (let r = 0; r < 3; r++) for (let c2 = 0; c2 < 3; c2++) t[c2 * 4 + r] = R[r * 3 + c2]!;
    }
    m = mulCol(m, t);
  }
  return m;
}

export function parseCollada(xml: string, opt: ColladaOptions = {}): ColladaScene {
  const upAxis = ((/<up_axis>\s*(\w+)\s*<\/up_axis>/.exec(xml)?.[1] ?? 'Y_UP') as ColladaScene['upAxis']);
  // материалы -> имя и текстура (material -> effect -> sampler/surface -> image)
  const images = new Map<string, string>();
  const libImg = first(xml, 'library_images');
  if (libImg) for (const im of elements(libImg.body, 'image')) {
    const init = /<init_from>\s*([^<]*?)\s*<\/init_from>/.exec(im.body)?.[1] ?? '';
    images.set(attr(im.tag, 'id') ?? '', decodeURIComponent(init.replace(/^file:\/+/, '')));
  }
  const effectTex = new Map<string, string>();
  const libFx = first(xml, 'library_effects');
  if (libFx) for (const fx of elements(libFx.body, 'effect')) {
    const diffuse = first(fx.body, 'diffuse') ?? first(fx.body, 'emission');
    const tex = diffuse ? /<texture\s[^>]*texture="([^"]*)"/.exec(diffuse.body)?.[1] : undefined;
    if (!tex) continue;
    // texture -> newparam sampler -> surface -> image (Collada 1.4) или сразу image
    let img = tex;
    const samp = new RegExp(`<newparam sid="${tex}">[\\s\\S]*?<source>([^<]*)</source>`).exec(fx.body)?.[1];
    if (samp) img = new RegExp(`<newparam sid="${samp}">[\\s\\S]*?<init_from>([^<]*)</init_from>`).exec(fx.body)?.[1] ?? img;
    effectTex.set(attr(fx.tag, 'id') ?? '', images.get(img) ?? img);
  }
  const materials = new Map<string, { name: string; texture: string }>();
  const libMat = first(xml, 'library_materials');
  if (libMat) for (const m of elements(libMat.body, 'material')) {
    const fx = (/<instance_effect url="#([^"]*)"/.exec(m.body)?.[1]) ?? '';
    materials.set(attr(m.tag, 'id') ?? '', { name: attr(m.tag, 'name') ?? attr(m.tag, 'id') ?? '', texture: effectTex.get(fx) ?? '' });
  }
  // геометрия: индекс положения <geometry id> в тексте; читаем лениво, только нужные
  const geomAt = new Map<string, { tag: string; body: string }>();
  const libGeo = first(xml, 'library_geometries');
  if (libGeo) for (const g of elements(libGeo.body, 'geometry')) geomAt.set(attr(g.tag, 'id') ?? '', g);

  const meshes: ColladaMesh[] = [], nodeNames: string[] = [];
  const want = opt.nodes ? new Set([...opt.nodes].map((s) => s.toLowerCase())) : null;
  const walk = (body: string, parent: Float64Array) => {
    for (const n of elements(body, 'node')) {
      const name = attr(n.tag, 'name') ?? attr(n.tag, 'id') ?? '', world = mulCol(parent, nodeMatrix(n.body));
      const take = !want || want.has(name.toLowerCase()); // только узлы с этим именем (дочерние — отдельные детали)
      const own = n.body.slice(0, (() => { const i = n.body.search(/<node[\s>]/); return i < 0 ? n.body.length : i; })());
      for (const ig of elements(own, 'instance_geometry')) {
        nodeNames.push(name);
        if (!take) continue;
        const g = geomAt.get((attr(ig.tag, 'url') ?? '').replace(/^#/, ''));
        if (!g) continue;
        const bind = new Map<string, string>();
        for (const im of elements(ig.body, 'instance_material')) bind.set(attr(im.tag, 'symbol') ?? '', (attr(im.tag, 'target') ?? '').replace(/^#/, ''));
        for (const bm of buildMeshes(readGeometry(g.body), name, world, (sym) => materials.get(bind.get(sym) ?? sym) ?? { name: sym, texture: '' })) meshes.push(bm);
      }
      walk(n.body, world);
    }
  };
  const vs = first(xml, 'library_visual_scenes');
  if (vs) for (const scene of elements(vs.body, 'visual_scene')) walk(scene.body, identity());
  return { upAxis, meshes, nodeNames };
}

function buildMeshes(geo: ReturnType<typeof readGeometry>, nodeName: string, world: Float64Array, mat: (sym: string) => { name: string; texture: string }): ColladaMesh[] {
  const out: ColladaMesh[] = [];
  const nm = mulCol(world, identity()); // нормали: без масштаба-сдвига достаточно верхней 3×3
  for (const pr of geo.prims) {
    const vin = pr.inputs.find((i) => i.semantic === 'VERTEX'), nin = pr.inputs.find((i) => i.semantic === 'NORMAL');
    const tin = pr.inputs.filter((i) => i.semantic === 'TEXCOORD').sort((a, b) => a.set - b.set)[0];
    if (!vin) continue;
    const posSrc = geo.sources.get(geo.vertices.get(vin.source) ?? vin.source), norSrc = nin && geo.sources.get(nin.source), uvSrc = tin && geo.sources.get(tin.source);
    if (!posSrc) continue;
    const stride = Math.max(...pr.inputs.map((i) => i.offset)) + 1;
    // многоугольники -> треугольники веером
    const corners: number[] = [];
    if (!pr.vcount) for (let i = 0; i < pr.p.length / stride; i++) corners.push(i);
    else {
      let c = 0;
      for (const n of pr.vcount) { for (let k = 1; k + 1 < n; k++) corners.push(c, c + k, c + k + 1); c += n; }
    }
    const map = new Map<string, number>(), pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
    for (const c of corners) {
      const base = c * stride, pi = pr.p[base + vin.offset]!, ni = nin ? pr.p[base + nin.offset]! : -1, ti = tin ? pr.p[base + tin.offset]! : -1;
      const key = `${pi}/${ni}/${ti}`;
      let v = map.get(key);
      if (v === undefined) {
        v = map.size; map.set(key, v);
        const s = posSrc.stride, x = posSrc.data[pi * s]!, y = posSrc.data[pi * s + 1]!, z = posSrc.data[pi * s + 2]!;
        pos.push(world[0]! * x + world[4]! * y + world[8]! * z + world[12]!, world[1]! * x + world[5]! * y + world[9]! * z + world[13]!, world[2]! * x + world[6]! * y + world[10]! * z + world[14]!);
        if (norSrc && ni >= 0) {
          const t = norSrc.stride, a = norSrc.data[ni * t]!, b = norSrc.data[ni * t + 1]!, d = norSrc.data[ni * t + 2]!;
          nor.push(nm[0]! * a + nm[4]! * b + nm[8]! * d, nm[1]! * a + nm[5]! * b + nm[9]! * d, nm[2]! * a + nm[6]! * b + nm[10]! * d);
        }
        if (uvSrc && ti >= 0) uv.push(uvSrc.data[ti * uvSrc.stride]!, 1 - uvSrc.data[ti * uvSrc.stride + 1]!);
        else uv.push(0, 0);
      }
      idx.push(v);
    }
    const n = map.size;
    if (!n) continue;
    const P = Float32Array.from(pos);
    let N: Float32Array;
    if (nor.length === n * 3) {
      N = Float32Array.from(nor);
      for (let i = 0; i < n; i++) { const l = Math.hypot(N[i * 3]!, N[i * 3 + 1]!, N[i * 3 + 2]!) || 1; N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l; }
    } else N = computeNormals(P, idx);
    const m = mat(pr.material), weight = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) weight[i * 4] = 1;
    out.push({ name: nodeName, nodeName, world, texture: m.texture, material: m.name, shader: '', vertexCount: n, pos: P, nor: N, uv: Float32Array.from(uv),
      bone: new Float32Array(n * 4), weight, indices: makeIndices(n, idx), skinned: false });
  }
  return out;
}
