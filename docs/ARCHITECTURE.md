# Архитектура Game Model Viewer (v12)

Проект разделён на два репозитория, которые лежат рядом:

- **`gmv`** — библиотека, пакеты `@gmvjs/*` (ядро с API плагинов, по пакету на движок, WebGL2-рендерер). Её устройство — в `gmv/docs/ARCHITECTURE.md`, как она выделялась отсюда — в `gmv/docs/SPLIT.md`.
- **`ext-mv`** (этот репозиторий) — браузерное расширение для Chrome и Firefox: тонкий интерфейс поверх `@gmvjs/core`, `@gmvjs/renderer` и `@gmvjs/all`.

```
<папка>/
├─ gmv/                          библиотека @gmvjs/*
└─ ext-mv/
   ├─ apps/extension/
   │  ├─ viewer.html, src/viewer/   страница просмотрщика (UI)
   │  ├─ popup.html, sidebar.html,  быстрый просмотр: попап на значке и боковая панель (одна страница, data-view)
   │  │  src/mini/
   │  ├─ src/shared/                ext.ts (боковая панель Chrome/Firefox), detect.ts (автовыбор игры),
   │  │                             workspace.ts (открытые ресурсы между попапом, панелью и вкладкой)
   │  ├─ src/viewer/locales/        50 языков интерфейса (en и ru — в i18n.ts)
   │  ├─ src/background.ts          меню на значке: полный просмотрщик во вкладке, боковая панель
   │  ├─ manifests/                 base.json + chrome.json / firefox.json
   │  ├─ scripts/                   build.mjs (Vite -> dist/chrome, dist/firefox, zip), dev.mjs (watch), zip.mjs,
   │  │                             manifest.mjs, assimp-lib.mjs + patch-assimp.mjs
   │  ├─ test/                      тесты сборки и языков (zip, манифесты, патч assimpjs, словари)
   │  └─ e2e/                       Chromium + собранное расширение (Playwright)
   ├─ docs/                         ARCHITECTURE.md, ROADMAP.md
   └─ legacy/                       исходники v11 (JS) для сверки
```

## Как расширение берёт библиотеку

- Пакеты `@gmvjs/*` ставятся из npm (`apps/extension/package.json`: `@gmvjs/core`, `@gmvjs/renderer`, `@gmvjs/all`, `@gmvjs/assimp`, `@gmvjs/xray-v1`), используется их сборка `dist`. Особых условий разрешения (`gmv-source`, `preserveSymlinks`) больше нет.
- Тестовые помощники библиотеки (`@gmvjs/test-utils`) в npm не публикуются: e2e-тесты берут их копию из `apps/extension/e2e/fixtures/` (обновляется копированием `packages/test-utils/src` из репозитория gmv). Им нужен `@gmvjs/rage` — он в `devDependencies`.
- Чтобы проверить неопубликованное изменение библиотеки: собрать пакет в gmv (`npm run build`) и поставить его из папки (`npm i ../gmv/packages/<пакет>`) или из `npm pack`.

## Расширение: Chrome и Firefox

| | Chrome | Firefox |
|---|---|---|
| Фон | `background.service_worker` | `background.scripts` (MV3 в Firefox без service worker) |
| Идентификатор | — | `browser_specific_settings.gecko.id` |
| Минимальная версия | 116 | 115 (ESR), нужен `DecompressionStream('deflate-raw')` |
| Сбор данных | — | `data_collection_permissions: { required: ["none"] }` |
| CSP | `script-src 'self' 'wasm-unsafe-eval'` | то же |
| Попап | `action.default_popup` | то же |
| Боковая панель | `side_panel` + разрешение `sidePanel`, `chrome.sidePanel.open({ windowId })` | `sidebar_action`, `sidebarAction.open()` |
| Меню на значке | `contextMenus`, `contexts: ['action']` | то же |

Один бандл Vite обслуживает оба браузера, различаются только манифесты (`manifests/*.json` сливаются с `base.json`). `scripts/build.mjs` выполняет такие шаги:

1. Vite собирает бандл в `dist/.build`.
2. Пакет `assimpjs` копируется в `lib/` и патчится (см. ниже).
3. Получаются папки `dist/chrome` и `dist/firefox`, после копирования проверяется, что все файлы на месте и совпадают по размеру.
4. Архивы `dist/gmv-<browser>-<version>.zip` собирает собственный ZIP-writer. Пути в них всегда через «/», чего требует линтер AMO.

### assimpjs и CSP

Найдено при переносе: embind в assimpjs собирает функции через `new Function`. CSP страниц MV3 это запрещает, поэтому мост assimp (glTF/FBX/OBJ/DAE) в расширении **не мог работать** («Refused to evaluate a string as JavaScript»). `scripts/patch-assimp.mjs` при сборке заменяет `craftInvokerFunction` и `craftEmvalAllocator` на замыкания, как это делает сам emscripten с `-sDYNAMIC_EXECUTION=0`. Если в новой версии assimpjs код изменится, сборка упадёт с понятной ошибкой. Патч проверяется тремя способами: в Node, e2e-тестом в Chromium (OBJ открывается под CSP расширения) и `web-ext lint` (0 предупреждений).

