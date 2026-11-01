// Страница просмотрщика: стартовое окно выбора игры, верхняя панель инструментов, ресурсы слева, сцена/меши/анимации справа.
import {
  buildDiagnostics, createRegistry, instanceAt, rotatePlacement, sceneTree, ViewerSession,
  type ArchiveItem, type BlobFile, type DecodedImage, type ExportContext, type ExportTexture, type GamePreset, type Motion, type RayHit, type SceneNode,
} from 'gmv';
import { allEngines } from 'gmv/engines';
import { configureAssimp } from 'gmv/engines/assimp';
import { ModelViewer, type ViewerTool } from 'gmv/renderer';
import { attachDrop } from './drop';
import { createExportDialog } from './export-dialog';
import { createLayers } from './layers';
import { createStartScreen } from './start';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('нет элемента #' + id);
  return el as T;
};
const input = (id: string) => $<HTMLInputElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);

const PREF_KEY = 'fmt';
const prefGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const prefSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };
const appVersion = (() => { try { return chrome.runtime.getManifest().version; } catch { return ''; } })();

function setStatus(text: string, err = false): void {
  const s = $('status');
  s.textContent = text;
  s.className = 'status' + (err ? ' err' : '');
}

// ---------- состояние страницы ----------
let curMotion = -1;
let pendingMesh = -1;
let archItems: ArchiveItem[] = [];
/** Выбранный объект сцены: меш или экземпляр. */
let selection: { kind: 'mesh'; mesh: number } | { kind: 'instance'; index: number } | null = null;

// ---------- ядро ----------
// assimpjs кладётся в lib/ при сборке (scripts/build.mjs, без eval для CSP); assimpjs-all.* — если положить вручную
configureAssimp({ baseUrl: new URL('lib/', location.href).href, scripts: ['assimpjs.js', 'assimpjs-all.js'] });
const registry = createRegistry(allEngines);
const session = new ViewerSession(registry, prefGet(PREF_KEY));
let viewer: ModelViewer;
try {
  viewer = new ModelViewer($<HTMLCanvasElement>('gl'), {
    onFrame: (s) => {
      const m = s.motion;
      if (!m) return;
      input('rngTime').value = String(Math.round((s.time / (m.duration || 1)) * 1000));
      $('lblTime').textContent = `${s.time.toFixed(2)} / ${m.duration.toFixed(2)}`;
    },
    onEnded: () => { button('btnPlay').textContent = '▶'; },
    onPick: (hit) => pickHit(hit),
    onToolDrag: (dx) => rotateSelected(dx * 0.01),
  });
} catch (e) {
  setStatus('Ошибка WebGL: ' + (e as Error).message, true);
  throw e;
}
$('ver').textContent = appVersion ? 'v' + appVersion : '';
// для автотестов и отладки из консоли
(globalThis as unknown as { __gmvViewer: ModelViewer }).__gmvViewer = viewer;
session.on('status', ({ text, error }) => {
  setStatus(text, error);
  button('btnDiag').hidden = !(error && session.lastFailure);
});

// ---------- стартовое окно и выбор игры ----------
const start = createStartScreen($('start'), $('gameGrid'), input('gameFilter'), button('btnBack'), registry.games, (id) => {
  session.setPreset(id);
  enterViewer();
});
function enterViewer(): void {
  start.hide();
  $('app').hidden = false;
}
button('btnGame').onclick = () => start.show(session.preset.id, true);

