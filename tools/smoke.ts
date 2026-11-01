// Проверка gmv на реальных файлах игр (Node, без браузера).
//   npm run smoke -- <папка или архив> [ещё…] [--limit 30] [--out smoke-report.md]
// Для каждой папки: индексирует файлы как «Папку игры», открывает архивы, находит модели всех известных форматов,
// загружает их тем же кодом, что и расширение, и ищет текстуры. Итог — таблица по форматам и список ошибок с диагностикой.
import { openAsBlob, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, relative, resolve } from 'node:path';
import { buildDiagnostics, createRegistry, errMsg, ViewerSession, type Archive, type ArchiveEntry, type BlobFile, type VFile } from '../packages/gmv/src/index';
import { allEngines } from '../packages/gmv/src/engines/index';
import { configureAssimp, type AssimpJs } from '../packages/gmv/src/engines/assimp/index';

const require = createRequire(import.meta.url);
try { configureAssimp({ factory: () => (require('assimpjs') as () => Promise<AssimpJs>)() }); } catch { /* без assimp */ }

// ошибки загрузчиков попадают в отчёт; трассировки в консоли только мешают
console.error = () => {};
console.warn = () => {};

const args = process.argv.slice(2);
const opt = (name: string, def: string) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1] ?? def; args.splice(i, 2); return v; };
const LIMIT = parseInt(opt('--limit', '30'), 10);
const OUT = opt('--out', 'smoke-report.md');
const BUDGET = parseInt(opt('--budget', '0'), 10) * 1000; // мс; 0 — без ограничения
const ONLY = opt('--only', '').split(',').filter(Boolean);
const START = Date.now();
const overBudget = () => BUDGET > 0 && Date.now() - START > BUDGET;
const MAX_FILES = 200_000;
if (!args.length) { console.error('Использование: npm run smoke -- <папка|архив> [--limit 30] [--out smoke-report.md]'); process.exit(2); }

interface Row { format: string; file: string; ok: boolean; info: string; tex: string; ms: number }
const rows: Row[] = [], failures: string[] = [], archiveLog: string[] = [];

/** Файл с диска как браузерный File (ленивое чтение, без загрузки в память). */
async function diskFile(path: string, rel: string): Promise<BlobFile> {
  const blob = await openAsBlob(path);
  const f = new File([blob], basename(path));
  Object.defineProperty(f, 'webkitRelativePath', { value: rel.replace(/\\/g, '/') });
  return f;
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= MAX_FILES) return;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
}

async function checkModel(s: ViewerSession, file: VFile, label: string): Promise<void> {
  const det = await s.registry.detect(file, s.preset.formats);
  if (!det) return;
  const fmt = det.format.id, t0 = performance.now();
  const errors: string[] = [];
  const off = s.on('status', (e) => { if (e.error) errors.push(e.text); });
  const model = await s.loadModel([file]);
  off();
  const ms = Math.round(performance.now() - t0);
  if (!model || s.main !== file) {
    rows.push({ format: fmt, file: label, ok: false, info: errors.at(-1) ?? 'не загрузилась', tex: '', ms });
    const fail = s.lastFailure;
    failures.push(`### ${label}\n\n\`\`\`\n${await buildDiagnostics({ file, format: fail?.format ?? fmt, preset: s.preset.id, error: fail?.error ?? errors.at(-1) ?? '?' })}\n\`\`\``);
    return;
  }
  let found = 0, need = 0;
  const miss: string[] = [];
  for (let i = 0; i < model.meshes.length; i++) {
    const r = await s.resolveTexture(i);
    if (model.meshes[i]!.texture || model.meshes[i]!.image) need++;
    // PNG/JPG в Node не декодируются (нет createImageBitmap) — сам файл найден, это считается успехом
    if (r.ok || /нет декодера/.test(r.label)) found++;
    else if (model.meshes[i]!.texture && miss.length < 3) miss.push(model.meshes[i]!.texture);
  }
  const verts = model.meshes.reduce((a, m) => a + m.vertexCount, 0);
  rows.push({ format: fmt, file: label, ok: true, info: `мешей ${model.meshes.length}, вершин ${verts}, костей ${model.skeleton?.n ?? 0}, анимаций ${s.motions.length}`, tex: (need ? `${found}/${need}` : '—') + (miss.length ? ` нет: ${miss.join(', ')}` : ''), ms });
}

