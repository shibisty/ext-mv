// X-Ray Engine (S.T.A.L.K.E.R.): OGF v4 + анимации OMF, архивы .db/.xdb.
import { ascii, u32le } from '../../core/binary';
import { defineEngine, type GamePreset } from '../../core/plugin';

const DB_EXTS = ['db', 'xdb', ...'0123456789'.split('').flatMap((d) => ['db' + d, 'xdb' + d]), 'dba', 'dbb', 'dbc', 'dbd'];
const ui: GamePreset['ui'] = { motionLabel: '+ .omf', invertQuat: true, archives: true, archiveExts: [...DB_EXTS, 'exe'], archiveLabel: 'Открыть .db…' };
const game = (id: string, title: string, hint: string): GamePreset => ({ id, group: 'Игры', title, engine: 'xray', formats: ['xray-ogf', 'xray-object', 'xray-level', 'xray-dm', 'xray-scene'], hint, ui, status: 'beta', markers: ['gamedata', 'fsgame.ltx'] });

export const xrayEngine = defineEngine({
  id: 'xray',
  title: 'X-Ray Engine',
  formats: [
    {
      id: 'xray-ogf',
      title: 'X-Ray OGF',
      engine: 'xray',
      extensions: ['ogf'],
      motionExtensions: ['omf', 'skl', 'skls'],
      status: 'beta',
      // первый чанк — OGF_HEADER (id 1), затем байт версии; иначе не уверены, но и не исключаем
      sniff: (h) => (u32le(h, 0) === 1 ? (h[8] === 4 ? 1 : 0.6) : 0.2),
      load: async (main, ctx) => (await import('./load')).loadOgf(main, ctx),
    },
    {
      id: 'xray-object',
      title: 'X-Ray SDK .object',
      engine: 'xray',
      extensions: ['object'],
      motionExtensions: ['omf', 'skl', 'skls'],
      status: 'beta',
      sniff: (h) => (u32le(h, 0) === 0x7777 ? 1 : 0),
      load: async (main, ctx) => (await import('./load')).loadObject(main, ctx),
    },
    {
      id: 'xray-level',
      title: 'X-Ray: скомпилированный уровень (level + level.geom)',
      engine: 'xray',
      extensions: [],
      pathPattern: /(^|\/)levels\/[^/]+\/level$/,
      status: 'beta',
      // первый чанк — заголовок уровня (id 1, 4 байта: версия и качество)
      sniff: (h) => (u32le(h, 0) === 1 && u32le(h, 4) === 4 && u32le(h, 8) !== 16 ? 0.9 : 0), // 16 — версия уровня Metro 2033 (4A)
      load: async (main, ctx) => (await import('./level')).loadLevel(main, ctx),
    },
    {
      id: 'xray-dm',
      title: 'X-Ray: деталь (.dm — трава, кусты)',
      engine: 'xray',
      extensions: ['dm'],
      status: 'beta',
      // начинается с имени шейдера (латиница, «\\», «_»)
      sniff: (h) => (/^[\w\\.-]{2,}\0/.test(ascii(h, 0, Math.min(h.length, 64))) ? 0.8 : 0),
      load: async (main) => {
        const { parseDM, dmMesh } = await import('./details');
        const { boundsOf } = await import('../../core/geometry');
        const m = parseDM(new Uint8Array(await main.arrayBuffer())), mesh = dmMesh(m, m.texture);
        return { meshes: [mesh], skeleton: null, motions: [], bounds: boundsOf([mesh]), flipZ: true, info: [`Деталь X-Ray: ${m.shader} · ${m.texture}`, `Вершин ${mesh.vertexCount}, треугольников ${m.indices.length / 3}, масштаб ${m.minScale}…${m.maxScale}`] };
      },
    },
    {
      id: 'xray-scene',
      title: 'X-Ray SDK: уровень (.level + scene_object.part)',
      engine: 'xray',
      extensions: ['level'],
      status: 'beta',
      // SDK 0.7 (ЗП) сохраняет сцену как ini; бинарные .level старых SDK пока не читаются
      sniff: (h) => (/^\s*\[(build_params|camera|guid|level_options|level_tag|version)\]/.test(ascii(h, 0, Math.min(h.length, 64))) ? 1 : 0),
      load: async (main, ctx) => (await import('./scene')).loadSceneLevel(main, ctx),
    },
  ],
  archives: [
    {
      id: 'xray-db',
      title: 'X-Ray .db / .xdb (Чистое небо, Зов Припяти)',
      engine: 'xray',
      extensions: DB_EXTS,
      // ТЧ: исполняемый файл игры — спутник архивов (из него берётся ключ таблиц файлов)
      companionExtensions: ['exe'],
      // в «Папке игры» архивы открываются сами (читается только таблица файлов): ЧН/ЗП — с заголовком, ТЧ — gamedata.db*
      openFromFolder: (h, name) => u32le(h, 0) === 0x29a || (u32le(h, 0) === 0 && /^gamedata\.db[0-9a-z]$/i.test(name)),
      // ЧН/ЗП начинаются с текстового чанка [header] (id 0x29A), ТЧ и моды — с чанка данных (id 0)
      sniff: (h) => (u32le(h, 0) === 0x29a ? 1 : u32le(h, 0) === 0 ? 0.5 : 0),
      open: async (file, siblings) => (await import('./db')).openXrayDb(file, siblings),
    },
  ],
  exporters: [
    {
      id: 'xray-sdk',
      title: 'S.T.A.L.K.E.R.: исходники X-Ray SDK 0.7',
      target: 'xray',
      description: 'Для LevelEditor и ActorEditor (Зов Припяти, SDK 0.7): геометрия .object (большие карты режутся на ячейки), сцена .level + scene_object.part, текстуры DDS + .thm — одним ZIP. Свет, секторы, AI-сетку и сборку xrLC делаете в SDK.',
      from: ['metro', 'xray'],
      fields: [
        { id: 'name', label: 'Имя уровня', type: 'text', hint: 'Латиница, цифры, «_»: rawdata/objects/gmv/<имя>, rawdata/levels/<имя>.level', default: (_m, base) => base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'level' },
        { id: 'cell', label: 'Ячейка, м', type: 'number', min: 0, step: 8, placeholder: 'авто', hint: 'Разбиение геометрии на объекты (0 — одним объектом; для карт удобно 32–64)' },
        { id: 'scale', label: 'Масштаб', type: 'number', min: 0, step: 0.01, default: 1, hint: 'Сколько метров в одной единице модели (X-Ray: 1 единица = 1 м)' },
        { id: 'instances', label: 'Объекты уровня — ссылками', type: 'checkbox', default: true, hint: 'Каждая модель объекта одним .object в props, в сцене — ссылки с позами. Снимите, чтобы влить объекты в геометрию ячеек', when: (m) => !!m.instances },
      ],
      run: async (model, v, ctx) => {
        const { exportXraySdk } = await import('./export');
        const name = String(v.name || ctx.baseName);
        const r = await exportXraySdk(model, {
          name, cell: v.cell === '' || v.cell === undefined ? undefined : +v.cell, scale: +v.scale || 1, hidden: ctx.hidden,
          texture: (i) => ctx.texture(i), xraySource: ctx.sourceEngine === 'xray', instances: v.instances !== false,
        });
        return { ...r, name: `${name}_xray_sdk` };
      },
    },
  ],
  games: [
    game('stalker-soc', 'S.T.A.L.K.E.R.: Тень Чернобыля', 'OGF v4. Анимации — внутри модели или во внешнем .omf. Архивы gamedata.db* открываются через «Папку игры» (ключ таблиц файлов берётся из bin/XR_3DA.exe вашей игры) или кнопкой «Открыть .db…» вместе с XR_3DA.exe; .xdb модов и распакованная gamedata тоже открываются. Внешние .omf из ссылок модели подключаются сами, если открыта папка gamedata или архивы; анимации торса играют вместе с ногами (выбор — «Другие части тела»). Уровни — с травой из level.details; исходники SDK: .object со скелетом и анимациями, .skl/.skls.'),
    game('stalker-cs', 'S.T.A.L.K.E.R.: Чистое небо', 'OGF v4. Откройте resources.db0–db2 (модели и текстуры) и patches/xpatch_*.db или папку gamedata. Внешние .omf из ссылок модели подключаются сами, если открыта папка gamedata или архивы; анимации торса играют вместе с ногами (выбор — «Другие части тела»). Уровни — с травой из level.details; исходники SDK: .object со скелетом и анимациями, .skl/.skls.'),
    game('stalker-cop', 'S.T.A.L.K.E.R.: Зов Припяти', 'OGF v4, в том числе 3/4-весовые вершины. Архивы .db — как у Чистого неба. Внешние .omf из ссылок модели подключаются сами, если открыта папка gamedata или архивы; анимации торса играют вместе с ногами (выбор — «Другие части тела»). Уровни — с травой из level.details; исходники SDK: .object со скелетом и анимациями, .skl/.skls.'),
  ],
});

/** Выгрузка модели/уровня в исходники X-Ray SDK (.object, .level, текстуры); модуль подгружается по требованию. */
export async function exportXraySdk(...args: Parameters<typeof import('./export').exportXraySdk>): ReturnType<typeof import('./export').exportXraySdk> {
  return (await import('./export')).exportXraySdk(...args);
}
export type { XrayExportOptions, XrayExportResult, TextureForExport } from './export';
