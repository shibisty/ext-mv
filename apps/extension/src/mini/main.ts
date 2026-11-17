// Быстрый просмотр в попапе и боковой панели: бросить файлы (или открыть кнопкой) и покрутить модель или карту в небольшом окне.
// Игра выбирается сама по файлу («Авто»), если файл подходит нескольким — можно переключить «Читать как».
// Открытое сохраняется (shared/workspace.ts): попап, боковая панель и полный просмотрщик продолжают с того же места.
import { createRegistry, presetText, ViewerSession, type ArchiveItem, type BlobFile, type Motion, type VFile } from '@gmvjs/core';
import { extOf } from '@gmvjs/core/binary';
import { allEngines } from '@gmvjs/all';
import { configureAssimp } from '@gmvjs/assimp';
import { ModelViewer } from '@gmvjs/renderer';
import { attachDrop, type DropResult } from '../viewer/drop';
import { applyDom, initLang, onLangChange, t } from '../viewer/i18n';
import { hasSidePanel, isFirefox, openSidePanel, viewerUrl } from '../shared/ext';
import { bestPreset, isModelLike, readOptions } from '../shared/detect';
import {
  clearWorkspace, loadWorkspace, markHandoff, mergeSources, needsAccess, requestAccess, restoreInto, saveWorkspace, sourceName, takeHandoff,
  type Source, type Workspace,
} from '../shared/workspace';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error('missing element #' + id);
  return el as T;
};
const prefGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const prefSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } };
// те же ключи, что у полного просмотрщика: язык и последняя игра общие
const PREF_KEY = 'fmt', AUTO_KEY = 'auto';
await initLang(prefGet('lang'));

const view = document.body.dataset.view === 'popup' ? 'popup' : 'side';
const presetSel = $<HTMLSelectElement>('preset'), motionSel = $<HTMLSelectElement>('motion');
const listSel = $<HTMLSelectElement>('listSel'), listFilter = $<HTMLInputElement>('listFilter');
const fileInput = $<HTMLInputElement>('file');

function setStatus(text: string, err = false): void {
  const s = $('status');
  s.textContent = text;
  s.title = text;
  s.className = 'status' + (err ? ' err' : '');
}

configureAssimp({ baseUrl: new URL('lib/', location.href).href, scripts: ['assimpjs.js', 'assimpjs-all.js'] });
const registry = createRegistry(allEngines);
const session = new ViewerSession(registry, prefGet(PREF_KEY));
let viewer: ModelViewer;
try {
  viewer = new ModelViewer($<HTMLCanvasElement>('gl'));
} catch (e) {
  setStatus(t('status.webgl', { error: (e as Error).message }), true);
  throw e;
}
(globalThis as unknown as { __gmvViewer: ModelViewer }).__gmvViewer = viewer;

// ---------- рабочий набор: что открыто (переживает закрытие попапа и переход в другое окно) ----------
let ws: Workspace = { at: 0, preset: session.preset.id, auto: true, sources: [], skipped: [] };
let saving = Promise.resolve();
function persist(): Promise<void> {
  ws.preset = session.preset.id;
  ws.auto = auto;
  if (!ws.sources.length) return saving;
  const snapshot = { ...ws };
  saving = saving.then(() => saveWorkspace(snapshot)).then(() => undefined, () => undefined);
  return saving;
}
function addSources(add: Source[]): void {
  const m = mergeSources(ws.sources, add);
  ws.sources = m.sources;
  ws.skipped = [...new Set([...ws.skipped, ...m.skipped])].filter((n) => !m.sources.some((s) => sourceName(s) === n));
}

