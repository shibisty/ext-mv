// MF-A A0 (xray-1.7 net1189): опись клипов Far Cry 2 (.mab людей) и лицевых костей Metro 2033 - для переноса в X-Ray.
//   npx vite-node tools/mf-a-census.ts -- --fc2 <Data_Win32> [--metro <папка с content.vfi>] [--omf <stalker_animation.omf> --ogf <модель.ogf>]
//                                        [--out mf_a_census.md]
// FC2: все .mab под папкой общего скелета людей (graphics/characters/_common/) - имя, длительность, ключей, костей с
// ключами, ход корня; разметка по словам имени (hit/fall/getup/wounded/prone/roll/cover...). Metro: по каждому .skeleton
// с лицевыми костями - список костей лица и папки движений. X-Ray: имена движений модели для сравнения «что уже есть».
import { openAsBlob, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { BlobFile } from '../packages/gmv/src/index';
import { openDuniaArchive } from '../packages/gmv/src/engines/dunia/fat';
import { parseMab, parseSkeleton } from '../packages/gmv/src/engines/dunia/mab';
import { openVfi } from '../packages/gmv/src/engines/metro/vfs';
import { parseMetroSkeletonInfo } from '../packages/gmv/src/engines/metro/model';
import { metroMotionHeader } from '../packages/gmv/src/engines/metro/motion';
import { parseOGF, parseOMF } from '../packages/gmv/src/engines/xray/ogf';

console.warn = () => {};
const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); if (i < 0) return ''; const v = args[i + 1] ?? ''; args.splice(i, 2); return v; };
const FC2 = opt('--fc2'), METRO = opt('--metro'), OMF = opt('--omf'), OGF = opt('--ogf'), OUT = opt('--out') || 'mf_a_census.md';
if (!FC2 && !METRO && !OMF) { console.error('нужно --fc2 <Data_Win32> и/или --metro <папка content.vfi> [--omf ... --ogf ...]'); process.exit(2); }

async function diskFile(path: string, rel: string): Promise<BlobFile> {
  const f = new File([await openAsBlob(path)], basename(path));
  Object.defineProperty(f, 'webkitRelativePath', { value: rel.replace(/\\/g, '/') });
  return f;
}
function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); }
}
async function folderFiles(root: string): Promise<BlobFile[]> {
  const paths: string[] = []; walk(root, paths);
  return Promise.all(paths.map((p) => diskFile(p, basename(root) + '/' + relative(root, p))));
}

// Разметка по словам имени: первая подошедшая группа
const GROUPS: Array<[string, RegExp]> = [
  ['попадание (без падения)', /\bhit|flinch|react|impact|stagger|stumble/i],
  ['падение', /\bfall|knock|collapse|dying|death|die\b/i],
  ['вставание', /get_?up|getup|stand_?up|rise|recover/i],
  ['раненый / лёжа', /wound|injur|prone|crawl|lying|ground|bleed/i],
  ['перекат / уклон', /\broll|dodge|dive|evade/i],
  ['укрытие', /cover|peek|lean|crouch|duck/i],
  ['бой: стрельба', /fire|shoot|aim|reload|recoil|burst/i],
  ['бой: ближний', /melee|punch|kick|stab|machete|knife/i],
  ['бросок', /throw|grenade|molotov/i],
  ['передвижение', /walk|run|sprint|jog|strafe|turn|idle|stop|start/i],
  ['взаимодействие', /open|door|climb|ladder|vault|jump|mount|enter|exit|vehicle|drive|sit|swim/i],
  ['речь / жест', /talk|gesture|speak|wave|point|salute|scream|yell/i],
];
const groupOf = (n: string) => GROUPS.find(([, re]) => re.test(n))?.[0] ?? 'прочее';

const out: string[] = ['# MF-A A0: опись источников анимаций\n'];