function applyPreset(p: GamePreset): void {
  const ui = p.ui ?? {}, exts = session.modelExtensions, motionExts = registry.presetMotionExtensions(p);
  $('gameTitle').textContent = p.title;
  button('btnGame').dataset.preset = p.id;
  $('fmtHint').textContent = p.hint ?? '';
  input('fileModel').accept = exts.map((e) => '.' + e).join(',');
  input('fileModel').multiple = true; // спутники: .mtl/.bin (assimp), .vvd/.vtx (Source), *T.mdl (GoldSrc)
  const hasMotions = motionExts.length > 0 || !!ui.motionAny;
  button('btnOmf').hidden = !hasMotions;
  button('btnOmf').textContent = ui.motionLabel ?? '+ .' + (motionExts[0] ?? 'omf');
  input('fileOmf').accept = (ui.motionAny ? exts : motionExts).map((e) => '.' + e).join(',');
  $('lblZup').hidden = !ui.zUp;
  $('lblInv').hidden = !ui.invertQuat;
  button('btnArch').hidden = !ui.archives;
  input('fileArch').accept = (ui.archiveExts ?? ['bsa']).map((e) => '.' + e).join(',');
  button('btnArch').textContent = ui.archiveLabel ?? 'Открыть архив…';
  prefSet(PREF_KEY, p.id);
  refreshArchList();
}
session.on('preset', applyPreset);

// ---------- модель, текстуры, анимации ----------
const meshStatus: Array<[string, boolean]> = [];

async function applyTextures(): Promise<void> {
  const m = session.model;
  if (!m) return;
  await Promise.all(m.meshes.map(async (_, i) => {
    const r = await session.resolveTexture(i);
    if (session.model !== m) return; // модель уже сменилась
    if (r.image) viewer.setTexture(i, r.image);
    meshStatus[i] = [r.label, r.ok];
    updateRow(i);
    // карта нормалей: из материала модели или рядом с диффузной (_n, _nohq, __n_d, _normal…)
    const n = await session.resolveNormal(i, r.source);
    if (session.model !== m) return;
    viewer.setNormalMap(i, n.image, n.packing);
    // PBR: шероховатость, металличность, AO, блик (из материала или упакованные карты рядом)
    const sf = await session.resolveSurface(i, r.source);
    if (session.model !== m) return;
    viewer.setSurface(i, sf.image);
    if (n.label || sf.label) { meshStatus[i] = [[r.label, n.label, sf.label].filter(Boolean).join(' · '), r.ok]; updateRow(i); }
  }));
}

session.on('model', ({ model, main }) => {
  enterViewer();
  viewer.setModel(model);
  input('rngClip').value = '1000';
  applyClip();
  flySpeedLabel();
  input('chkZup').checked = !!model.defaultZUp;
  input('chkInvQuat').checked = false;
  curMotion = -1;
  $('info').textContent = [`Файл: ${main.name}`, ...model.info].join('\n');
  setSelection(null);
  rebuildMeshList();
  const tree = sceneTree(model);
  layers.set(tree);
  $('layersInfo').textContent = model.instances?.placements.length ? `объектов ${model.instances.placements.length}` : '';
  rebuildMotions(session.motions);
  void applyTextures();
});
session.on('motions', rebuildMotions);
session.on('textures', () => void applyTextures());
session.on('archives', () => refreshArchList());

function rebuildMeshList(): void {
  const box = $('meshList'), model = session.model;
  box.textContent = '';
  meshStatus.length = 0;
  model?.meshes.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'mesh';
    row.id = 'mesh' + i;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.onchange = () => { viewer.renderer.setMeshVisible(i, cb.checked); layers.syncLeaf(`m${i}`); };
    const nm = document.createElement('span');
    nm.className = 'n';
    nm.textContent = `${m.name || '#' + i}${m.texture && m.texture !== m.name && !m.name.endsWith(m.texture) ? ' — ' + m.texture : ''}`;
    nm.title = [m.texture, m.shader, m.material].filter(Boolean).join('\n');
    nm.onclick = () => setSelection({ kind: 'mesh', mesh: i });
    const st = document.createElement('span');
    st.className = 'st';
    const bt = document.createElement('button');
    bt.textContent = '…';
    bt.title = 'Выбрать текстуру вручную';
    bt.onclick = () => { pendingMesh = i; input('fileMeshTex').value = ''; input('fileMeshTex').click(); };
    row.append(cb, nm, st, bt);
    box.append(row);
  });
}
function updateRow(i: number): void {
  const st = document.querySelector<HTMLElement>(`#mesh${i} .st`);
  if (!st) return;
  const [t, ok] = meshStatus[i] ?? ['', false];
  st.textContent = t;
  st.className = 'st ' + (ok ? 'ok' : 'bad');
}
const meshCheckbox = (i: number) => document.querySelector<HTMLInputElement>(`#mesh${i} input[type=checkbox]`);

