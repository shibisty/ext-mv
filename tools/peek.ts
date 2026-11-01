// Одна модель «как в просмотрщике», без браузера: сведения, текстуры по мешам и (по желанию) картинка PPM.
//   npm run peek -- <папка|архив…> --load <путь модели или его окончание> [--preset id] [--ppm out.ppm] [--yaw 0.6] [--pitch 0.3]
//     [--motion-file <путь анимации в архиве>] [--motion <имя|номер>] [--time <сек>]
// Папки открываются как «Папка игры», файлы — как архивы (PBO, ZIP, PAK, BSA…).
import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { createRegistry, ViewerSession, type BlobFile } from '../packages/gmv/src/index';
import { allEngines } from '../packages/gmv/src/engines/index';
import { renderPPM } from './render-ppm';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1] ?? d; args.splice(i, 2); return v; };
const clipY = opt('--clip-y'), size = opt('--size'), kf = opt('--motion-file'), motionSel = opt('--motion'), time = +opt('--time', '0'), load = opt('--load'), ppm = opt('--ppm'), preset = opt('--preset') || null, yaw = +opt('--yaw', '0.6'), pitch = +opt('--pitch', '0.3');
if (!args.length || !load) { console.error('Использование: npm run peek -- <папка|архив…> --load <путь> [--preset id] [--ppm out.ppm]'); process.exit(2); }

const s = new ViewerSession(createRegistry(allEngines), preset), arcs: File[] = [];
for (const root of args) {
  if (statSync(root).isDirectory()) {
    const files: BlobFile[] = [];
    const walk = async (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) await walk(p);
        else { const f = new File([await openAsBlob(p)], n); Object.defineProperty(f, 'webkitRelativePath', { value: relative(join(root, '..'), p).replace(/\\/g, '/') }); files.push(f); }
      }
    };
    await walk(root);
    s.addFolder(files);
  } else arcs.push(new File([await openAsBlob(root)], basename(root)));
}
// архивы — одним набором: индексу (.vfi, .dir) нужны соседние файлы данных
if (arcs.length) await s.addArchives(arcs);
const want = load.toLowerCase().replace(/\\/g, '/');
const hit = s.archives.flatMap((a) => a.entries.map((e) => [a, e] as const)).find(([, e]) => e.path === want || e.path.endsWith(want));
if (!hit) { console.error(`Не найдено: ${load}`); process.exit(1); }
const t0 = Date.now();
const m = await s.loadModel([hit[0].fileOf(hit[1])]);
if (!m) { console.error('Ошибка:', s.lastFailure?.error); process.exit(1); }
console.log(m.info.join('\n'), `\n(${Date.now() - t0} мс)`);
const tex = new Map<number, { width: number; height: number; rgba?: Uint8Array }>();
for (let i = 0; i < m.meshes.length; i++) {
  const r = await s.resolveTexture(i), nm = await s.resolveNormal(i, r.source), sf = await s.resolveSurface(i, r.source);
  if (i < 60) console.log(`  ${i} ${m.meshes[i]!.name} | ${m.meshes[i]!.texture} | ${r.label}${nm.label ? ' · ' + nm.label : ''}${sf.label ? ' · ' + sf.label : ''}${m.meshes[i]!.normalMap ? ' (' + m.meshes[i]!.normalMap + ')' : ''} | вершин ${m.meshes[i]!.vertexCount}`);
  if (r.image?.rgba) tex.set(i, r.image);
}
if (kf) {
  const f = s.archives.flatMap((a) => a.entries.map((e) => [a, e] as const)).find(([, e]) => e.path.endsWith(kf.toLowerCase().replace(/\\/g, '/')));
  if (!f) console.error(`Анимация не найдена: ${kf}`);
  else await s.loadMotions(f[0].fileOf(f[1]));
}
if (s.motions.length) console.log("Анимации:", s.motions.map((x, i) => `${i}:${x.name} (${x.duration.toFixed(2)} с)`).slice(0, 20).join(', '));
if (motionSel && m.skeleton) {
  const mo = s.motions.find((x) => x.name === motionSel) ?? s.motions[+motionSel];
  if (mo) { m.skeleton.pose(mo, time, true); console.log(`Поза: ${mo.name} @ ${time} с`); } else console.error(`Нет анимации ${motionSel}`);
}
if (ppm) { renderPPM(m, ppm, { tex, zUp: !!m.defaultZUp, yaw, pitch, clipY: clipY ? +clipY : undefined, W: size ? +size : undefined, H: size ? +size : undefined }); console.log('Картинка:', ppm); }
