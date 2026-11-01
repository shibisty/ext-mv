// Язык интерфейса просмотрщика: русский и английский. Статичный текст страницы размечен атрибутами
// data-i (текст), data-i-title, data-i-ph (placeholder), data-i-aria; динамический — через t().
import { setLocale, type Locale } from 'gmv';

type Dict = Record<string, string>;

const RU: Dict = {
  'start.back': 'Назад к просмотру ▸', 'start.back.t': 'Вернуться к просмотру без смены игры (Esc)',
  'start.intro': 'Выберите игру или формат. Можно сразу перетащить в окно файлы модели или папку игры — игра определится сама.',
  'start.search': 'Поиск игры или формата', 'start.none': 'Ничего не найдено', 'start.last': 'последняя выбранная',
  'badge.beta': 'бета', 'badge.bridge': 'мост',
  'top.game.t': 'Сменить игру или формат', 'top.tools': 'Инструмент', 'top.camera': 'Камера',
  'tool.camera': 'Камера', 'tool.camera.t': 'Камера: ЛКМ — вращение, ПКМ / Shift — сдвиг, колесо — масштаб (C)',
  'tool.select': 'Выбор', 'tool.select.t': 'Выбор объекта в сцене щелчком (V). Esc — снять выбор',
  'tool.rotate': 'Поворот', 'tool.rotate.t': 'Поворот выбранного объекта сцены: тянуть ЛКМ влево-вправо (R)',
  'tool.move': 'Двигать', 'tool.move.t': 'Перемещение выбранного объекта сцены: тянуть ЛКМ по полу, с Ctrl — вверх-вниз (G)',
  'view.lm': 'Карта освещения', 'view.lm.t': 'Запечённое освещение уровня (карта освещения), если оно есть в файлах уровня', 'view.lmK': 'Яркость освещения', 'view.lmK.t': 'Яркость запечённого освещения',
  'sel.dragMove': 'тяните ЛКМ по полу, с Ctrl — вверх-вниз',
  'anim.filter': 'Поиск анимации',
  'tool.rotL.t': 'Повернуть на 90° против часовой', 'tool.rotR.t': 'Повернуть на 90° по часовой',
  'cam.orbit': 'Орбита', 'cam.orbit.t': 'Орбита вокруг модели', 'cam.fly': 'Полёт',
  'cam.fly.t': 'Полёт внутри уровня: W/A/S/D — движение, E/Пробел — вверх, Q/C — вниз, Shift — быстрее, Alt — медленнее; ЛКМ — обзор, ПКМ — сдвиг, колесо — скорость',
  'cam.fit.t': 'Показать модель целиком', 'cam.speed': '{v} ед/с',
  'view': 'Вид', 'view.tex': 'Текстуры', 'view.wire': 'Каркас', 'view.skeleton': 'Скелет', 'view.grid': 'Сетка', 'view.alpha': 'Альфа-тест (вырезание)',
  'view.normals': 'Карты нормалей', 'view.normals.t': 'Карты нормалей из материалов модели или рядом с текстурой (_n, _nohq, __n_d, _normal…)',
  'view.pbr': 'PBR (шероховатость, металличность)', 'view.pbr.t': 'Шероховатость, металличность, AO и блик из материалов игры: модель GGX с отражением неба',
  'view.flipY': 'Инвертировать Y нормалей', 'view.flipY.t': 'Зелёный канал: OpenGL (Y вверх) ↔ DirectX (Y вниз). По умолчанию — как принято в игре',
  'view.zup': 'Ось Z вверх (повернуть модель)', 'view.relief': 'Рельеф', 'view.relief.t': 'Как в Normal Map Studio: XY нормали карты умножаются на силу',
  'view.clip': 'Срез сверху', 'view.clip.t': 'Убрать всё выше заданной высоты — заглянуть внутрь зданий и подземелий', 'view.clipOff': 'выкл.',
  'view.mode': 'Показ', 'view.mode0': 'освещение', 'view.mode1': 'нормали цветом', 'view.mode2': 'карта нормалей (касательные)', 'view.mode3': 'поверхность PBR (R — AO, G — шероховатость, B — металл)',
  'top.info': 'Сведения', 'top.info.t': 'Сведения о модели', 'top.export': 'Экспорт…', 'top.export.t': 'Выгрузить модель или уровень в формат другой игры или редактора',
  'left.folder': 'Папка игры…', 'left.folder.t': 'Папка игры или распакованных ресурсов', 'left.archive': 'Открыть архив…', 'left.model': 'Модель…',
  'left.tex': 'Текстуры…', 'left.tex.t': 'Файлы текстур', 'left.texDir': 'Папка текстур…', 'left.texDir.t': 'Папка текстур',
  'left.resources': 'Ресурсы', 'left.search': 'Поиск по ресурсам (например: door)', 'left.list': 'Модели в открытых архивах и папках',
  'left.archInfo': '{a} арх. · моделей {n}', 'left.shown400': ' (показано 400)', 'left.diag': 'Скопировать диагностику',
  'status.initial': 'Откройте папку игры, архив или файл модели (или перетащите их в окно).',
  'status.webgl': 'Ошибка WebGL: {error}', 'status.diagCopied': 'Диагностика скопирована в буфер обмена', 'status.diagFailed': 'Не удалось скопировать — диагностика выведена в «Сведения»',
  'drop': 'Отпустите файлы или папку',
  'right.scene': 'Сцена', 'right.layers': 'Слои сцены', 'right.meshes': 'Меши и текстуры', 'right.anim': 'Анимация', 'right.objects': 'объектов {n}',
  'anim.speed': 'Скорость', 'anim.loop': 'Цикл', 'anim.invert': 'Инвертировать вращение (подбирается автоматически)',
  'anim.loading': 'Чтение анимации {name}…', 'anim.loaded': 'Анимация: {name}', 'anim.error': 'Ошибка анимации: {error}',
  'anim.bind': '— bind-поза —', 'anim.frames': '{n} кадр.', 'anim.seconds': '{n} с',
  'mesh.pick': 'Выбрать текстуру вручную', 'info.file': 'Файл: {name}',
  'sel.mesh': 'Меш {i}: {name}', 'sel.tris': '{n} тр.', 'sel.rotateOnlyObjects': 'двигать и поворачивать можно только объекты сцены', 'sel.object': 'объект', 'sel.hidden': ' (скрыт)', 'sel.drag': 'тяните ЛКМ влево-вправо',
  'layers.toggle': 'Показать / скрыть', 'layers.more': 'ещё {n} из {left}',
  'exp.title': 'Экспорт', 'exp.close': 'Закрыть', 'exp.targets': 'Куда выгрузить', 'exp.run': 'Экспортировать', 'exp.from': 'из: {src}', 'exp.rec': 'для этой игры',
  'exp.running': 'Экспорт…', 'exp.statusRunning': 'Экспорт: {title}…', 'exp.done': 'Готово: {n} файлов, {mb} МБ — {name}.zip', 'exp.statusDone': 'Экспорт готов: {name}.zip',
  'exp.error': 'Ошибка: {error}', 'exp.statusError': 'Ошибка экспорта: {error}', 'exp.noModel': 'Сначала загрузите модель или уровень', 'exp.none': 'Для этой модели вариантов выгрузки пока нет.',
};