function rebuildMotions(list: readonly Motion[]): void {
  const sel = select('motionSel');
  sel.textContent = '';
  const add = (v: number, t: string) => { const o = document.createElement('option'); o.value = String(v); o.textContent = t; sel.append(o); };
  add(-1, '— bind-поза —');
  list.forEach((m, i) => add(i, `${m.name}${m.frames ? ` (${m.frames} кадр.)` : ` (${m.duration.toFixed(2)} с)`}${m.source && m.source !== 'model' ? ' · ' + m.source : ''}`));
  if (curMotion >= list.length) curMotion = -1;
  sel.value = String(curMotion);
}
function selectMotion(i: number): void {
  curMotion = i;
  viewer.setMotion(i >= 0 ? session.motions[i] ?? null : null);
  input('chkInvQuat').checked = viewer.state.invert;
  button('btnPlay').textContent = '⏸';
}

select('motionSel').onchange = (e) => selectMotion(parseInt((e.target as HTMLSelectElement).value, 10));
button('btnPlay').onclick = () => { viewer.state.playing = !viewer.state.playing; button('btnPlay').textContent = viewer.state.playing ? '⏸' : '▶'; };
input('rngTime').oninput = (e) => { viewer.seek(+(e.target as HTMLInputElement).value / 1000); button('btnPlay').textContent = '▶'; };
input('rngSpeed').oninput = (e) => { const v = +(e.target as HTMLInputElement).value; viewer.state.speed = v; $('lblSpeed').textContent = v.toFixed(1) + '×'; };
input('chkLoop').onchange = (e) => { viewer.state.loop = (e.target as HTMLInputElement).checked; };
input('chkInvQuat').onchange = (e) => { viewer.state.invert = (e.target as HTMLInputElement).checked; };

// ---------- вид (выпадающее меню) ----------
const syncView = () => {
  Object.assign(viewer.options, {
    tex: input('chkTex').checked, wire: input('chkWire').checked, skeleton: input('chkSkeleton').checked, grid: input('chkGrid').checked, alpha: input('chkAlpha').checked,
    normals: input('chkNormals').checked, normalFlipY: input('chkNormFlip').checked, pbr: input('chkPbr').checked,
    normalView: +select('selNormView').value as 0 | 1 | 2 | 3, normalStrength: +input('rngNI').value,
  });
};
for (const id of ['chkTex', 'chkWire', 'chkSkeleton', 'chkGrid', 'chkAlpha', 'chkNormals', 'chkNormFlip', 'chkPbr']) input(id).onchange = syncView;
select('selNormView').onchange = syncView;
input('rngNI').oninput = () => { $('lblNI').textContent = (+input('rngNI').value).toFixed(2); syncView(); };
syncView();

/** Выпадающие окна верхней панели: закрываются щелчком мимо и Esc. */
function popup(btnId: string, boxId: string): { close(): void } {
  const btn = button(btnId), box = $(boxId);
  const set = (open: boolean) => { box.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.onclick = (e) => { e.stopPropagation(); set(box.hidden); };
  document.addEventListener('pointerdown', (e) => { if (!box.hidden && !box.contains(e.target as Node) && e.target !== btn) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) set(false); });
  return { close: () => set(false) };
}
popup('btnView', 'viewMenu');
popup('btnInfo', 'infoPop');