// ---------- игра / формат: «Авто» или выбранная ----------
let auto = prefGet(AUTO_KEY) !== '0';
function fillPresets(): void {
  presetSel.textContent = '';
  const a = document.createElement('option');
  a.value = '';
  presetSel.append(a);
  for (const group of [...new Set(registry.games.map((g) => g.group))]) {
    const games = registry.games.filter((g) => g.group === group);
    const og = document.createElement('optgroup');
    og.label = presetText(games[0]!).group;
    for (const g of games) {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = presetText(g).title;
      og.append(o);
    }
    presetSel.append(og);
  }
  syncPreset();
}
function syncPreset(): void {
  const a = presetSel.options[0]!;
  a.textContent = session.main ? t('mini.autoNow', { title: presetText(session.preset).title }) : t('mini.auto');
  presetSel.value = auto ? '' : session.preset.id;
}
presetSel.onchange = () => {
  auto = presetSel.value === '';
  prefSet(AUTO_KEY, auto ? '1' : '0');
  if (!auto) {
    session.setPreset(presetSel.value);
    if (session.main) void reload();
  }
  syncPreset();
  void persist();
};
session.on('preset', (p) => {
  prefSet(PREF_KEY, p.id);
  syncPreset();
  refreshList();
});
/** Перед открытием: в режиме «Авто» выбрать игру по самому уверенному определению файлов. */
async function autoPick(files: ReadonlyArray<BlobFile | VFile>): Promise<void> {
  if (!auto) return;
  const p = await bestPreset(registry, files);
  if (p && p.id !== session.preset.id) session.setPreset(p.id);
}

// ---------- «Читать как»: файл подходит нескольким играм или форматам ----------
async function refreshReadAs(): Promise<void> {
  const box = $('readAs'), main = session.main;
  const opts = main ? await readOptions(registry, main) : [];
  if (session.main !== main) return;
  box.textContent = '';
  box.hidden = opts.length < 2;
  if (box.hidden) return;
  const lbl = document.createElement('span');
  lbl.textContent = t('mini.readAs');
  box.append(lbl);
  for (const g of opts) {
    const b = document.createElement('button');
    b.textContent = presetText(g).title;
    b.title = presetText(g).hint;
    b.dataset.preset = g.id;
    b.className = g.id === session.preset.id ? 'on' : '';
    b.onclick = () => { if (g.id !== session.preset.id) { session.setPreset(g.id); void reload(); } };
    box.append(b);
  }
}
/** Те же файлы ещё раз — с другой игрой. */
let lastFiles: BlobFile[] = [];
async function reload(): Promise<void> {
  const main = session.main ?? session.lastFailure?.file;
  if (!main) return;
  await session.loadModel([main, ...lastFiles.filter((f) => f !== main && isModelLike(registry, f.name))]);
  void persist();
}

// ---------- модель ----------
async function applyTextures(): Promise<void> {
  const m = session.model;
  if (!m) return;
  await Promise.all(m.meshes.map(async (_, i) => {
    const r = await session.resolveTexture(i);
    if (session.model !== m) return;
    if (r.image) viewer.setTexture(i, r.image);
    const n = await session.resolveNormal(i, r.source);
    if (session.model !== m) return;
    viewer.setNormalMap(i, n.image, n.packing);
    const sf = await session.resolveSurface(i, r.source);
    if (session.model !== m) return;
    viewer.setSurface(i, sf.image);
  }));
}

session.on('model', ({ model }) => {
  document.body.classList.add('loaded');
  $('btnFit').hidden = false;
  $('btnClear').hidden = false;
  viewer.setModel(model);
  syncPreset();
  void applyTextures();
  void refreshReadAs();
});
session.on('textures', () => void applyTextures());
session.on('status', ({ text, error }) => setStatus(text, error));
session.on('progress', (p) => {
  if (!p) return;
  const pct = p.total ? ' ' + t('progress.percent', { p: Math.round(((p.done ?? 0) / p.total) * 100) }) : '';
  setStatus(p.text + pct);
});
$('btnFit').onclick = () => viewer.fit();

// ---------- анимации ----------
const motionLabel = (m: Motion): string => (m.load ? m.name : `${m.name} (${m.frames ? t('anim.frames', { n: m.frames }) : t('anim.seconds', { n: m.duration.toFixed(2) })})`);
session.on('motions', (list) => {
  motionSel.textContent = '';
  const add = (v: number, text: string) => { const o = document.createElement('option'); o.value = String(v); o.textContent = text; motionSel.append(o); };
  add(-1, t('anim.bind'));
  list.forEach((m, i) => add(i, motionLabel(m)));
  motionSel.hidden = list.length === 0;
});
motionSel.onchange = async () => {
  const i = +motionSel.value, model = session.model;
  let m = i >= 0 ? session.motions[i] ?? null : null;
  if (m?.load) {
    try {
      setStatus(t('anim.loading', { name: m.name }));
      m = { ...(await m.load()), source: m.source };
      if (session.model !== model) return;
      session.motions[i] = m;
      setStatus(t('anim.loaded', { name: m.name }));
    } catch (e) {
      setStatus(t('anim.error', { error: (e as Error).message }), true);
      return;
    }
  }
  viewer.setMotion(m);
  viewer.state.playing = true;
};

