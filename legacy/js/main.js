import { FORMATS, byId, detectByExt } from './formats.js';
import { Renderer, OrbitCamera } from './renderer.js';
import { loadImage } from './images.js';
import { openBsa, normPath, stripExt } from './archives/bsa.js';
import { openImg } from './archives/img.js';
import { openFolder, matDiffuse, vmtBase } from './archives/folder.js';
import { openVpk } from './archives/vpk.js';
import { openBigf } from './archives/bigf.js';
import { parseTxd } from './rw/txd.js';
import { openPak } from './archives/pak.js';
import { openZip } from './archives/zip.js';
import { parseMtr } from './loaders/mtr.js';
import { parseCryMtl } from './loaders/crymtl.js';

const $ = (id) => document.getElementById(id);
const IMG_RE = /\.(dds|png|jpe?g|bmp|webp)$/i;
const LOADERS = { xray: () => import('./loaders/xray.js'), assimp: () => import('./loaders/assimp.js'), nif: () => import('./loaders/nif.js'), rw: () => import('./loaders/rw.js'), idtech: () => import('./loaders/idtech.js'), unreal: () => import('./loaders/unreal.js'), cast: () => import('./loaders/cast.js'), nfs: () => import('./loaders/nfs.js'), cry: () => import('./loaders/cry.js'), valve: () => import('./loaders/valve.js') };
const ext = (f) => f.name.split('.').pop().toLowerCase();
const ARC_EXT = ['bsa', 'img', 'dir', 'pak', 'pk3', 'pk4', 'zip', 'vpk', 'viv', 'big'];
function setStatus(t, err) { const s = $('status'); s.textContent = t; s.className = 'status' + (err ? ' err' : ''); }

let renderer;
try { renderer = new Renderer($('gl')); } catch (e) { setStatus('Ошибка WebGL: ' + e.message, true); throw e; }
const camera = new OrbitCamera();
const S = { fmt: null, model: null, motions: [], cur: -1, t: 0, playing: true, texFiles: [], archives: [], txdTex: new Map(), cryMtl: new Map(), overrides: new Map(), cache: new WeakMap(), pendingMesh: -1, status: [] };

// ---------- выбор игры / формата ----------
for (const g of [...new Set(FORMATS.map((f) => f.group))]) {
  const og = document.createElement('optgroup'); og.label = g;
  for (const f of FORMATS.filter((x) => x.group === g)) { const o = document.createElement('option'); o.value = f.id; o.textContent = f.title; og.append(o); }
  $('fmtSel').append(og);
}
function setFormat(id) {
  const f = byId(id) || FORMATS[0]; S.fmt = f; $('fmtSel').value = f.id;
  $('fmtHint').textContent = f.hint || '';
  $('fileModel').accept = f.exts.map((e) => '.' + e).join(','); $('fileModel').multiple = f.loader === 'assimp';
  $('btnOmf').style.display = (f.features?.omf || f.features?.motionExt || f.features?.motionAny) ? '' : 'none';
  $('btnOmf').textContent = f.features?.motionLabel || '+ .omf'; $('fileOmf').accept = f.features?.motionAny ? f.exts.map((e) => '.' + e).join(',') : '.' + (f.features?.motionExt || 'omf');
  $('lblZup').style.display = f.features?.zUp ? '' : 'none';
  $('lblInv').style.display = f.features?.invertQuat ? '' : 'none';
  $('btnArch').style.display = f.features?.archives ? '' : 'none';
  const ax = f.features?.archiveExts || ['bsa'];
  $('fileArch').accept = ax.map((e) => '.' + e).join(','); $('btnArch').textContent = f.features?.archiveLabel || 'Открыть .bsa…';
  $('hModel').textContent = '3. Или загрузить файл';
  try { localStorage.setItem('fmt', f.id); } catch (e) {}
}
$('fmtSel').onchange = (e) => setFormat(e.target.value);
let saved = null; try { saved = localStorage.getItem('fmt'); } catch (e) {}
setFormat(saved);