if (FC2) {
  const files = await folderFiles(FC2);
  const fat = files.find((f) => /\.fat$/i.test(f.name) && !/sound|shader/i.test(f.name));
  if (!fat) throw new Error('в папке нет .fat');
  const arc = await openDuniaArchive(fat, files);
  if (!arc) throw new Error('архив Dunia не открылся');
  const HUMAN = 'graphics/characters/_common/';
  const mabs = arc.entries.filter((e) => e.path.toLowerCase().endsWith('.mab'));
  const human = mabs.filter((e) => e.path.toLowerCase().startsWith(HUMAN));
  out.push(`## Far Cry 2: \`.mab\` - всего ${mabs.length}, людей (${HUMAN}) ${human.length}\n`);
  const rows: Array<{ name: string; group: string; dur: number; keys: number; bones: number; root: number; rootRot: boolean }> = [];
  let bad = 0;
  for (const e of human) {
    try {
      const a = parseMab(await arc.read(e));
      const name = e.path.slice(HUMAN.length).replace(/\.mab$/i, '');
      let root = 0;
      if (a.rootPos && a.rootPos.length > 1) { const p0 = a.rootPos[0]!, p1 = a.rootPos[a.rootPos.length - 1]!; root = Math.hypot(p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!); }
      rows.push({ name, group: groupOf(name), dur: a.duration, keys: a.keys, bones: a.rotKeys.size + a.constRot.size, root, rootRot: !!a.rootRot });
    } catch { bad++; }
  }
  const byGroup = new Map<string, typeof rows>();
  for (const r of rows) (byGroup.get(r.group) ?? byGroup.set(r.group, []).get(r.group)!).push(r);
  out.push(`Не разобрано: ${bad}. По группам (слова имени):\n`, '| Группа | Клипов | Длительность, с (мин–макс) | С ходом корня |', '|---|---|---|---|');
  for (const [g, rs] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const d = rs.map((r) => r.dur), rm = rs.filter((r) => r.root > 0.2).length;
    out.push(`| ${g} | ${rs.length} | ${Math.min(...d).toFixed(1)}–${Math.max(...d).toFixed(1)} | ${rm} |`);
  }
  out.push('', '### Папки (первые два уровня)\n', '| Папка | Клипов |', '|---|---|');
  const byDir = new Map<string, number>();
  for (const r of rows) { const d = r.name.split('/').slice(0, 2).join('/'); byDir.set(d, (byDir.get(d) ?? 0) + 1); }
  for (const [d, n] of [...byDir.entries()].sort((a, b) => b[1] - a[1])) out.push(`| \`${d}\` | ${n} |`);
  for (const g of ['попадание (без падения)', 'падение', 'вставание', 'раненый / лёжа', 'перекат / уклон', 'укрытие']) {
    const rs = byGroup.get(g) ?? [];
    out.push('', `### ${g} - ${rs.length}\n`, '| Клип | с | ключей | костей | ход корня, м |', '|---|---|---|---|---|');
    for (const r of rs.sort((a, b) => a.name.localeCompare(b.name))) out.push(`| \`${r.name}\` | ${r.dur.toFixed(2)} | ${r.keys} | ${r.bones} | ${r.root.toFixed(2)}${r.rootRot ? ' +поворот' : ''} |`);
  }
  // скелет людей - для карты костей A2 (имя, родитель, поза привязки)
  const skEntry = arc.lookup('graphics\\characters\\_common\\pelvis_ref.skeleton') ?? arc.entries.find((e) => e.path.toLowerCase() === HUMAN + 'pelvis_ref.skeleton');
  if (skEntry) {
    const bones = parseSkeleton(await arc.read(skEntry));
    out.push('', `### Скелет людей (${skEntry.path}) - ${bones.length} костей\n`, '| # | Кость | Родитель | Поза привязки: поворот xyzw | смещение |', '|---|---|---|---|---|');
    bones.forEach((b, i) => out.push(`| ${i} | \`${b.name}\` | ${b.parent >= 0 ? '`' + bones[b.parent]!.name + '`' : '-'} | ${b.rot.map((v) => v.toFixed(3)).join(' ')} | ${b.pos.map((v) => v.toFixed(3)).join(' ')} |`));
    writeFileSync(OUT.replace(/\.md$/, '_fc2_skeleton.json'), JSON.stringify(bones, null, 1));
  } else out.push('', '! скелет людей `graphics/characters/_common/pelvis_ref.skeleton` в архиве не найден');
  writeFileSync(OUT.replace(/\.md$/, '_fc2_all.tsv'), rows.map((r) => [r.name, r.group, r.dur.toFixed(3), r.keys, r.bones, r.root.toFixed(3)].join('\t')).join('\n') + '\n');
}

