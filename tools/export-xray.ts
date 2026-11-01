// Выгрузка модели или уровня в исходники X-Ray SDK из командной строки (тот же код, что кнопка «X-Ray SDK (.zip)»).
//   npx tsx tools/export-xray.ts <архивы или файлы…> --load <путь в архиве или файл> --name <имя> --out <файл.zip>
//        [--textures <gamedata/textures>] [--cell 64] [--scale 1] [--keep-textures] [--merge-objects]
// Архивы (.vfi + .vfs, .db, .bsa…) передаются одним набором. Если --load — путь к файлу на диске (например,
// gamedata/levels/<уровень>/level), открываются он и соседние файлы его папки.
//   --keep-textures — источник сам X-Ray: игровые имена текстур, шейдеров и материалов, без копирования текстур.
//   --merge-objects — объекты уровня (Metro level.bin) влить в геометрию ячеек, а не ссылками на .object каждой модели.
//   --textures — для X-Ray: брать DDS прямо по пути <папка>/<имя текстуры>.dds (без обхода всей папки).
import { existsSync, openAsBlob, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRegistry, ViewerSession, writeZip, type BlobFile } from '../packages/gmv/src/index';
import { allEngines } from '../packages/gmv/src/engines/index';
import { exportXraySdk } from '../packages/gmv/src/engines/xray/export';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (n: string, d = '') => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1] ?? d; args.splice(i, 2); return v; };
const keep = flag('--keep-textures'), merge = flag('--merge-objects');
const name = opt('--name'), out = opt('--out'), texDir = opt('--textures'), cell = opt('--cell'), scale = +opt('--scale', '1'), preset = opt('--preset') || null, load = opt('--load');
if (!name || !out || (!load && !args.length)) { console.error('Использование: export-xray <архивы…> --load <путь> --name <имя> --out <zip> [--textures dir] [--cell м] [--scale k] [--keep-textures]'); process.exit(2); }

const s = new ViewerSession(createRegistry(allEngines), preset);
const t0 = Date.now();
let main;
if (load && existsSync(load) && statSync(load).isFile()) {
  // файл на диске: он и соседние файлы его папки (level.geom, .omf, skeleton.nif…), без рекурсии
  const dir = dirname(load), files: BlobFile[] = [];
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (!statSync(p).isFile()) continue; const f = new File([await openAsBlob(p)], n); Object.defineProperty(f, 'webkitRelativePath', { value: `${basename(dir)}/${n}` }); files.push(f); }
  s.addFolder(files);
  main = s.archives[0]!.fileOf(s.archives[0]!.entries.find((e) => e.path.endsWith('/' + basename(load).toLowerCase()))!);
} else {
  await s.addArchives(await Promise.all(args.map(async (p) => new File([await openAsBlob(p)], basename(p)))));
  const want = load.toLowerCase().replace(/\\/g, '/');
  const hit = s.archives.flatMap((a) => a.entries.map((e) => [a, e] as const)).find(([, e]) => e.path === want || e.path.endsWith(want));
  if (!hit) { console.error(`Не найдено в архивах: ${load}`); process.exit(1); }
  main = hit[0].fileOf(hit[1]);
}
const m = await s.loadModel([main]);
if (!m) { console.error('Ошибка:', s.lastFailure?.error); process.exit(1); }
console.log(m.info.join('\n'));
const { files, report } = await exportXraySdk(m, {
  name, cell: cell ? +cell : undefined, scale, xraySource: keep, instances: !merge,
  texture: async (i) => {
    const t = m.meshes[i]!.texture;
    if (texDir && t) {
      const p = join(texDir, t.replace(/\\/g, '/') + (/\.dds$/i.test(t) ? '' : '.dds'));
      if (existsSync(p)) return { name: basename(p), dds: new Uint8Array(readFileSync(p)) };
    }
    const src = await s.textureSource(i);
    if (src && /\.dds$/i.test(src.name)) return { name: src.name, dds: new Uint8Array(await src.arrayBuffer()) };
    const r = await s.resolveTexture(i);
    return r.image?.rgba ? { name: t, image: r.image } : null;
  },
});
const zip = writeZip(files);
writeFileSync(out, zip);
console.log(report.join('\n'), `\nФайлов: ${files.size}, ZIP ${(zip.length / 1048576).toFixed(1)} МБ, ${Date.now() - t0} мс -> ${out}`);
