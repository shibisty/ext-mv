# gmv — Game Model Viewer core

Библиотека чтения игровых моделей. В ядре — API плагинов, движки подключаются как модули, к ним прилагается WebGL2-рендерер. Код на TypeScript, работает в браузере, в Web Worker (ядро без DOM) и в Node.

## Точки входа

| Импорт | Что внутри |
|---|---|
| `gmv` | ядро: типы, `Registry`, `createRegistry`, `ViewerSession`, `TextureLibrary`, архивы ZIP и «Папка игры», zlib/LZ4, DDS/TGA/PCX, `buildDiagnostics` |
| `gmv/engines` | `allEngines` — все движки |
| `gmv/engines/<id>` | один движок: `xray`, `gamebryo`, `renderware`, `idtech`, `valve`, `unreal`, `cast`, `ea`, `cryengine`, `hpl`, `beamng`, `arma`, `rage`, `spintires`, `assimp`; вспомогательный `collada` (быстрый разбор .dae) |
| `gmv/renderer` | `Renderer`, `OrbitCamera`, `ModelViewer` |
| `gmv/iife` | `dist/gmv.iife.js` для `<script>`: глобальный `GMV` со всем перечисленным и `GMV.mount(canvas)` |

## Быстрый старт

```ts
import { createRegistry, ViewerSession } from 'gmv';
import { allEngines } from 'gmv/engines';
import { ModelViewer } from 'gmv/renderer';

const viewer = new ModelViewer(canvas);
const session = new ViewerSession(createRegistry(allEngines), 'skyrimse');
session.on('model', async ({ model }) => {
  viewer.setModel(model);
  for (let i = 0; i < model.meshes.length; i++) {
    const t = await session.resolveTexture(i);
    if (t.image) viewer.setTexture(i, t.image);
  }
});
session.on('status', ({ text, error }) => console[error ? 'error' : 'log'](text));
viewer.start();

await session.addArchives([meshesBsa, texturesBsa]);
await session.openEntry(session.archiveModels('chair').items[0]);
```

Только парсинг, без рендера (например, в Node или Worker):

```ts
import { createRegistry } from 'gmv';
import { idtechEngine } from 'gmv/engines/idtech';

const reg = createRegistry([idtechEngine]);
const det = await reg.detect(file);              // { format, confidence, candidates }
const model = await det!.format.load(file, { files: [file], archives: [], sibling: async () => null, readPath: async () => null });
```

## Свой формат

```ts
import { defineEngine, createRegistry, binary, geometry, type Model } from 'gmv';

export const myEngine = defineEngine({
  id: 'my',
  title: 'My Engine',
  formats: [{
    id: 'my-mesh', title: 'My mesh', engine: 'my', extensions: ['mym'], status: 'beta',
    sniff: (head) => (binary.hasMagic(head, 'MYM1') ? 1 : 0),
    load: async (main) => (await import('./my-parser')).parse(await main.arrayBuffer()) as Model,
  }],
  games: [{ id: 'my-game', group: 'Игры', title: 'My Game', engine: 'my', formats: ['my-mesh'] }],
});

const registry = createRegistry([myEngine]);
```

Загрузчик возвращает `Model`: меши с Float32 атрибутами (`pos`, `nor`, `uv`, по 4 `bone` и 4 `weight` на вершину), индексы Uint16 или Uint32, `skeleton` (реализация `SkeletonRuntime`, для иерархий узлов подходит готовый `NodeSkeleton`), `motions`, `bounds`, `info`.

## assimp

Мост assimp подгружает assimpjs (WASM) по требованию:

```ts
import { configureAssimp } from 'gmv/engines/assimp';
configureAssimp({ baseUrl: '/static/assimp/', scripts: ['assimpjs.js'] }); // браузер
configureAssimp({ factory: () => require('assimpjs')() });                   // Node
```

Для страниц с CSP без `'unsafe-eval'` (расширения MV3) используйте пропатченный assimpjs, см. `apps/extension/scripts/patch-assimp.mjs`.