const EN: Dict = {
  'start.back': 'Back to viewer ▸', 'start.back.t': 'Return to the viewer without changing the game (Esc)',
  'start.intro': 'Choose a game or format. You can also drop model files or a game folder onto the window — the game is detected automatically.',
  'start.search': 'Search games and formats', 'start.none': 'Nothing found', 'start.last': 'last used',
  'badge.beta': 'beta', 'badge.bridge': 'bridge',
  'top.game.t': 'Change game or format', 'top.tools': 'Tool', 'top.camera': 'Camera',
  'tool.camera': 'Camera', 'tool.camera.t': 'Camera: LMB — rotate, RMB / Shift — pan, wheel — zoom (C)',
  'tool.select': 'Select', 'tool.select.t': 'Select an object in the scene by clicking (V). Esc — clear selection',
  'tool.rotate': 'Rotate', 'tool.rotate.t': 'Rotate the selected scene object: drag LMB left-right (R)',
  'tool.move': 'Move', 'tool.move.t': 'Move the selected scene object: drag LMB along the floor, with Ctrl — up and down (G)',
  'view.lm': 'Lightmap', 'view.lm.t': 'Baked level lighting (lightmap) when the level files have it', 'view.lmK': 'Lighting brightness', 'view.lmK.t': 'Brightness of the baked lighting',
  'sel.dragMove': 'drag LMB along the floor, with Ctrl — up and down',
  'anim.filter': 'Search animations',
  'tool.rotL.t': 'Rotate 90° counter-clockwise', 'tool.rotR.t': 'Rotate 90° clockwise',
  'cam.orbit': 'Orbit', 'cam.orbit.t': 'Orbit around the model', 'cam.fly': 'Fly',
  'cam.fly.t': 'Fly inside the level: W/A/S/D — move, E/Space — up, Q/C — down, Shift — faster, Alt — slower; LMB — look, RMB — pan, wheel — speed',
  'cam.fit.t': 'Show the whole model', 'cam.speed': '{v} u/s',
  'view': 'View', 'view.tex': 'Textures', 'view.wire': 'Wireframe', 'view.skeleton': 'Skeleton', 'view.grid': 'Grid', 'view.alpha': 'Alpha test (cut-out)',
  'view.normals': 'Normal maps', 'view.normals.t': 'Normal maps from model materials or next to the texture (_n, _nohq, __n_d, _normal…)',
  'view.pbr': 'PBR (roughness, metalness)', 'view.pbr.t': 'Roughness, metalness, AO and specular from game materials: GGX with sky reflections',
  'view.flipY': 'Flip normal map Y', 'view.flipY.t': 'Green channel: OpenGL (Y up) ↔ DirectX (Y down). Default follows the game',
  'view.zup': 'Z axis up (rotate the model)', 'view.relief': 'Relief', 'view.relief.t': 'As in Normal Map Studio: normal XY is multiplied by the strength',
  'view.clip': 'Cut from above', 'view.clip.t': 'Hide everything above a height — look inside buildings and underground', 'view.clipOff': 'off',
  'view.mode': 'Display', 'view.mode0': 'lighting', 'view.mode1': 'normals as colour', 'view.mode2': 'normal map (tangent space)', 'view.mode3': 'PBR surface (R — AO, G — roughness, B — metal)',
  'top.info': 'Info', 'top.info.t': 'Model information', 'top.export': 'Export…', 'top.export.t': 'Export the model or level to another game or editor',
  'left.folder': 'Game folder…', 'left.folder.t': 'Game folder or unpacked resources', 'left.archive': 'Open archive…', 'left.model': 'Model…',
  'left.tex': 'Textures…', 'left.tex.t': 'Texture files', 'left.texDir': 'Texture folder…', 'left.texDir.t': 'Texture folder',
  'left.resources': 'Resources', 'left.search': 'Search resources (e.g. door)', 'left.list': 'Models in opened archives and folders',
  'left.archInfo': '{a} arch. · {n} models', 'left.shown400': ' (400 shown)', 'left.diag': 'Copy diagnostics',
  'status.initial': 'Open a game folder, an archive or a model file (or drop them onto the window).',
  'status.webgl': 'WebGL error: {error}', 'status.diagCopied': 'Diagnostics copied to the clipboard', 'status.diagFailed': 'Could not copy — diagnostics are shown in "Info"',
  'drop': 'Drop files or a folder',
  'right.scene': 'Scene', 'right.layers': 'Scene layers', 'right.meshes': 'Meshes and textures', 'right.anim': 'Animation', 'right.objects': '{n} objects',
  'anim.speed': 'Speed', 'anim.loop': 'Loop', 'anim.invert': 'Invert rotation (chosen automatically)',
  'anim.loading': 'Reading animation {name}…', 'anim.loaded': 'Animation: {name}', 'anim.error': 'Animation error: {error}',
  'anim.bind': '— bind pose —', 'anim.frames': '{n} frames', 'anim.seconds': '{n} s',
  'mesh.pick': 'Choose a texture manually', 'info.file': 'File: {name}',
  'sel.mesh': 'Mesh {i}: {name}', 'sel.tris': '{n} tris', 'sel.rotateOnlyObjects': 'only scene objects can be moved and rotated', 'sel.object': 'object', 'sel.hidden': ' (hidden)', 'sel.drag': 'drag LMB left-right',
  'layers.toggle': 'Show / hide', 'layers.more': '{n} more of {left}',
  'exp.title': 'Export', 'exp.close': 'Close', 'exp.targets': 'Export target', 'exp.run': 'Export', 'exp.from': 'from: {src}', 'exp.rec': 'for this game',
  'exp.running': 'Exporting…', 'exp.statusRunning': 'Export: {title}…', 'exp.done': 'Done: {n} files, {mb} MB — {name}.zip', 'exp.statusDone': 'Export ready: {name}.zip',
  'exp.error': 'Error: {error}', 'exp.statusError': 'Export error: {error}', 'exp.noModel': 'Load a model or level first', 'exp.none': 'No export targets for this model yet.',
};