/** Все аргументы — одна сессия (как если бы их открыли вместе): например, Meshes.bsa + Textures.bsa. */
async function checkRoots(roots: string[]): Promise<void> {
  const reg = createRegistry(allEngines), s = new ViewerSession(reg);
  const files: BlobFile[] = [];
  for (const root of roots) {
    const st = statSync(root), paths: string[] = [];
    if (st.isDirectory()) walk(root, paths); else paths.push(root);
    const base = resolve(root, '..');
    console.log(`== ${root}: файлов ${paths.length}`);
    files.push(...(await Promise.all(paths.map((p) => diskFile(p, relative(base, p))))));
  }
  const archives = files.filter((f) => reg.isArchive(f.name)), loose = files.filter((f) => !reg.isArchive(f.name));
  if (loose.length) s.addFolder(loose);
  for (const a of archives) {
    const before = s.archives.length;
    const off = s.on('status', (e) => { if (e.error) archiveLog.push(`- ${a.name}: ${e.text}`); });
    await s.addArchives([a, ...archives.filter((x) => x !== a && /\.(dir|vpk)$/i.test(x.name))]);
    off();
    const added = s.archives.slice(before);
    for (const x of added) archiveLog.push(`- ${x.name} (${x.kind} v${x.version}): записей ${x.entries.length}`);
  }
  // модели: все записи всех архивов и папки по расширениям форматов; на расширение — до LIMIT штук, равномерно по списку
  const modelExts = new Set(reg.formats.flatMap((f) => f.extensions));
  const byExt = new Map<string, Array<[Archive, ArchiveEntry]>>();
  for (const a of [...s.archives])
    for (const e of a.entries) {
      const pathModel = reg.isPathModel(e.path);
      const dot = e.path.lastIndexOf('.') > e.path.lastIndexOf('/'), ext = dot ? e.path.slice(e.path.lastIndexOf('.') + 1) : '(без расширения)';
      if ((!modelExts.has(ext) && !pathModel) || (ONLY.length && !ONLY.includes(ext) && !(pathModel && ONLY.includes('-')))) continue;
      if (!byExt.has(ext)) byExt.set(ext, []);
      byExt.get(ext)!.push([a, e]);
    }
  const queue: Array<[Archive, ArchiveEntry]> = [];
  for (const list of byExt.values()) {
    const step = Math.max(1, list.length / LIMIT);
    for (let i = 0; i < list.length && queue.length < 1e6; i += step) queue.push(list[Math.floor(i)]!);
  }
  for (const [a, e] of queue) {
    if (overBudget()) { archiveLog.push(`- остановлено по времени (--budget), проверено ${rows.length} из ${queue.length}`); return; }
    const f = a.fileOf(e);
    writeFileSync(OUT + '.current', `${a.name}: ${e.path}\n`);
    try { await checkModel(s, f, `${a.name}: ${e.path}`); }
    catch (err) { rows.push({ format: e.path.slice(e.path.lastIndexOf('.') + 1), file: `${a.name}: ${e.path}`, ok: false, info: 'исключение: ' + errMsg(err), tex: '', ms: 0 }); }
    process.stdout.write(rows.at(-1)?.ok === false ? 'x' : '.');
  }
}

await checkRoots(args);

// ---------- отчёт ----------
const byFmt = new Map<string, { ok: number; fail: number; texOk: number; texNeed: number }>();
for (const r of rows) {
  const b = byFmt.get(r.format) ?? { ok: 0, fail: 0, texOk: 0, texNeed: 0 };
  if (r.ok) b.ok++; else b.fail++;
  const m = /^(\d+)\/(\d+)/.exec(r.tex);
  if (m) { b.texOk += +m[1]!; b.texNeed += +m[2]!; }
  byFmt.set(r.format, b);
}
const lines = [
  `# Проверка gmv на реальных файлах`, '', `Источники: ${args.join(', ')}. Не больше ${LIMIT} моделей на расширение.`, '',
  '| Формат | Загрузилось | Ошибок | Текстуры найдены |', '|---|---|---|---|',
  ...[...byFmt].sort().map(([f, b]) => `| ${f} | ${b.ok} | ${b.fail} | ${b.texNeed ? `${b.texOk}/${b.texNeed}` : '—'} |`),
  '', '## Архивы', '', ...archiveLog, '',
  '## Все модели', '', '| | Формат | Файл | Результат | Текстуры | мс |', '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.format} | ${r.file.replace(/\|/g, '/')} | ${r.info.replace(/\|/g, '/')} | ${r.tex} | ${r.ms} |`),
  '', '## Диагностика ошибок', '', ...failures.slice(0, 50),
];
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`\n\nИтог: моделей ${rows.length}, ошибок ${rows.filter((r) => !r.ok).length}. Отчёт: ${resolve(OUT)}`);
for (const [f, b] of [...byFmt].sort()) console.log(`  ${f.padEnd(14)} ok ${b.ok}  fail ${b.fail}  текстуры ${b.texNeed ? `${b.texOk}/${b.texNeed}` : '—'}`);