// ---------- модели в папке или архиве ----------
let listItems: ArchiveItem[] = [];
const LIST_LIMIT = 300;
/** Модели всех архивов: в режиме «Авто» — любых игр (игра выберется при открытии), иначе — выбранной. */
function listModels(filter: string): { items: ArchiveItem[]; total: number } {
  if (!auto) return session.archiveModels(filter, LIST_LIMIT);
  const q = filter.trim().toLowerCase(), exts = new Set(registry.modelExtensions.filter((e) => !registry.motionOnlyExtensions.includes(e)));
  const items: ArchiveItem[] = [];
  let total = 0;
  for (const archive of session.archives) {
    for (const entry of archive.entries) {
      if (!exts.has(extOf(entry.path))) continue;
      total++;
      if (items.length < LIST_LIMIT && (!q || entry.path.toLowerCase().includes(q))) items.push({ archive, entry });
    }
  }
  return { items, total };
}
function refreshList(): void {
  const { items, total } = listModels(listFilter.value);
  listItems = items;
  listSel.textContent = '';
  items.forEach((it, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = it.entry.path;
    o.title = it.entry.path;
    listSel.append(o);
  });
  // total — все модели архивов (без учёта поиска), items — найденные, не больше LIST_LIMIT
  $('listInfo').textContent = items.length >= LIST_LIMIT ? t('mini.foundMore', { n: total, k: items.length }) : t('mini.found', { n: items.length });
  // список нужен, когда есть из чего выбрать: несколько моделей в папке или архиве
  $('list').hidden = total < 2 && !listFilter.value;
}
async function openItem(it: ArchiveItem): Promise<void> {
  await autoPick([it.archive.fileOf(it.entry)]);
  lastFiles = [];
  await session.openEntry(it);
  ws.open = { archive: it.archive.name, path: it.entry.path };
  void persist();
}
listFilter.oninput = refreshList;
listSel.onchange = () => {
  const it = listItems[+listSel.value];
  if (it) void openItem(it);
};
session.on('archives', refreshList);

// ---------- открытие файлов ----------
async function openFolder(list: BlobFile[], alone: boolean): Promise<void> {
  const a = await session.addFolderAsync(list);
  await session.openFolderArchives(a);
  if (!alone) return;
  const models = a.entries.filter((e) => isModelLike(registry, e.path) && !!extOf(e.path));
  if (models.length === 1) await openItem({ archive: a, entry: models[0]! });
}
async function openFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  await autoPick(files);
  lastFiles = files;
  ws.open = undefined;
  await session.addFiles(files);
}
async function onDrop({ files, folders, handles }: DropResult): Promise<void> {
  // в другие окна — по дескрипторам (Chromium, без копирования), иначе копии файлов
  if (handles.length) addSources(handles.map((h): Source => (h.kind === 'directory' ? { kind: 'dir', handle: h as FileSystemDirectoryHandle } : { kind: 'handle', handle: h as FileSystemFileHandle })));
  else addSources([...files.map((file): Source => ({ kind: 'file', file })), ...folders.map((list): Source => ({ kind: 'folder', name: list[0]?.webkitRelativePath?.split('/')[0] || 'folder', files: list as File[] }))]);
  for (const list of folders) await openFolder(list as BlobFile[], !files.length);
  await openFiles(files);
  await persist();
}
attachDrop(window, $('drop'), (r) => void onDrop(r), (n) => setStatus(t('progress.walk', { n })));