// ---------- камера: орбита / полёт, срез ----------
const flySpeedLabel = () => { $('lblFlySpeed').textContent = viewer.cameraMode === 'fly' ? `${viewer.camera.speed < 10 ? viewer.camera.speed.toFixed(1) : Math.round(viewer.camera.speed)} ед/с` : ''; };
function setCameraMode(mode: 'orbit' | 'fly'): void {
  viewer.setCameraMode(mode);
  button('btnOrbit').classList.toggle('on', mode === 'orbit');
  button('btnFly').classList.toggle('on', mode === 'fly');
  flySpeedLabel();
  (document.activeElement as HTMLElement | null)?.blur();
}
button('btnOrbit').onclick = () => setCameraMode('orbit');
button('btnFly').onclick = () => setCameraMode('fly');
button('btnCam').onclick = () => viewer.fit();
$<HTMLCanvasElement>('gl').addEventListener('wheel', () => flySpeedLabel(), { passive: true });
const applyClip = () => {
  const v = +input('rngClip').value;
  if (v >= 1000 || !viewer.model) { viewer.options.clipY = undefined; $('lblClip').textContent = 'выкл.'; return; }
  const [lo, hi] = viewer.heightRange(), y = lo + ((hi - lo) * v) / 1000;
  viewer.options.clipY = y;
  $('lblClip').textContent = y.toFixed(1);
};
input('rngClip').oninput = applyClip;
input('chkZup').onchange = (e) => { viewer.setZUp((e.target as HTMLInputElement).checked); applyClip(); };

// ---------- инструменты: камера, выбор, поворот ----------
function setTool(t: ViewerTool): void {
  viewer.tool = t;
  for (const [id, v] of [['toolCamera', 'camera'], ['toolSelect', 'select'], ['toolRotate', 'rotate']] as const) button(id).classList.toggle('on', t === v);
  $('rotSteps').hidden = t !== 'rotate';
  const main = document.querySelector('main')!;
  main.classList.toggle('tool-select', t === 'select');
  main.classList.toggle('tool-rotate', t === 'rotate');
  showSelInfo();
}
button('toolCamera').onclick = () => setTool('camera');
button('toolSelect').onclick = () => setTool('select');
button('toolRotate').onclick = () => setTool('rotate');
button('btnRotL').onclick = () => rotateSelected(-Math.PI / 2);
button('btnRotR').onclick = () => rotateSelected(Math.PI / 2);
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' && !['checkbox', 'range', 'button'].includes((t as HTMLInputElement).type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') || $('app').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (viewer.cameraMode === 'fly' && /^Key[WASDQEC]$/.test(e.code)) return;
  if (e.code === 'KeyV') setTool('select');
  else if (e.code === 'KeyR') setTool('rotate');
  else if (e.code === 'KeyC') setTool('camera');
  else if (e.key === 'Escape' && selection && !$<HTMLDialogElement>('dlgExport').open) setSelection(null);
  else if (e.code === 'KeyF' && selection) focusSelection();
});