// ---------- загрузка ----------
async function loadModel(files) {
  let main = files.find((f) => S.fmt.exts.includes(ext(f)));
  if (!main) {
    for (const f of files) { const d = detectByExt(ext(f), S.fmt); if (d) { setFormat(d.id); main = f; break; } }
  }
  if (!main) return setStatus('Нет файла модели, подходящего под выбранный формат', true);
  setStatus('Загрузка…');
  try {
    const loader = await LOADERS[S.fmt.loader]();
    const model = await loader.load(files, main, { archives: S.archives });
    S.animKey = null; S.model = model; S.motions = model.motions.map((m) => ({ ...m, src: 'model' }));
    S.overrides.clear(); S.cur = -1; S.t = 0;
    renderer.setModel(model); const z = !!model.defaultZUp; $('chkZup').checked = z; renderer.setZUp(z); renderer.fit(camera);
    if (model.skeleton) { model.skeleton.pose(null, 0, false, false); renderer.updatePose(model.skeleton); }
    $('info').textContent = [`Файл: ${main.name}`, ...model.info].join('\n');
    rebuildMeshList(); rebuildMotions(); await autoTxd(main); await sameDirMotions(main); applyTextures();
    setStatus(`Загружено: ${main.name}`);
  } catch (e) {
    if (e.motionOnly && S.model && S.model.loadMotions) return loadMotions(main);   // .cast с анимацией, а не с моделью
    console.error(e); setStatus('Ошибка: ' + e.message, true);
  }
}
async function loadMotions(file) {
  if (!S.model || !S.model.loadMotions) return setStatus('Сначала загрузите модель, поддерживающую внешние анимации (.omf)', true);
  try {
    const list = await S.model.loadMotions(file);
    S.motions.push(...list.map((m) => ({ ...m, src: file.name }))); rebuildMotions(); setStatus(`Добавлено анимаций: ${list.length} (${file.name})`);
  } catch (e) { console.error(e); setStatus('Ошибка OMF: ' + e.message, true); }
}
function addTexFiles(files) {
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/').toLowerCase(), key = rel.replace(/\.[^./]+$/, '');
    S.texFiles.push({ file: f, key, base: key.split('/').pop() });
  }
  applyTextures();
}
async function handleFiles(files) {
  files = Array.from(files);
  const img = files.filter((f) => IMG_RE.test(f.name)), mext = S.fmt.features?.motionExt || 'omf', omf = files.filter((f) => ext(f) === mext), rest = files.filter((f) => !IMG_RE.test(f.name) && ![mext, 'omf', ...ARC_EXT, 'txd'].includes(ext(f)));
  const arc = files.filter((f) => ARC_EXT.includes(ext(f))), txd = files.filter((f) => ext(f) === 'txd');
  if (arc.length) await addArchives(arc);
  for (const f of txd) await addTxd(f);
  if (img.length) addTexFiles(img);
  if (rest.length) await loadModel(rest);
  for (const f of omf) await loadMotions(f);
}

