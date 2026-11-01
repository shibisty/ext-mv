# Архитектура Game Model Viewer (v12)

Проект разделён на две части:

- **`packages/gmv`** — библиотека «gmv». В ней ядро с API плагинов, движки как отдельные модули и WebGL2-рендерер. Библиотека не зависит от расширения. Её можно подключать в других проектах на TS/JS (ES-модули) и прямо на странице через `<script>` (`dist/gmv.iife.js`, глобальный объект `GMV`).
- **`apps/extension`** — браузерное расширение для Chrome и Firefox. Это тонкий интерфейс поверх `gmv`.

```
ext-mv/
├─ packages/gmv/
│  ├─ src/core/            ядро без DOM: типы, плагины, реестр, сессия, архивы, кодеки, математика
│  ├─ src/engines/<id>/    движки: index.ts (лёгкое описание) + парсеры (грузятся лениво)
│  ├─ src/renderer/        WebGL2: Renderer, OrbitCamera, ModelViewer
│  ├─ src/standalone.ts    сборка «всё в одном» (GMV.mount)
│  └─ test/                модульные тесты на синтетических файлах + настоящий assimpjs
├─ apps/extension/
│  ├─ viewer.html, src/viewer/   страница просмотрщика (UI)
│  ├─ src/background.ts          клик по значку -> вкладка просмотрщика
│  ├─ manifests/                 base.json + chrome.json / firefox.json
│  ├─ scripts/                   build.mjs (Vite -> dist/chrome, dist/firefox, zip), dev.mjs (watch), zip.mjs,
│  │                             manifest.mjs, assimp-lib.mjs + patch-assimp.mjs
│  ├─ test/                      тесты сборки (zip, манифесты, патч assimpjs)
│  └─ e2e/                       Chromium + собранное расширение (Playwright)
├─ docs/                         ARCHITECTURE.md, ROADMAP.md
└─ legacy/                       исходники v11 (JS) для сверки
```

## Слои

```
 UI (расширение, страница, другое приложение)
   │  события status/preset/model/motions/textures
   ▼
 ViewerSession ── TextureLibrary ── Archive[] (zip, bsa, vpk, img, pak, bigf, pbo, folder)
   │                  ▲
   │ detect()         │ resolveTexture(): правила движка (.vmt, .mtr, .mtl, .mat, M_->T_)
   ▼                  │
 Registry ── EnginePlugin[] ── FormatPlugin / ArchivePlugin / ImageCodec / TextureDictionaryPlugin / MaterialResolver / GamePreset
   │
   ▼
 Model { meshes, skeleton: SkeletonRuntime, motions, bounds, info, animate?, loadMotions? }
   │
   ▼
 ModelViewer -> Renderer (WebGL2, скининг в шейдере)
```

**Ядро не знает ни одного игрового формата.** Всё специфичное лежит в плагинах. В ядре есть только общие вещи: ZIP, «Папка игры», zlib/LZ4/LZO, DDS/TGA/PCX/BC7, матрицы, нормали, `NodeSkeleton`, сессия.

## Интерфейс расширения (`core/plugin.ts`)

```ts
interface EnginePlugin {
  id: string; title: string;
  formats?: FormatPlugin[];            // модели
  archives?: ArchivePlugin[];          // контейнеры
  codecs?: ImageCodec[];               // текстуры (VTF…)
  dictionaries?: TextureDictionaryPlugin[]; // словари текстур (TXD, YTD); parse может быть async
  materials?: MaterialResolver[];      // текстура по имени материала для любого формата (.mtr, .mat, *.materials.json)
  games?: GamePreset[];                // пресеты игр для списка
}

interface FormatPlugin {
  id; title; engine; extensions; motionExtensions?; status?: 'stable'|'beta'|'bridge';
  pathPattern?: RegExp;                                 // модели по пути без своего расширения: MeshCache/*, classes/trucks/*.xml
  sniff?(head: Uint8Array, name): number;               // 0..1 по первым 256 байтам; 0 — «точно не я»
  load(main: VFile, ctx: LoadContext): Promise<Model>;  // ctx.files, ctx.archives, ctx.sibling(), ctx.readPath()
  resolveTexture?(mesh, model, lib: TextureLibrary): Promise<VFile | null>;
  afterLoad?(ctx: AfterLoadContext): Promise<void>;     // одноимённый .txd, анимации из папки…
}
```