/** Диапазоны индексов выбранного (для подсветки). */
function selectionRanges(): Array<{ mesh: number; iStart: number; iCount: number }> {
  const m = session.model;
  if (!m || !selection) return [];
  if (selection.kind === 'mesh') return [{ mesh: selection.mesh, iStart: 0, iCount: m.meshes[selection.mesh]?.indices.length ?? 0 }];
  return m.instances?.placements[selection.index]?.ranges?.map((r) => ({ mesh: r.mesh, iStart: r.iStart, iCount: r.iCount })) ?? [];
}
function showSelInfo(): void {
  const box = $('selInfo'), m = session.model;
  if (!m || !selection) { box.hidden = true; return; }
  box.hidden = false;
  if (selection.kind === 'mesh') {
    const x = m.meshes[selection.mesh]!;
    box.textContent = `Меш ${selection.mesh}: ${x.name}${x.texture ? ' — ' + x.texture : ''} · ${x.indices.length / 3} тр.${viewer.tool === 'rotate' ? ' · поворот — только для объектов сцены' : ''}`;
  } else {
    const p = m.instances!.placements[selection.index]!, proto = m.instances!.protos[p.proto]!;
    box.textContent = `${p.group ?? 'объект'} · ${p.name} — ${proto.name}${p.hidden ? ' (скрыт)' : ''}${viewer.tool === 'rotate' ? ' · тяните ЛКМ влево-вправо' : ''}`;
  }
}
function setSelection(s: typeof selection): void {
  selection = s;
  viewer.renderer.setHighlight(selectionRanges());
  document.querySelectorAll('.mesh.cur').forEach((r) => r.classList.remove('cur'));
  if (s?.kind === 'mesh') document.getElementById('mesh' + s.mesh)?.classList.add('cur');
  layers.reveal(s ? (s.kind === 'mesh' ? `m${s.mesh}` : `i${s.index}`) : null);
  showSelInfo();
}
function pickHit(hit: RayHit | null): void {
  const m = session.model;
  if (!m || !hit) { setSelection(null); return; }
  const inst = instanceAt(m, hit.mesh, hit.index);
  setSelection(inst >= 0 ? { kind: 'instance', index: inst } : { kind: 'mesh', mesh: hit.mesh });
}
function rotateSelected(angle: number): boolean {
  const m = session.model;
  if (!m || selection?.kind !== 'instance') { if (selection) showSelInfo(); return false; }
  const p = m.instances!.placements[selection.index]!;
  for (const r of rotatePlacement(m, selection.index, angle)) viewer.renderer.updateRange(r.mesh, r.vStart, r.vCount, r.iStart, r.iCount, !!p.hidden);
  return true;
}
/** Камера на выбранное: центр рамки его вершин. */
function focusSelection(): void {
  const m = session.model;
  if (!m || !selection) return;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const add = (mesh: number, vStart: number, vCount: number) => {
    const P = m.meshes[mesh]!.pos;
    for (let v = vStart; v < vStart + vCount; v++) for (let k = 0; k < 3; k++) { const x = P[v * 3 + k]!; if (x < lo[k]!) lo[k] = x; if (x > hi[k]!) hi[k] = x; }
  };
  if (selection.kind === 'mesh') add(selection.mesh, 0, m.meshes[selection.mesh]!.vertexCount);
  else for (const r of m.instances!.placements[selection.index]!.ranges ?? []) add(r.mesh, r.vStart, r.vCount);
  if (!Number.isFinite(lo[0]!)) return;
  viewer.focusBox(lo, hi);
  flySpeedLabel();
}

// ---------- слои сцены ----------
const layers = createLayers($('layers'), {
  isVisible: (n) => {
    const m = session.model;
    if (n.kind === 'mesh') return viewer.renderer.isMeshVisible(n.mesh!);
    return !m?.instances?.placements[n.instance!]?.hidden;
  },
  setVisible: (leaves, visible) => {
    const m = session.model;
    if (!m) return;
    for (const n of leaves) {
      if (n.kind === 'mesh') {
        viewer.renderer.setMeshVisible(n.mesh!, visible);
        const cb = meshCheckbox(n.mesh!);
        if (cb) cb.checked = visible;
      } else if (n.kind === 'instance') {
        const p = m.instances!.placements[n.instance!]!;
        if (!p.hidden === visible) continue;
        p.hidden = !visible;
        for (const r of p.ranges ?? []) viewer.renderer.setRangeVisible(r.mesh, r.iStart, r.iCount, visible);
      }
    }
    showSelInfo();
  },
  select: (n: SceneNode) => setSelection(n.kind === 'mesh' ? { kind: 'mesh', mesh: n.mesh! } : { kind: 'instance', index: n.instance! }),
  focus: (n: SceneNode) => { if (n.kind !== 'group') { setSelection(n.kind === 'mesh' ? { kind: 'mesh', mesh: n.mesh! } : { kind: 'instance', index: n.instance! }); focusSelection(); } },
});

// ---------- архивы и ресурсы ----------
function refreshArchList(): void {
  const sel = select('archList'), { items, total } = session.archiveModels(input('archFilter').value);
  sel.textContent = '';
  archItems = items;
  items.forEach((it, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = it.entry.path; o.title = it.entry.path; sel.append(o); });
  $('archInfo').textContent = session.archives.length ? `${session.archives.length} арх. · моделей ${total}${items.length >= 400 ? ' (показано 400)' : ''}` : '';
}
input('archFilter').oninput = refreshArchList;
select('archList').onchange = (e) => {
  const it = archItems[+(e.target as HTMLSelectElement).value];
  if (it) void session.openEntry(it);
};