if (METRO) {
  const files = await folderFiles(METRO);
  const vfi = files.find((f) => /\.vfi$/i.test(f.name));
  if (!vfi) throw new Error('в папке нет content.vfi');
  const arc = await openVfi(vfi, files);
  const skels = arc.entries.filter((e) => e.path.toLowerCase().endsWith('.skeleton'));
  const motions = arc.entries.filter((e) => e.path.toLowerCase().endsWith('.motion'));
  const FACE = /jaw|lip|mouth|brow|eye|lid|cheek|tongue|nose|face|teeth|chin|forehead|smile|blink/i;
  out.push('', `## Metro 2033: скелетов ${skels.length}, движений \`.motion\` ${motions.length}\n`);
  // скелеты: все, с числом костей, лицевыми и папками движений; движения считаются по папкам скелета
  type SK = { path: string; bones: number; face: string[]; dirs: string[]; crc: number; names: string[] };
  const sks: SK[] = [];
  for (const e of skels) {
    try {
      const info = parseMetroSkeletonInfo(await arc.read(e));
      sks.push({ path: e.path, bones: info.bones.length, face: info.bones.filter((b) => FACE.test(b.name)).map((b) => b.name), dirs: info.motionFolders, crc: info.crc, names: info.bones.map((b) => b.name) });
    } catch { /* не скелет */ }
  }
  const motionsIn = (dirs: string[]) => motions.filter((m) => dirs.some((d) => m.path.toLowerCase().includes('motions/' + d.replace(/\/+$/, '') + '/')));
  out.push('| Скелет | Костей | Лицевых | Папки движений | Движений | Лицевые кости |', '|---|---|---|---|---|---|');
  for (const k of sks.sort((a, b) => b.bones - a.bones)) out.push(`| \`${k.path}\` | ${k.bones} | ${k.face.length} | ${k.dirs.join(', ')} | ${motionsIn(k.dirs).length} | ${k.face.join(', ')} |`);
  // человеческий скелет (самый костистый с лицом) - список костей, для карты A2
  const human = sks.filter((k) => k.face.length >= 10).sort((a, b) => b.bones - a.bones)[0];
  if (human) {
    out.push('', `### Скелет человека Metro: \`${human.path}\` - ${human.bones} костей\n`, human.names.map((n) => '`' + n + '`').join(', '));
    writeFileSync(OUT.replace(/\.md$/, '_metro_skeleton.json'), JSON.stringify(human, null, 1));
  }
  // движения: по папкам (первые два уровня под motions/), длительность и число костей из заголовка; группы по словам имени
  const rows: Array<{ path: string; keys: number; bones: number; group: string }> = [];
  let bad = 0;
  for (const m of motions) {
    try { const h = metroMotionHeader(await arc.read(m)); rows.push({ path: m.path, keys: h.keys, bones: h.bones.length, group: groupOf(m.path.split('/').pop()!) }); } catch { bad++; }
  }
  const byDir = new Map<string, typeof rows>();
  for (const r of rows) { const d = r.path.toLowerCase().replace(/^.*?motions\//, '').split('/').slice(0, 2).join('/'); (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(r); }
  out.push('', `### Движения по папкам (не разобрано ${bad})\n`, '| Папка | Движений | Длительность, с (мин–макс) | Костей (мин–макс) |', '|---|---|---|---|');
  for (const [d, rs] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const k = rs.map((r) => r.keys / 30), b = rs.map((r) => r.bones);
    out.push(`| \`${d}\` | ${rs.length} | ${Math.min(...k).toFixed(1)}–${Math.max(...k).toFixed(1)} | ${Math.min(...b)}–${Math.max(...b)} |`);
  }
  const byGroup = new Map<string, typeof rows>();
  for (const r of rows) (byGroup.get(r.group) ?? byGroup.set(r.group, []).get(r.group)!).push(r);
  out.push('', '### Движения по группам (слова имени)\n', '| Группа | Движений | Примеры |', '|---|---|---|');
  for (const [g, rs] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) out.push(`| ${g} | ${rs.length} | ${rs.slice(0, 5).map((r) => '`' + r.path.split('/').pop() + '`').join(', ')} |`);
  // лицевые: движения, трогающие лицевые кости человеческого скелета (по номерам костей в заголовке)
  if (human) {
    const faceIdx = new Set(human.names.map((n, i) => (FACE.test(n) ? i : -1)).filter((i) => i >= 0));
    const faceRows: Array<{ path: string; keys: number; nface: number; nbody: number }> = [];
    for (const m of motionsIn(human.dirs)) {
      try { const h = metroMotionHeader(await arc.read(m)); const nf = h.bones.filter((b) => faceIdx.has(b)).length; if (nf) faceRows.push({ path: m.path, keys: h.keys, nface: nf, nbody: h.bones.length - nf }); } catch { /* */ }
    }
    out.push('', `### Движения с лицевыми костями (скелет человека): ${faceRows.length}\n`, '| Движение | с | лицевых костей | прочих |', '|---|---|---|---|');
    for (const r of faceRows.sort((a, b) => b.nface - a.nface).slice(0, 80)) out.push(`| \`${r.path}\` | ${(r.keys / 30).toFixed(1)} | ${r.nface} | ${r.nbody} |`);
  }
  writeFileSync(OUT.replace(/\.md$/, '_metro_all.tsv'), rows.map((r) => [r.path, r.group, (r.keys / 30).toFixed(2), r.bones].join('\t')).join('\n') + '\n');
}

if (OMF && OGF) {
  const ogf = parseOGF(readFileSync(OGF).buffer as ArrayBuffer);
  const b = readFileSync(OMF), motions = parseOMF(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, ogf.bones);
  const byGroup = new Map<string, string[]>();
  for (const m of motions) { const g = groupOf(m.name); (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(m.name); }
  writeFileSync(OUT.replace(/\.md$/, '_xray_skeleton.json'), JSON.stringify(ogf.bones, null, 1));
  out.push('', `## X-Ray: ${basename(OMF)} - движений ${motions.length} (кости ${basename(OGF)}: ${ogf.bones.length})\n`, '| Группа | Движений | Примеры |', '|---|---|---|');
  for (const [g, ns] of [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length)) out.push(`| ${g} | ${ns.length} | ${ns.slice(0, 6).map((n) => '`' + n + '`').join(', ')} |`);
}

writeFileSync(OUT, out.join('\n') + '\n');
console.log('написано:', OUT);