Правила:

1. `index.ts` движка лёгкий. В нём описание, сигнатуры и пресеты, а парсер подключается через `await import('./parser')`. Поэтому в расширении код движка загружается только при первом открытии его формата.
2. Движок импортирует только `core/*`, другие движки не импортирует. Исключение — HPL, он использует мост assimp.
3. Пресет может ссылаться на форматы другого движка. Например, `source2` открывает glTF через `assimp`.
4. Загрузчик возвращает `Model` единого вида: Float32 атрибуты, по 4 кости и 4 веса на вершину, индексы Uint16 или Uint32.

### Автоопределение (`Registry.detect`)

1. Кандидаты подбираются по расширению. Если подходящего расширения нет, проверяются сигнатуры всех форматов: файл без расширения тоже откроется.
2. Каждый кандидат получает оценку. Совпадение расширения даёт 0.5, `sniff` добавляет до 0.5, принадлежность к текущему пресету — ещё 0.25. Если `sniff` вернул 0, кандидат исключается.
3. Результат содержит формат, уверенность и список кандидатов. Список пригодится для будущего окна выбора из 2–3 вариантов.

Так решаются конфликты расширений. `.mdl` бывает Quake (`IDPO`) и Valve (`IDST`), `.pak` бывает Quake (`PACK`) и CryEngine (ZIP). Если загружается модель чужого пресета, сессия сама переключает пресет.

### Сессия (`ViewerSession`)

Сессия хранит состояние без DOM: пресет, архивы, текстуры, модель, анимации и ручные текстуры мешей. Метод `addFiles()` раскладывает набор файлов на архивы, словари, картинки, анимации и модель. Последняя неудачная загрузка остаётся в `lastFailure`, по ней строится `buildDiagnostics()`: файл, формат, сигнатура и hex-дамп заголовка.

### Рендерер

`Renderer` — это порт прежнего `renderer.js` на TypeScript. Скининг выполняется в вершинном шейдере, матрицы костей хранятся в RGBA32F-текстуре. Добавлены `dispose()`, `setMeshVisible()` и темы (`DARK_THEME`, `LIGHT_THEME`). `ModelViewer` объединяет холст, камеру с мышью, цикл анимации и проигрывание (`state.speed/loop/invert`).

## Расширение: Chrome и Firefox

| | Chrome | Firefox |
|---|---|---|
| Фон | `background.service_worker` | `background.scripts` (MV3 в Firefox без service worker) |
| Идентификатор | — | `browser_specific_settings.gecko.id` |
| Минимальная версия | 116 | 115 (ESR), нужен `DecompressionStream('deflate-raw')` |
| Сбор данных | — | `data_collection_permissions: { required: ["none"] }` |
| CSP | `script-src 'self' 'wasm-unsafe-eval'` | то же |

Один бандл Vite обслуживает оба браузера, различаются только манифесты (`manifests/*.json` сливаются с `base.json`). `scripts/build.mjs` выполняет такие шаги:

1. Vite собирает бандл в `dist/.build`.
2. Пакет `assimpjs` копируется в `lib/` и патчится (см. ниже).
3. Получаются папки `dist/chrome` и `dist/firefox`, после копирования проверяется, что все файлы на месте и совпадают по размеру.
4. Архивы `dist/gmv-<browser>-<version>.zip` собирает собственный ZIP-writer. Пути в них всегда через «/», чего требует линтер AMO.

### assimpjs и CSP