## Тесты

- `npm test` — тесты расширения (Vitest, Node): сборка (zip, манифесты, патч assimpjs) и языки интерфейса. Тесты библиотеки — в `gmv` (`npm test` там).
- `npm run test:e2e` — собирает расширение и запускает Chromium без экрана (SwiftShader WebGL). Проверяет загрузку расширения, MD2 с DDS-текстурой и анимацией, OBJ через assimp, PBO Arma (класс оружия из config.bin, PAA), GTA V `.ydr` (deflate в браузере), кнопку диагностики, а также что на холсте действительно есть отрисовка.
- `npm run lint:firefox` — `web-ext lint` для `dist/firefox`.
- `npm run check` — всё вместе.

## Быстрый просмотр (попап и боковая панель)

- `popup.html` и `sidebar.html` — одна страница (`src/mini/main.ts`, `src/mini/mini.css`), различается `body[data-view]`: попап фиксированного размера 440×540, боковая панель — по размеру панели. Язык и последняя игра общие с полным просмотрщиком (`localStorage`: `lang`, `fmt`).
- Своя `ViewerSession` и `ModelViewer`: файлы кнопкой или перетаскиванием (`viewer/drop.ts`), текстуры, нормали и PBR как в полном просмотрщике, список моделей папки или архива (когда их больше одной) и выбор анимации. Слоёв, выбора объектов и экспорта нет — для этого полный просмотрщик.
- **Автовыбор игры («Авто — по файлу», `shared/detect.ts`):** перед открытием `bestPreset` прогоняет `registry.detect(file, [])` по файлам-моделям без бонуса текущей игры и берёт самое уверенное определение -> `presetForFormat`. После загрузки `readOptions` перечисляет игры, чьи форматы есть среди кандидатов определения (с тем же расширением), — если их больше одной, строка «Читать как» перечитывает тот же файл (`session.loadModel`) с другой игрой. Список моделей архива в режиме «Авто» — модели всех движков (`archiveModels` библиотеки знает только текущую игру). Выбор игры в списке выключает «Авто» (`localStorage.auto`).
- **Открытое переживает переход между окнами (`shared/workspace.ts`):** в IndexedDB `gmv-workspace` лежит один рабочий набор — игра, «Авто», источники и открытая модель архива (`{ archive: имя, path }`). Источники: в Chromium — дескрипторы File System Access (`getAsFileSystemHandle` при перетаскивании, вызывается синхронно в обработчике drop; `showOpenFilePicker` в боковой панели), без копирования, при чтении в другой странице — `queryPermission`, при отказе кнопка «Разрешить доступ и продолжить» (`requestPermission` только по щелчку); иначе (Firefox, `<input>` в попапе) — копии `File`, не больше 64 МБ в сумме, остальное помечается как не сохранённое. Попап и панель при открытии продолжают сами, если набор не содержит папок (большую папку не перечитывать при каждом открытии попапа) — иначе кнопка «Продолжить»; явный переход ◨ ставит флаг в `localStorage` (синхронно, успевает до закрытия попапа), и панель открывает всё сразу. Вкладка — только по `viewer.html?handoff=1`. Хранится сутки; ✕ очищает.
- **Языки (52):** `i18n.ts` держит английский (эталон) и русский, остальные — `src/viewer/locales/<код>.json`, подгружаются `import.meta.glob` при выборе (`setLang` асинхронный, страницы ждут `initLang` до построения интерфейса). `matchBrowserLang` сводит язык браузера к коду (pt-BR/pt-PT, es/es-419, zh-Hans/Hant, iw/in/tl, nb/nn). Арабский, иврит и фарси — `dir="rtl"`. Библиотека (`@gmvjs/core`) знает только ru/en: для остальных её тексты (игры, статусы) — английские. `_locales`: 55 папок (плюс en_AU/en_GB/en_US) с названием, описанием (≤ 132 символов — предел магазина Chrome), подсказкой значка и пунктами меню. Тест сверяет ключи и `{параметры}` всех словарей с английским.
- **Ограничения браузеров:** попап закрывается при потере фокуса, поэтому перетащить в него файл из проводника нельзя — подсказка ведёт в боковую панель. В Firefox окно выбора файла тоже закрывает попап, поэтому там «Открыть» открывает боковую панель. `sidePanel.open` / `sidebarAction.open` работают только синхронно в обработчике действия пользователя: попап узнаёт `windowId` заранее.
- `sidePanel` берётся через `Reflect.get(chrome, 'sidePanel')`: иначе `web-ext lint` для Firefox предупреждает о неподдерживаемом API.
- Фоновый скрипт без `import` (собирается в один файл): service worker Chrome и `background.scripts` Firefox объявлены не модулями.
