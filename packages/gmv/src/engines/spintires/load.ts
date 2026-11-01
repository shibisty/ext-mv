import { baseName, decodeText } from '../../core/binary';
import { boundsOf, sumTris, sumVerts } from '../../core/geometry';
import type { LoadContext } from '../../core/plugin';
import type { TextureLibrary, TextureSource } from '../../core/textures';
import type { Archive, ArchiveEntry, Mesh, Model, SurfaceInfo, VFile } from '../../core/types';
import { applyWorld, parseMeshCache, type StFile, type StNode } from './mesh';

/** SnowRunner ShadingMap (__sh_d): R — металличность, G — шероховатость, B — AO; MudRunner SpecularMap (__s_d): сила блика. */
const surfaceOf = (m: { shading: string; specular: string }): SurfaceInfo | undefined =>
  m.shading ? { metallic: { map: flatTex(m.shading), channel: 0 }, roughness: { map: flatTex(m.shading), channel: 1 }, ao: { map: flatTex(m.shading), channel: 2 }, source: 'SnowRunner ShadingMap' }
  : m.specular ? { specular: { map: flatTex(m.specular), channel: 0 }, source: 'MudRunner SpecularMap' } : undefined;
/** «trucks/jeep__n_d.tga» -> «trucks_jeep__n_d»: так текстуры лежат в TextureCache, _t и prebuild/textures/pct. */
const flatTex = (p: string) => p.replace(/\\/g, '/').replace(/\.[^./]+$/, '').replace(/\//g, '_');

/** Материал узла: MeshParts (MudRunner), имя материала из заголовка меша (SnowRunner), единственный материал. */
const matFor = (f: StFile, n: StNode) =>
  f.materials.find((m) => m.parts.includes(n.name.toLowerCase())) ?? (n.material ? f.materials.find((m) => m.name === n.material) : undefined) ?? (f.materials.length === 1 ? f.materials[0] : undefined);
import { attrsOf, find, findAll, num, parseXml, vec3, type XEl } from './xml';

export async function loadMeshCache(main: VFile, _ctx: LoadContext): Promise<Model> {
  const f = parseMeshCache(await main.arrayBuffer());
  const meshes: Mesh[] = [];
  for (const n of f.nodes) {
    if (!n.mesh) continue;
    if (!n.skinned) applyWorld(n.mesh, n.world);
    const mat = matFor(f, n);
    if (/^off\./i.test(mat?.diffuse ?? '')) continue; // off.dds — невидимые служебные меши
    n.mesh.texture = mat?.diffuse ?? '';
    if (mat?.normal) n.mesh.normalMap = flatTex(mat.normal);
    const sf = mat && surfaceOf(mat);
    if (sf) n.mesh.surface = sf;
    n.mesh.material = mat?.name;
    meshes.push(n.mesh);
  }
  if (!meshes.length) throw new Error('В MeshCache нет видимых мешей (только коллизии/кости)');
  const info = [
    `${f.snow ? "SnowRunner" : "MudRunner"} MeshCache ${main.name}: узлов ${f.nodes.length}, мешей ${meshes.length}, вершин ${sumVerts(meshes)}, треугольников ${sumTris(meshes)}`,
    `Материалы: ${f.materials.map((m) => `${m.name || '—'} → ${m.diffuse}`).join('; ')}`,
  ];
  if (f.skipped) info.push(`Пропущено служебных данных (коллизии): ${f.skipped} байт`);
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: true, info };
}