Найдено при переносе: embind в assimpjs собирает функции через `new Function`. CSP страниц MV3 это запрещает, поэтому мост assimp (glTF/FBX/OBJ/DAE) в расширении **не мог работать** («Refused to evaluate a string as JavaScript»). `scripts/patch-assimp.mjs` при сборке заменяет `craftInvokerFunction` и `craftEmvalAllocator` на замыкания, как это делает сам emscripten с `-sDYNAMIC_EXECUTION=0`. Если в новой версии assimpjs код изменится, сборка упадёт с понятной ошибкой. Патч проверяется тремя способами: в Node, e2e-тестом в Chromium (OBJ открывается под CSP расширения) и `web-ext lint` (0 предупреждений).

### Сборные модели и виртуальные файлы

Некоторые игры описывают модель не одним файлом, а конфигом, который ссылается на десятки других. Такие загрузчики получают `ctx.archives` и собирают модель сами:

- **BeamNG** (`beamng-pc`): `.pc` → дерево слотов `jbeam` → `flexbodies` из `.dae` (`engines/collada` — быстрый разбор с выбором узлов по имени) с `pos/rot/scale` и `nodeOffset`.
- **Arma** (`arma-class`): архив PBO при открытии добавляет **виртуальные файлы** `config/<вид>/<класс>.armacfg` (по одному на класс CfgVehicles/CfgWeapons). Их видно в списке моделей; загрузчик сливает `config.bin` всех открытых PBO (`rap.ts`, наследование классов) и собирает солдата (форма + `linkedItems`) или оружие (обвес в прокси слотов).
- **GTA V** (`rage-yft`): у персонажа `.yft` содержит только скелет — модель собирается из компонентов `*_000_*.ydd` рядом.
- **MudRunner / SnowRunner** (`spintires-truck`): `classes/trucks/*.xml` → кузов, колёса (`_templates`, `WheelsSet`), навесные модели.

## Инструменты

- `npm run smoke -- <папки|архивы> [--limit N] [--budget сек] [--only ext,…]` — прогон всех моделей через `ViewerSession` в Node, отчёт по форматам и ненайденным текстурам.
- `npm run peek -- <папки|архивы> --load <путь> [--preset id] [--ppm файл]` — одна модель: сведения, текстуры по мешам и программный рендер в PPM (`tools/render-ppm.ts`) для проверки без браузера.

## Тесты

- `npm test` — Vitest, Node. Покрыты ядро, кодеки, картинки, архивы, реестр и автоопределение, сессия (сценарии «архив → модель → текстура»), форматы на синтетических файлах (`test/helpers/fixtures.ts`), мост assimp на **настоящем** assimpjs, сборка (zip, манифесты, патч).
- `npm run test:e2e` — собирает расширение и запускает Chromium без экрана (SwiftShader WebGL). Проверяет загрузку расширения, MD2 с DDS-текстурой и анимацией, OBJ через assimp, PBO Arma (класс оружия из config.bin, PAA), GTA V `.ydr` (deflate в браузере), кнопку диагностики, а также что на холсте действительно есть отрисовка.
- `npm run lint:firefox` — `web-ext lint` для `dist/firefox`.
- `npm run check` — всё вместе.

## Как добавить движок

1. Создайте `packages/gmv/src/engines/<id>/index.ts` с `defineEngine({...})`: форматы, архивы, пресеты, `sniff`.
2. Положите парсер рядом и подключайте его лениво из `load`.
3. Добавьте движок в `engines/index.ts` (`allEngines`). От места в списке зависит порядок пресетов.
4. Напишите построитель синтетического файла в `test/helpers/` (`fixtures.ts`, `arma.ts`, `rage.ts`, `spintires.ts`) и тест. Тест целостности реестра сам проверит id, ссылки пресетов на форматы и что у формата есть расширение или `pathPattern`.
5. Проверьте на настоящих файлах: `npm run smoke` и `npm run peek -- … --ppm out.ppm`.
