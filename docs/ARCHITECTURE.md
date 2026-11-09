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
   │  ├─ src/background.ts          клик по значку -> вкладка просмотрщика
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
