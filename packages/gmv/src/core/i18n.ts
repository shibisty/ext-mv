// Язык текстов библиотеки: статусы сессии, подписи текстур, слои сцены, названия пресетов, движков и вариантов экспорта.
// По умолчанию русский (тексты в плагинах написаны по-русски), английский — из словарей i18n/en.ts.
// Сведения о моделях (Model.info) и сообщения об ошибках форматов пока остаются на русском.
import { ENGINES_EN, EXPORTERS_EN, GROUPS_EN, PRESETS_EN } from '../i18n/en';
import type { EnginePlugin, ExportField, ExporterPlugin, GamePreset } from './plugin';

export type Locale = 'ru' | 'en';
let locale: Locale = 'ru';

export function setLocale(l: Locale): void { locale = l; }
export function getLocale(): Locale { return locale; }

const MSG: Record<string, { ru: string; en: string }> = {
  'session.readingArchive': { ru: 'Чтение архива {name}…', en: 'Reading archive {name}…' },
  'session.archiveError': { ru: 'Ошибка архива: {error}', en: 'Archive error: {error}' },
  'session.archives': { ru: 'Архивов: {n}', en: 'Archives: {n}' },
  'session.archivesSkipped': { ru: 'Архивов: {n}; пропущено файлов: {k} ({list})', en: 'Archives: {n}; files skipped: {k} ({list})' },
  'session.indexing': { ru: 'Индексация папки: файлов {n}', en: 'Indexing folder: {n} files' },
  'session.folderTextures': { ru: 'Индексация текстур папки…', en: 'Indexing folder textures…' },
  'session.findArchives': { ru: 'Поиск архивов в папке…', en: 'Looking for archives in the folder…' },
  'session.loadingName': { ru: 'Загрузка {name}…', en: 'Loading {name}…' },
  'session.companions': { ru: 'Запомнено: {list} — теперь выберите сами архивы', en: 'Remembered: {list} — now choose the archives themselves' },
  'session.folder': { ru: 'Папка «{name}»: файлов {n}', en: 'Folder "{name}": {n} files' },
  'session.dict': { ru: '{id} {name}: текстур {n}', en: '{id} {name}: {n} textures' },
  'session.dictErrors': { ru: ', ошибок {n} ({first})', en: ', {n} errors ({first})' },
  'session.dictError': { ru: 'Ошибка {id}: {error}', en: '{id} error: {error}' },
  'session.noModel': { ru: 'Нет файла модели, подходящего под выбранный формат', en: 'No model file matches the selected format' },
  'session.loading': { ru: 'Загрузка…', en: 'Loading…' },
  'session.loaded': { ru: 'Загружено: {name}', en: 'Loaded: {name}' },
  'session.error': { ru: 'Ошибка: {error}', en: 'Error: {error}' },
  'session.noMotionModel': { ru: 'Сначала загрузите модель, поддерживающую внешние анимации', en: 'Load a model that supports external animations first' },
  'session.motionsAdded': { ru: 'Добавлено анимаций: {n} ({name})', en: 'Animations added: {n} ({name})' },
  'session.motionError': { ru: 'Ошибка анимации: {error}', en: 'Animation error: {error}' },
  'tex.noFile': { ru: 'нет файла', en: 'no file' },
  'tex.error': { ru: 'ошибка: {error}', en: 'error: {error}' },
  'tex.normalNoFile': { ru: 'N нет файла', en: 'N no file' },
  'tex.pbrFactors': { ru: ' (множители)', en: ' (factors)' },
  'scene.model': { ru: 'Модель', en: 'Model' },
  'scene.geometry': { ru: 'Геометрия уровня', en: 'Level geometry' },
  'scene.objects': { ru: 'Объекты', en: 'Objects' },
  'scene.otherObjects': { ru: 'объекты', en: 'objects' },
  'scene.mesh': { ru: 'меш {i}', en: 'mesh {i}' },
  'scene.meshes': { ru: '{n} меш.', en: '{n} meshes' },
  'scene.tris': { ru: '{n} тр.', en: '{n} tris' },
};

/** Текст по ключу с подстановкой {параметров}. */
export function tr(key: string, params: Record<string, string | number> = {}): string {
  const m = MSG[key];
  const s = m ? m[locale] : key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
}

/** Тексты пресета игры на текущем языке. */
export function presetText(p: GamePreset): { title: string; hint: string; group: string; archiveLabel?: string; motionLabel?: string } {
  const en = locale === 'en' ? PRESETS_EN[p.id] : undefined;
  return {
    title: en?.title ?? p.title,
    hint: en?.hint ?? p.hint ?? '',
    group: locale === 'en' ? GROUPS_EN[p.group] ?? p.group : p.group,
    archiveLabel: en?.archiveLabel ?? p.ui?.archiveLabel,
    motionLabel: en?.motionLabel ?? p.ui?.motionLabel,
  };
}

export function engineTitle(e: EnginePlugin | undefined, id = ''): string {
  if (!e) return id;
  return (locale === 'en' && ENGINES_EN[e.id]) || e.title;
}

/** Название, описание и подписи полей варианта экспорта на текущем языке. */
export function exporterText(x: ExporterPlugin): { title: string; description: string; field(f: ExportField): { label: string; hint?: string; placeholder?: string } } {
  const en = locale === 'en' ? EXPORTERS_EN[x.id] : undefined;
  return {
    title: en?.title ?? x.title,
    description: en?.description ?? x.description,
    field: (f) => { const e = en?.fields?.[f.id]; return { label: e?.label ?? f.label, hint: e?.hint ?? f.hint, placeholder: e?.placeholder ?? f.placeholder }; },
  };
}