// ---------- кнопки и файлы ----------
const pick = (btn: string, file: string) => { button(btn).onclick = () => { input(file).value = ''; input(file).click(); }; };
pick('btnModel', 'fileModel');
pick('btnOmf', 'fileOmf');
pick('btnTex', 'fileTex');
pick('btnTexDir', 'fileTexDir');
pick('btnFolder', 'fileFolder');
pick('btnArch', 'fileArch');
const filesOf = (id: string): File[] => Array.from(input(id).files ?? []);
input('fileModel').onchange = () => void session.addFiles(filesOf('fileModel'));
input('fileOmf').onchange = async () => { for (const f of filesOf('fileOmf')) await session.loadMotions(f); };
input('fileTex').onchange = () => void session.addFiles(filesOf('fileTex'));
input('fileTexDir').onchange = () => session.addTextures(filesOf('fileTexDir'));
input('fileFolder').onchange = () => { session.addFolder(filesOf('fileFolder')); };
input('fileArch').onchange = () => void session.addArchives(filesOf('fileArch'));
input('fileMeshTex').onchange = () => {
  const f = filesOf('fileMeshTex')[0];
  if (f && pendingMesh >= 0) { session.setTextureOverride(pendingMesh, f); void applyTextures(); }
};

button('btnDiag').onclick = async () => {
  const f = session.lastFailure;
  if (!f) return;
  const text = await buildDiagnostics({ file: f.file, format: f.format, preset: session.preset.id, error: f.error, appVersion });
  try { await navigator.clipboard.writeText(text); setStatus('Диагностика скопирована в буфер обмена'); }
  catch { $('info').textContent = text; $('infoPop').hidden = false; setStatus('Не удалось скопировать — диагностика выведена в «Сведения»', true); }
};

attachDrop(window, $('drop'), async ({ files, folders }) => {
  enterViewer();
  for (const list of folders) {
    const a = session.addFolder(list as BlobFile[]);
    // одна модель в папке — сразу открыть
    const models = a.entries.filter((e) => session.modelExtensions.some((x) => e.path.endsWith('.' + x)));
    if (models.length === 1 && !files.length) await session.openEntry({ archive: a, entry: models[0]! });
  }
  if (files.length) await session.addFiles(files);
});

// ---------- экспорт ----------
/** Пиксели картинки: браузерные PNG/JPG приходят как ImageBitmap — читаем через холст. */
function pixels(img: DecodedImage): DecodedImage {
  if (img.rgba || !img.bitmap) return img;
  const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d')!;
  g.drawImage(img.bitmap, 0, 0);
  return { width: img.width, height: img.height, rgba: new Uint8Array(g.getImageData(0, 0, img.width, img.height).data.buffer) };
}
const exportDialog = createExportDialog({
  registry,
  status: setStatus,
  current: () => {
    const model = session.model;
    if (!model) return null;
    const hidden = new Set<number>();
    model.meshes.forEach((_, i) => { if (!viewer.renderer.isMeshVisible(i)) hidden.add(i); });
    const sourceEngine = session.format?.engine ?? session.preset.engine;
    const ctx: ExportContext = {
      preset: session.preset, sourceEngine, hidden,
      baseName: (session.main?.path?.split('/').slice(-2, -1)[0] && /^level$/i.test(session.main.name) ? session.main.path.split('/').slice(-2, -1)[0]! : (session.main?.name ?? 'model')).replace(/\.[^.]+$/, ''),
      texture: async (i): Promise<ExportTexture | null> => {
        const src = await session.textureSource(i);
        if (src && /\.dds$/i.test(src.name)) return { name: src.name, dds: new Uint8Array(await src.arrayBuffer()) };
        const r = await session.resolveTexture(i);
        return r.image ? { name: src?.name ?? '', image: pixels(r.image) } : null;
      },
    };
    return { model, ctx, engineTitle: `${session.preset.title} (${registry.engine(sourceEngine)?.title ?? sourceEngine})` };
  },
});
button('btnExport').onclick = () => exportDialog.open();

// ---------- запуск ----------
applyPreset(session.preset);
setTool('camera');
viewer.start();
start.show(prefGet(PREF_KEY));