export const DICTS: Record<Locale, Dict> = { ru: RU, en: EN };
let lang: Locale = 'ru';
const listeners: Array<() => void> = [];

export const getLang = (): Locale => lang;

export function t(key: string, params: Record<string, string | number> = {}): string {
  const s = DICTS[lang][key] ?? RU[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
}

/** Перевести размеченный статичный текст внутри root. */
export function applyDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i]').forEach((el) => { el.textContent = t(el.dataset.i!); });
  root.querySelectorAll<HTMLElement>('[data-i-title]').forEach((el) => { el.title = t(el.dataset.iTitle!); });
  root.querySelectorAll<HTMLInputElement>('[data-i-ph]').forEach((el) => { el.placeholder = t(el.dataset.iPh!); });
  root.querySelectorAll<HTMLElement>('[data-i-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.iAria!)); });
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLSelectElement>('select.lang').forEach((s) => { s.value = lang; });
}

/** Сменить язык: библиотека, разметка страницы, подписчики (перерисовка динамических частей). */
export function setLang(l: Locale): void {
  lang = l;
  setLocale(l);
  applyDom();
  for (const fn of listeners) fn();
}
export const onLangChange = (fn: () => void): void => { listeners.push(fn); };

/** Язык по умолчанию: сохранённый выбор, иначе язык браузера (русский/украинский/белорусский — русский, остальные — английский). */
export function detectLang(saved: string | null): Locale {
  if (saved === 'ru' || saved === 'en') return saved;
  const nav = (globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language ?? 'en').toLowerCase();
  return /^(ru|uk|be)\b/.test(nav) ? 'ru' : 'en';
}