// ---------- текстуры ----------
function findTex(name) {
  if (!name) return null;
  const n = stripExt(normPath(name));
  if (S.txdTex.has(n.split('/').pop())) return S.txdTex.get(n.split('/').pop());
  for (const a of S.archives) { const e = a.byKey.get(n) || a.byKey.get('textures/' + n); if (e) return a.fileOf(e); }
  const t = S.texFiles.find((x) => x.key === n) || S.texFiles.find((x) => x.key.endsWith('/' + n)) || S.texFiles.find((x) => x.base === n.split('/').pop());
  return t ? t.file : null;
}
async function hplTexture(mat) {
  const base = mat.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.[^.]+$/, '');
  for (const a of S.archives) {
    const e = a.byBase && a.byBase.get(base + '.mat'); if (!e) continue;
    const tex = matDiffuse(new TextDecoder().decode(await a.read(e)));
    if (tex) return findTex(tex);
  }
  return null;
}
function guessTexture(mat) {      // Unreal: имя материала -> вероятные имена текстур
  const base = mat.replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.[^.]+$/, ''), stem = base.replace(/^(mi|m|mat)_/, '');
  const names = new Set();
  for (const b of [base, stem, 't_' + stem]) for (const s of ['', '_d', '_diffuse', '_basecolor', '_albedo', '_color', '_bc', '_df']) names.add(b + s);
  for (const n of names) { const f = findTex(n); if (f) return f; }
  return null;
}
async function cryTexture(mesh) {   // .mtl CryEngine: подматериал (MatID) -> Diffuse
  const cands = [];
  if (S.model.mtlName) cands.push(S.model.mtlName.replace(/\\/g, '/').toLowerCase().replace(/^\//, '') + '.mtl');
  if (S.model.sourcePath) cands.push(S.model.sourcePath.replace(/\.[^./]+$/, '.mtl'));
  for (const p of cands) {
    const hit = findEntry(p); if (!hit) continue;
    let list = S.cryMtl.get(p); if (!list) { list = parseCryMtl(new TextDecoder().decode(await hit[0].read(hit[1]))); S.cryMtl.set(p, list); }
    const tex = list[mesh.matId] !== undefined ? list[mesh.matId] : list[0]; if (!tex) continue;
    const f = findTex(tex); if (f) return f;
  }
  return null;
}
function findEntry(path) {
  for (const p of [path, path.replace(/^materials\//, '')]) for (const a of S.archives) { const e = a.lookup ? a.lookup(p) : a.index.get(p); if (e) return [a, e]; }
  return null;
}
async function vmtTexture(paths) {
  for (const p of paths) {
    const hit = findEntry(p); if (!hit) continue;
    const tex = vmtBase(new TextDecoder().decode(await hit[0].read(hit[1]))); if (!tex) continue;
    const t = findEntry('materials/' + tex.replace(/\\/g, '/').toLowerCase().replace(/^\//, '') + '.vtf');
    if (t) return t[0].fileOf(t[1]);
  }
  return null;
}
async function mtrTexture(mat) {
  if (!S.mtr) { const map = new Map(); for (const a of S.archives) for (const e of a.entries) if (e.path.endsWith('.mtr') || e.path.endsWith('.mat')) { try { parseMtr(new TextDecoder().decode(await a.read(e)), map); } catch (err) { /* пропуск */ } } S.mtr = map; }
  const n = mat.toLowerCase().replace(/\\/g, '/');
  for (const c of [S.mtr.get(n), n, n + '_d']) { if (!c) continue; const f = findTex(c); if (f) return f; }
  return null;
}
async function applyTexture(i) {
  const mesh = S.model.meshes[i];
  if (mesh.image && !mesh.imageObj) mesh.imageObj = { name: 'embedded', decoded: mesh.image };
  let file = S.overrides.get(i) || mesh.imageObj || findTex(mesh.texture);
  if (!file && S.fmt.features?.mtr && mesh.texture) file = await mtrTexture(mesh.texture);
  if (!file && S.fmt.features?.vmt && mesh.vmtPaths) file = await vmtTexture(mesh.vmtPaths);
  if (!file && S.fmt.features?.cryMtl && mesh.matId !== undefined) file = await cryTexture(mesh);
  if (!file && S.fmt.features?.texGuess && mesh.texture) file = guessTexture(mesh.texture);
  if (!file && S.fmt.features?.hplMat && mesh.material) file = await hplTexture(mesh.material);
  if (!file) { S.status[i] = [mesh.texture ? 'нет файла' : '', false]; return updateRow(i); }
  try {
    let img = S.cache.get(file); if (!img) { img = await loadImage(file); S.cache.set(file, img); }
    renderer.setTexture(i, img); S.status[i] = [`${img.width}×${img.height}`, true];
  } catch (e) { S.status[i] = ['ошибка: ' + e.message, false]; }
  updateRow(i);
}
function applyTextures() { if (S.model) S.model.meshes.forEach((_, i) => applyTexture(i)); }

async function sameDirMotions(main) {
  const mext = S.fmt.features?.motionExt;
  if (!mext || !S.fmt.features?.sameDirMotions || !main.archive || !S.model.loadMotions) return;
  const dir = main.path.replace(/[^/]*$/, ''); let n = 0;
  for (const e of main.archive.entries) {
    if (n >= 80) break;
    if (!e.path.startsWith(dir) || !e.path.endsWith('.' + mext) || e.path.slice(dir.length).includes('/')) continue;
    try { const f = main.archive.fileOf(e); S.motions.push(...(await S.model.loadMotions(f)).map((m) => ({ ...m, src: f.name }))); n++; } catch (err) { console.warn(err); }
  }
  if (n) { rebuildMotions(); setStatus(`Загружено анимаций из папки модели: ${n}`); }
}

// ---------- TXD (RenderWare) ----------
async function addTxd(file) {
  try {
    const { textures, errors } = parseTxd(await file.arrayBuffer());
    for (const t of textures) S.txdTex.set(t.name, { name: t.name + '.txd', decoded: t });
    setStatus(`TXD ${file.name}: текстур ${textures.length}${errors.length ? ', ошибок ' + errors.length + ' (' + errors[0] + ')' : ''}`, errors.length > 0 && !textures.length);
    applyTextures();
  } catch (e) { console.error(e); setStatus('Ошибка TXD: ' + e.message, true); }
}
async function autoTxd(main) {       // модель из архива: подгружаем одноимённый .txd рядом
  if (!main.archive) return;
  const e = main.archive.index.get(main.path.replace(/\.dff$/, '.txd'));
  if (e) await addTxd(main.archive.fileOf(e));
}

// ---------- архивы ----------
function refreshArchList() {
  const q = $('archFilter').value.trim().toLowerCase(), sel = $('archList'); sel.textContent = '';
  let shown = 0, total = 0;
  for (const a of S.archives) for (const e of a.entries) {
    if (!S.fmt.exts.concat(S.fmt.features?.motionExt || []).some((x) => e.path.endsWith('.' + x))) continue; total++;
    if (shown >= 400 || (q && !e.path.includes(q))) continue;
    const o = document.createElement('option'); o.textContent = e.path; o._ref = { a, e }; sel.append(o); shown++;
  }
  $('archInfo').textContent = S.archives.length ? `${S.archives.length} арх., моделей: ${total}${shown >= 400 ? ' (показано 400)' : ''}` : '';
}
async function addArchives(files) {
  const dirs = files.filter((f) => ext(f) === 'dir');
  for (const f of files) {
    try {
      if (ext(f) === 'bsa') { setStatus(`Чтение архива ${f.name}…`); S.archives.push(await openBsa(f)); }
      else if (ext(f) === 'pak') {   // Quake «PACK» или ZIP (CryEngine)
        setStatus(`Чтение архива ${f.name}…`);
        const magic = String.fromCharCode(...new Uint8Array(await f.slice(0, 4).arrayBuffer()));
        S.archives.push(magic === 'PACK' ? await openPak(f) : await openZip(f));
      }
      else if (['pk3', 'pk4', 'zip'].includes(ext(f))) { setStatus(`Чтение архива ${f.name}…`); S.archives.push(await openZip(f)); }
      else if (ext(f) === 'viv' || ext(f) === 'big') { setStatus(`Чтение архива ${f.name}…`); S.archives.push(await openBigf(f)); }
      else if (ext(f) === 'vpk') {
        const m = /^(.*)_(dir|\d{3})\.vpk$/i.exec(f.name);
        if (m && m[2].toLowerCase() !== 'dir') continue;           // части подключаются через *_dir.vpk
        const parts = new Map(); if (m) for (const x of files) { const q = /^(.*)_(\d{3})\.vpk$/i.exec(x.name); if (q && q[1].toLowerCase() === m[1].toLowerCase()) parts.set(parseInt(q[2], 10), x); }
        setStatus(`Чтение архива ${f.name}…`); S.archives.push(await openVpk(f, parts));
      }
      else if (ext(f) === 'img') {
        const base = f.name.toLowerCase().replace(/\.img$/, ''), d = dirs.find((x) => x.name.toLowerCase().replace(/\.dir$/, '') === base);
        setStatus(`Чтение архива ${f.name}…`); S.archives.push(await openImg(f, d));
      }
    } catch (e) { console.error(e); setStatus('Ошибка архива: ' + e.message, true); return; }
  }
  S.mtr = null; setStatus(`Архивов: ${S.archives.length}`); refreshArchList(); applyTextures();
}
$('btnFolder').onclick = () => { $('fileFolder').value = ''; $('fileFolder').click(); };
$('fileFolder').onchange = (e) => { const a = openFolder(Array.from(e.target.files)); S.archives.push(a); setStatus(`Папка «${a.name}»: файлов ${a.entries.length}`); refreshArchList(); applyTextures(); };
$('btnArch').onclick = () => { $('fileArch').value = ''; $('fileArch').click(); };
$('fileArch').onchange = (e) => addArchives(Array.from(e.target.files));
$('archFilter').oninput = refreshArchList;
$('archList').onchange = (e) => { const o = e.target.selectedOptions[0]; if (o) { const f = o._ref.a.fileOf(o._ref.e); if (S.fmt.features?.motionExt && o._ref.e.path.endsWith('.' + S.fmt.features.motionExt)) loadMotions(f); else loadModel([f]); } };

// ---------- интерфейс ----------
function rebuildMeshList() {
  const box = $('meshList'); box.textContent = ''; S.status = [];
  S.model.meshes.forEach((m, i) => {
    const row = document.createElement('div'); row.className = 'mesh'; row.id = 'mesh' + i;
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.onchange = () => { renderer.meshes[i].visible = cb.checked; };
    const nm = document.createElement('span'); nm.className = 'n'; nm.textContent = `${m.name || '#' + i}${m.texture ? ' — ' + m.texture : ''}`; nm.title = m.shader || '';
    const st = document.createElement('span'); st.className = 'st';
    const bt = document.createElement('button'); bt.textContent = '…'; bt.title = 'Выбрать текстуру вручную';
    bt.onclick = () => { S.pendingMesh = i; $('fileMeshTex').value = ''; $('fileMeshTex').click(); };
    row.append(cb, nm, st, bt); box.append(row);
  });
}
function updateRow(i) { const st = document.querySelector(`#mesh${i} .st`); if (!st) return; const [t, ok] = S.status[i] || ['', false]; st.textContent = t; st.className = 'st ' + (ok ? 'ok' : 'bad'); }
function rebuildMotions() {
  const sel = $('motionSel'); sel.textContent = '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); };
  add(-1, '— bind-поза —');
  S.motions.forEach((m, i) => add(i, `${m.name}${m.frames ? ` (${m.frames} кадр.)` : ` (${m.duration.toFixed(2)} с)`}${m.src !== 'model' ? ' · ' + m.src : ''}`));
  sel.value = S.cur;
}
function selectMotion(i) {
  S.cur = i; S.t = 0; S.playing = true; $('btnPlay').textContent = '⏸';
  if (i >= 0 && S.model.detectInvert) $('chkInvQuat').checked = S.model.detectInvert(S.motions[i]);
}
$('motionSel').onchange = (e) => selectMotion(parseInt(e.target.value, 10));
$('btnPlay').onclick = () => { S.playing = !S.playing; $('btnPlay').textContent = S.playing ? '⏸' : '▶'; };
$('rngTime').oninput = (e) => { const m = S.motions[S.cur]; if (m) { S.t = (e.target.value / 1000) * m.duration; S.playing = false; $('btnPlay').textContent = '▶'; } };
$('rngSpeed').oninput = (e) => { $('lblSpeed').textContent = (+e.target.value).toFixed(1) + '×'; };
$('btnCam').onclick = () => renderer.fit(camera);
$('chkZup').onchange = (e) => { renderer.setZUp(e.target.checked); renderer.fit(camera); };

$('btnModel').onclick = () => { $('fileModel').value = ''; $('fileModel').click(); };
$('btnOmf').onclick = () => { $('fileOmf').value = ''; $('fileOmf').click(); };
$('btnTex').onclick = () => { $('fileTex').value = ''; $('fileTex').click(); };
$('btnTexDir').onclick = () => { $('fileTexDir').value = ''; $('fileTexDir').click(); };
$('fileModel').onchange = (e) => handleFiles(e.target.files);
$('fileOmf').onchange = (e) => handleFiles(e.target.files);
$('fileTex').onchange = (e) => handleFiles(e.target.files);
$('fileTexDir').onchange = (e) => addTexFiles(Array.from(e.target.files).filter((f) => IMG_RE.test(f.name)));
$('fileMeshTex').onchange = (e) => { const f = e.target.files[0]; if (f && S.pendingMesh >= 0) { S.overrides.set(S.pendingMesh, f); applyTexture(S.pendingMesh); } };

let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').classList.add('on'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('on'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('drop').classList.remove('on'); handleFiles(e.dataTransfer.files); });

// ---------- камера ----------
const cv = $('gl'); let drag = null;
cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); });
cv.addEventListener('pointerup', () => { drag = null; });
cv.addEventListener('pointermove', (e) => {
  if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY };
  if (e.buttons & 2 || e.shiftKey || e.buttons & 4) camera.pan(dx, dy); else camera.rotate(dx, dy);
});
cv.addEventListener('wheel', (e) => { e.preventDefault(); camera.zoom(Math.exp(e.deltaY * 0.001)); }, { passive: false });
cv.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- цикл ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const loop = $('chkLoop').checked, m = S.cur >= 0 ? S.motions[S.cur] : null, sk = S.model && S.model.skeleton;
  if (m && S.playing) {
    S.t += dt * parseFloat($('rngSpeed').value);
    if (loop) S.t %= m.duration; else if (S.t >= m.duration) { S.t = m.duration; S.playing = false; $('btnPlay').textContent = '▶'; }
  }
  if (S.model && S.model.animate) {
    const key = S.cur + ':' + S.t.toFixed(4);
    if (key !== S.animKey) { S.animKey = key; S.model.animate(m, S.t, loop); renderer.updateGeometry(); }
    if (m) { $('rngTime').value = Math.round((S.t / m.duration) * 1000); $('lblTime').textContent = `${S.t.toFixed(2)} / ${m.duration.toFixed(2)}`; }
  }
  if (sk) {
    sk.pose(m, S.t, loop, $('chkInvQuat').checked); renderer.updatePose(sk);
    if (m) { $('rngTime').value = Math.round((S.t / m.duration) * 1000); $('lblTime').textContent = `${S.t.toFixed(2)} / ${m.duration.toFixed(2)}`; }
  }
  renderer.draw(camera, { tex: $('chkTex').checked, wire: $('chkWire').checked, skeleton: $('chkSkeleton').checked, grid: $('chkGrid').checked, alpha: $('chkAlpha').checked });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