/** «trucks/jeep_glass__d_a.tga» -> TextureCache «trucks_jeep_glass__d_a.dds», _t/…, colors/default/… */
export async function resolveSpintiresTexture(mesh: Mesh, lib: TextureLibrary): Promise<TextureSource | null> {
  if (!mesh.texture) return null;
  const flat = mesh.texture.toLowerCase().replace(/\\/g, '/').replace(/\.[^./]+$/, '').replace(/\//g, '_');
  const base = baseName(mesh.texture).toLowerCase().replace(/\.[^.]+$/, '');
  for (const n of [`texturecache/${flat}`, `media/texturecache/${flat}`, `_t/${flat}`, `prebuild/textures/pct/${flat}`, `pct/${flat}`, `colors/default/${flat}`, `colors/default/${base}`, flat, base]) {
    const hit = lib.find(n);
    if (hit) return hit;
  }
  return null;
}

// ---------- машина целиком: classes/trucks/<имя>.xml ----------

function findEntry(archives: readonly Archive[], test: (p: string) => boolean): [Archive, ArchiveEntry] | null {
  for (const a of archives) for (const e of a.entries) if (test(e.path)) return [a, e];
  return null;
}
/** «trucks/jeep_wrangler» -> MeshCache/trucks_jeep_wrangler, prebuild/meshes/… (SnowRunner) или _m/…_<хэш> (моды Steam). */
function meshEntry(archives: readonly Archive[], mesh: string): [Archive, ArchiveEntry] | null {
  const n = mesh.toLowerCase().replace(/\\/g, '/').replace(/\//g, '_');
  return findEntry(archives, (p) => p.endsWith(`/meshcache/${n}`) || p === `meshcache/${n}` || p.endsWith(`/_m/${n}`) || p.endsWith(`prebuild/meshes/${n}`))
    ?? findEntry(archives, (p) => new RegExp(`(^|/)_m/${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_[a-z0-9]{6,10}$`).test(p));
}
async function loadParts(e: [Archive, ArchiveEntry]) {
  const f = parseMeshCache(await e[0].read(e[1]).then((u) => u.slice().buffer));
  const meshes: Mesh[] = [];
  for (const n of f.nodes) {
    if (!n.mesh) continue;
    if (!n.skinned) applyWorld(n.mesh, n.world);
    const mat = matFor(f, n);
    if (/^off\./i.test(mat?.diffuse ?? '')) continue; // off.dds — невидимые служебные меши
    n.mesh.texture = mat?.diffuse ?? '';
    if (mat?.normal) n.mesh.normalMap = flatTex(mat.normal);
    const sf = mat && surfaceOf(mat);
    if (sf) n.mesh.surface = sf;
    meshes.push(n.mesh);
  }
  return { f, meshes };
}
function transform(meshes: Mesh[], prefix: string, t: [number, number, number], flip = false) {
  for (const m of meshes) {
    m.name = `${prefix}${m.name}`;
    for (let v = 0; v < m.vertexCount; v++) {
      if (flip) { m.pos[v * 3] = -m.pos[v * 3]!; m.pos[v * 3 + 2] = -m.pos[v * 3 + 2]!; m.nor[v * 3] = -m.nor[v * 3]!; m.nor[v * 3 + 2] = -m.nor[v * 3 + 2]!; }
      m.pos[v * 3] += t[0]; m.pos[v * 3 + 1] += t[1]; m.pos[v * 3 + 2] += t[2];
    }
  }
}

export async function loadTruck(main: VFile, ctx: LoadContext): Promise<Model> {
  const root = parseXml(decodeText(await main.arrayBuffer()));
  const archives = [...ctx.archives];
  if (main.archive && !archives.includes(main.archive)) archives.push(main.archive);
  const truck = find(root, 'Truck'), addon = find(root, 'TruckAddon'), info: string[] = [];
  const meshName = (truck && find(truck, 'PhysicsModel')?.attrs.Mesh) ?? (addon && (find(addon, 'PhysicsModel')?.attrs.Mesh ?? find(addon, 'Model')?.attrs.Mesh));
  if (!meshName) throw new Error('В XML нет <Truck>/<TruckAddon> с PhysicsModel Mesh=…');
  const me = meshEntry(archives, meshName);
  if (!me) throw new Error(`Нет меша ${meshName} в MeshCache/_m (откройте папку мода целиком)`);
  const body = await loadParts(me);
  const meshes = [...body.meshes];
  let wheels = 0, models = 0;
  if (truck) {
    // навесные модели (рога, наклейки…): ParentFrame + Org
    for (const m of findAll(find(truck, 'PhysicsModel') ?? truck, 'Model')) {
      const e = m.attrs.Mesh ? meshEntry(archives, m.attrs.Mesh) : null;
      if (!e) { if (m.attrs.Mesh) info.push(`Нет меша ${m.attrs.Mesh}`); continue; }
      // меш навесной модели уже в координатах машины; ParentFrame — кость, к которой она крепится (для анимации), Org — сдвиг
      const org = vec3(m.attrs.Org);
      const part = await loadParts(e);
      transform(part.meshes, `${m.attrs.Mesh.split('/').pop()} · `, org);
      meshes.push(...part.meshes);
      models++;
    }
    // колёса: первый набор WheelsSet, позиции Hardpoint
    const ws = find(truck, 'Wheels'), set = find(truck, 'WheelsSet'), wt = set && find(set, 'WheelType');
    if (ws) {
      const dy = num(ws.attrs.HardpointDefaultY), dz = num(ws.attrs.HardpointDefaultZ);
      const list = ws.children.filter((c) => c.tag === 'Wheel').map((c) => attrsOf(c, root));
      const typeOf = (a: Record<string, string>) => wt?.attrs.Type ?? a.DefaultWheelType ?? '';
      const cache = new Map<string, XEl | null>();
      for (const [i, a] of list.entries()) {
        if (a.Pos) {
          // SnowRunner: позиция колеса задана прямо (Pos), шина и диск — из classes/wheels/<тип>.xml по именам DefaultTire/DefaultRim
          const type = (a.WheelType ?? ws.attrs.DefaultWheelType ?? '').toLowerCase();
          if (!cache.has(type)) {
            const we = findEntry(archives, (p) => p.endsWith(`classes/wheels/${type}.xml`));
            cache.set(type, we ? parseXml(decodeText(await we[0].read(we[1]))) : null);
          }
          const wx = cache.get(type);
          const pos = vec3(a.Pos), right = pos[2] < 0;
          const pick = (tag: string, name: string | undefined) => (wx ? findAll(wx, tag).find((t) => !name || t.attrs.Name === name) : undefined)?.attrs.Mesh;
          let any = false;
          for (const mesh of [pick('TruckTire', a.Tire ?? ws.attrs.DefaultTire), pick('TruckRim', a.Rim ?? ws.attrs.DefaultRim)]) {
            const e = mesh ? meshEntry(archives, mesh) : null;
            if (!e) continue;
            const part = await loadParts(e);
            transform(part.meshes, `колесо ${i} · `, pos, right);
            meshes.push(...part.meshes);
            any = true;
          }
          if (any) wheels++;
          else if (i === 0) info.push(`Нет шины/диска для колёс типа ${type}`);
          continue;
        }
        if (wt?.attrs.Wheels && !wt.attrs.Wheels.split(',').map((s) => +s).includes(i)) continue;
        const type = typeOf(a).toLowerCase();
        if (!cache.has(type)) {
          const we = findEntry(archives, (p) => p.endsWith(`classes/wheels/${type}.xml`));
          cache.set(type, we ? parseXml(decodeText(await we[0].read(we[1]))) : null);
        }
        const wx = cache.get(type), tw = wx && find(wx, 'TruckWheel');
        const e = tw?.attrs.Mesh ? meshEntry(archives, tw.attrs.Mesh) : null;
        if (!e) { if (i === 0) info.push(`Нет колеса ${type} (классы wheels/ или меш)`); continue; }
        const right = a.RightSide === 'true';
        const y = dy + num(a.HardpointOffsetY) + num(wt?.attrs.HardpointOffsetY), z = dz + num(wt?.attrs.HardpointOffsetZ);
        const part = await loadParts(e);
        transform(part.meshes, `колесо ${i} · `, [num(a.HardpointX), y, right ? -z : z], right);
        meshes.push(...part.meshes);
        wheels++;
      }
    }
  }
  const head = `${body.f.snow ? "SnowRunner" : "MudRunner"}: ${main.name.replace(/\.xml$/i, '')} — меш ${meshName}, колёс ${wheels}, навесных моделей ${models}, мешей ${meshes.length}, вершин ${sumVerts(meshes)}, треугольников ${sumTris(meshes)}`;
  return { meshes, skeleton: null, motions: [], bounds: boundsOf(meshes), flipZ: true, info: [head, ...info] };
}