type Picker = (o: { multiple: boolean }) => Promise<FileSystemFileHandle[]>;
async function pickFiles(): Promise<void> {
  if (pickerClosesPopup && !sideNa) { toSidePanel(); return; }
  // Chromium, боковая панель: дескрипторы — открытое переживает переход в другое окно без копирования.
  // В попапе — обычный выбор файлов: окно выбора File System Access может закрыть попап.
  const picker = view === 'side' ? (window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker : undefined;
  if (picker) {
    try {
      const handles = await picker({ multiple: true });
      const files = await Promise.all(handles.map((h) => h.getFile()));
      addSources(handles.map((handle): Source => ({ kind: 'handle', handle })));
      await openFiles(files);
      await persist();
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      /* не вышло — обычный выбор файлов */
    }
  }
  fileInput.value = '';
  fileInput.click();
}
fileInput.onchange = async () => {
  const files = Array.from(fileInput.files ?? []);
  addSources(files.map((file): Source => ({ kind: 'file', file })));
  await openFiles(files);
  await persist();
};
$('btnOpen').onclick = () => void pickFiles();
$('btnOpen2').onclick = () => void pickFiles();
$('btnClear').onclick = async () => {
  await clearWorkspace().catch(() => undefined);
  location.reload();
};

// ---------- другие окна: боковая панель и полный просмотрщик ----------
const sideNa = !hasSidePanel();
// Firefox закрывает попап, когда открывается окно выбора файла: там «Открыть» ведёт в боковую панель
const pickerClosesPopup = view === 'popup' && isFirefox();
let windowId: number | undefined;
// Chrome открывает боковую панель только синхронно в обработчике щелчка — окно узнаём заранее
chrome.windows?.getCurrent?.().then((w) => { windowId = w.id; }).catch(() => { /* нет API окон */ });

function toSidePanel(): void {
  markHandoff('side');
  openSidePanel(windowId).then(() => { if (view === 'popup') window.close(); }).catch(() => setStatus(t('mini.side.na'), true));
}
const btnSide = $<HTMLButtonElement>('btnSide');
btnSide.hidden = view !== 'popup' || sideNa;
btnSide.onclick = toSidePanel;

$('btnFull').onclick = async () => {
  await persist();
  await chrome.tabs.create({ url: viewerUrl(ws.sources.length > 0) });
  if (view === 'popup') window.close();
};

function viewHint(): void {
  $('viewHint').textContent = view !== 'popup' || sideNa ? '' : pickerClosesPopup ? t('mini.ff.hint') : t('mini.popup.hint');
  // без боковой панели перетаскивание остаётся единственным способом и в попапе — тогда и заголовок про него
  const head = document.querySelector<HTMLElement>('#empty b');
  if (head && view === 'popup') head.textContent = t(sideNa ? 'mini.drop' : 'mini.popup.head');
}

// ---------- продолжить с того же места ----------
async function restore(w: Workspace): Promise<void> {
  $('resume').hidden = true;
  ws = { ...w, sources: [...w.sources], skipped: [...w.skipped] };
  auto = w.auto;
  syncPreset();
  setStatus(t('mini.restoring', { names: names(w) }));
  try {
    lastFiles = (await restoreInto(session, w, (n) => setStatus(t('progress.walk', { n })))).files;
  } catch (e) {
    setStatus(t('mini.restoreFailed', { error: (e as Error).message }), true);
  }
}
const names = (w: Workspace): string => {
  const list = w.sources.map(sourceName);
  return list.slice(0, 3).join(', ') + (list.length > 3 ? ' +' + (list.length - 3) : '');
};
async function startup(): Promise<void> {
  const w = await loadWorkspace().catch(() => null);
  if (!w) return;
  const explicit = view === 'side' && takeHandoff('side');
  const heavy = w.sources.some((s) => s.kind === 'dir' || s.kind === 'folder');
  const ask = await needsAccess(w).catch(() => true);
  // большие папки при каждом открытии попапа не перечитываем — по кнопке; явный переход — сразу
  if (!ask && (explicit || !heavy)) { await restore(w); return; }
  const b = $<HTMLButtonElement>('resume');
  b.textContent = t(ask ? 'mini.access' : 'mini.resume', { names: names(w) });
  b.hidden = false;
  b.onclick = async () => {
    if (ask && !(await requestAccess(w).catch(() => false))) { setStatus(t('mini.accessDenied'), true); return; }
    await restore(w);
  };
}

// ---------- запуск ----------
function texts(): void {
  applyDom();
  fillPresets();
  viewHint();
  void refreshReadAs();
}
onLangChange(texts);
texts();
viewer.start();
await startup();
