# Game Model Viewer v12

A WebGL viewer for game models, levels and archives, packaged as a Chrome/Firefox extension (Manifest V3). It reads the files straight from game folders and archives in the browser, with textures, skeletons and animations, and can export what it opens to other games and editors (for example, Metro 2033 maps to S.T.A.L.K.E.R. X-Ray SDK sources).

The project has two parts:

- **`packages/gmv`** — the library: a core with a plugin API, one module per engine, and a WebGL2 renderer. It can be reused in other projects ([packages/gmv/README.md](packages/gmv/README.md)).
- **`apps/extension`** — the Chrome and Firefox extension.

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Detailed plan with per-format notes (in Russian): [docs/ROADMAP.md](docs/ROADMAP.md).

## Support status

✅ works · 🟡 partial (what is missing is listed) · ⬜ planned

"Verified" means checked on real game files; everything else is covered by tests on synthetic files.

### Games and engines

| Game / engine | Status | What works | Missing / next |
|---|---|---|---|
| **S.T.A.L.K.E.R.** SoC, CS, CoP (X-Ray) | ✅ verified | OGF v4 models with skeletons and animations (internal and external `.omf`, body-part motions mapped via `S_SMPARAMS`, 3- and 4-weight vertices); `.db`/`.xdb` archives (LZHUF tables, LZO files); compiled levels (`level` + `level.geom`); SDK sources (`.object`, `.level` scenes). Checked: OGF 935/935 (SoC), 641/641 (CS), 914/914 (CoP); all 30 SoC levels | Encrypted SoC archives (`gamedata.db*`) — use an unpacked `gamedata` folder; blending legs + torso animations; compressed tree positions in levels |
| **Metro 2033** (4A Engine, 2010) | ✅ verified | `content.vfi` + `.vfs` archives (QuickLZ); levels (`level` + `level.geom_pc`) with all objects from `level.bin` (props, doors, wagons, NPCs) and baked lighting (`level.lmap_pc`); `.model`/`.mesh`/`.skeleton` (static and skinned); `.motion` animations (listed from the skeleton's motion folders, loaded on demand); textures (`.512`/`.1024`/`.2048` → DDS), normals and specular from `_bump` maps, alpha-tested surfaces. `l08_market`: 2 355 objects, 659 models | Detail textures; Metro Redux, Last Light, Exodus (schemas are known) |
| **Fallout 3 / New Vegas, Skyrim LE/SE** (Gamebryo) | ✅ verified | NIF with skinning, `skeleton.nif` lookup, `.kf` animations (incl. B-spline), BSA archives. FNV: creatures 203/206, characters/armour 839/846 | Skinned `BSTriShape` (Skyrim SE), Havok `.hkx`, FaceGen, Oblivion/Morrowind, Fallout 4 `.ba2` |
| **GTA V** (RAGE) | ✅ verified on mods | `.ydr`, `.ydd`, `.yft`, `.ytd` (DXT, BC4/5, BC7); peds assembled from components | RPF archives (AES — keys must come from the user), vehicles from `.yft` parts, GTA IV, RDR |
| **Arma 3 / Arma 2** | ✅ verified on mods | PBO, P3D ODOL v28–75, PAA, rapified `config.bin`; soldiers, uniforms and weapons assembled from config classes | MLOD, animations (`.rtm`) |
| **BeamNG.drive** | ✅ verified on mods | `.pc` configurations → jbeam slots → `.dae` flexbodies with materials and paint | — |
| **MudRunner / SnowRunner** | ✅ verified on mods | Mesh cache (`CombineXMesh`), `.pct` textures, whole trucks from `classes/trucks/*.xml` with wheels and addons | Mirrored right-side wheels, addon variants |
| **GTA III / VC / SA** (RenderWare) | 🟡 | DFF, TXD, IMG | IFP animations, IPL/IDE/COL placement, console versions |
| **Quake 1–3, Doom 3, Quake 4** (id Tech) | 🟡 verified | MDL, MD2, MD3, MD5 (+ animations), PAK/PK3/PK4, `.mtr` materials | BSP maps, MD3 tags and player assembly, `.shader`, MDC/MDS |
| **Half-Life / CS 1.6, Source** (Valve) | 🟡 | GoldSrc MDL with animations; Source MDL + VVD + VTX, VPK, VTF/VMT | Source skeletons and animations, BSP maps, MDL v53+ |
| **Source 2** (Dota 2, CS2, Alyx) | 🟡 bridge | Via glTF exported by external tools | Native `vmdl_c` / `vtex_c` |
| **Unreal Engine 1–5** | 🟡 bridge | PSK/PSKX/PSA exported by UModel/FModel | Native packages (`.u`, `.upk`, `.pak`, IoStore) |
| **Call of Duty** | 🟡 bridge | Cast models and animations exported by Greyhound/Saluki | Native fastfiles, older `xmodel` |
| **CryEngine** (Crysis 2/3, Hunt, KCD…) | 🟡 | `.cgf`/`.cga`/`.skin` statics; Collada bridge for older games | Skeletons `.chr`, animations, Far Cry 1, Star Citizen |
| **Penumbra, Amnesia** (HPL) | 🟡 | Collada models with `.mat` materials | Binary `.msh`, maps |
| **Need for Speed III / High Stakes** | 🟡 | FCE cars | Later NFS titles (EAGL), FSH textures |
| **Any format via assimp** | 🟡 bridge | glTF/GLB, FBX, OBJ, DAE, 3DS, Blend, STL, PLY, X, LWO, ASE, SMD and ~15 more | Embedded GLB/FBX textures, morph targets, vertex colours |
| **The Sims 2–4** (+ Sims 1 characters) | ⬜ | — | DBPF `.package` + RefPack, `GMDC`, `MODL`/`MLOD`/`GEOM` |
| **Gothic 1–2** (ZenGin), **Build engine**, **Dark Engine**, **Godot** | ⬜ | — | Open, well-documented formats — next in line |
| **BioWare** Aurora, Odyssey (KotOR), Eclipse | ⬜ | — | Shared KEY/BIF/ERF/GFF layer, then MDL/MDX, TPC |
| **Unity** | ⬜ | — | UnityFS bundles, TypeTree, meshes, textures, skinned renderers |
| Frostbite, RED Engine, Decima, Anvil, Fox, Dunia, Divinity, Genome, LithTech | ⬜ | — | Mostly via bridges from community tools; native support later |

### Export (send a model or level to another game or editor)

| Target | Status | What it produces | Missing / next |
|---|---|---|---|
| **S.T.A.L.K.E.R. X-Ray SDK 0.7** (recommended for Metro and X-Ray sources) | 🟡 | `.object` geometry (large maps split into cells), `.level` + `scene_object.part` scene, map objects as one `.object` per model plus placed references, DDS + `.thm` textures — one ZIP. Round trip on SDK levels: 137/142 objects identical | Testing in LevelEditor; material → shader/gamemtl mapping; writing OGF/OMF for models |
| **OBJ + MTL** (Blender, 3ds Max, any editor) | ✅ | Bind-pose geometry, UVs, normals, materials with DDS textures — one ZIP | — |
| glTF, other game formats | ⬜ | — | glTF with skeletons and animations first, then native writers per engine |

Each engine declares its own export targets and settings; the export dialog shows only the targets that fit the opened model.

### Viewer

| Feature | Status | Notes |
|---|---|---|
| Start screen with game/format search; auto-detection by file signature | ✅ | Opening a file from another game switches the game automatically |
| Game folders, archives, drag and drop, resource search | ✅ | Archives: BSA, PAK/PK3/PK4, VPK, IMG, VIV/BIG, PBO, ZIP, X-Ray `.db`, Metro `content.vfi` |
| Scene layers: level geometry and objects grouped by class, visibility toggles | ✅ | Hidden items are not exported |
| Select objects by clicking in the scene, move and rotate map objects | 🟡 | Undo and saving scene edits — planned; moved objects are exported with their new poses |
| Orbit and free-fly (WASD) camera, cut-away from above | ✅ | |
| Textures, normal maps, PBR (roughness/metalness/AO), wireframe, skeleton | ✅ | Normal and PBR maps found from materials or by file name |
| Skeletal and vertex animation playback | ✅ | Speed, loop, scrubbing |
| Error diagnostics (format, signature, hex dump to clipboard) | ✅ | |
| Interface in English and Russian, switchable on the fly | 🟡 | Default follows the browser language; model details and format error messages are still Russian only |
| Popup and side panel, light theme | ⬜ | |
| Large open levels (5–10 M triangles) | 🟡 | Work but are heavy; instanced trees and distance culling planned |

## Build and install

Node.js 20.19+ or 22.12+ is required.

```bash
npm install
npm run build      # library (packages/gmv/dist) and extension (apps/extension/dist)
npm test           # unit tests (Vitest)
npm run check      # types + tests + build + web-ext lint for Firefox
```

Build output:

- `apps/extension/dist/chrome/` — Chrome: `chrome://extensions` → "Developer mode" → "Load unpacked".
- `apps/extension/dist/firefox/` — Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on…" → `manifest.json`.
- `apps/extension/dist/gmv-chrome-<version>.zip` and `gmv-firefox-<version>.zip` — packages for the Chrome Web Store and AMO.

The assimp bridge (glTF, FBX, OBJ, DAE…) is built automatically: `assimpjs` comes from npm and is copied to `lib/` with a patch for the MV3 content security policy.

## Development

```bash
npm run dev                # rebuild on change -> apps/extension/dist/dev-chrome (load unpacked)
npm run dev:firefox        # same for Firefox -> apps/extension/dist/dev-firefox
npm run test:watch
npm run smoke -- <folder or archives> [--limit 30]                 # check real game files: smoke-report.md
npm run peek -- <folder or archives> --load <path> --ppm out.ppm   # one model: info, textures, image without a browser
npx tsx tools/export-xray.ts <archives…> --load <path> --name <name> --out <file.zip>   # export to X-Ray SDK from the command line
npm run test:e2e   # Chromium + the built extension (Playwright). Chromium path: CHROMIUM_PATH
```

On Windows, e2e tests need an installed Chromium or Chrome: `set CHROMIUM_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`.

## Using the viewer

1. Pick a game or format on the start screen (search is available), or drop model files or a game folder onto the window. Switch the game later with the game button at the top left.
2. **Left panel — resources:** game folder, archives, single models and textures, search across everything opened. Assembled models are listed too: BeamNG `.pc` configurations, Arma `config/…/*.armacfg` classes, MudRunner/SnowRunner `classes/trucks/*.xml` trucks.
3. **Right panel:** "Scene" (layers with visibility checkboxes; double-click focuses the camera), "Meshes and textures" (pick any texture manually with "…"), "Animation".
4. **Top bar:** tools "Camera", "Select" (V), "Move" (G: drag along the floor, Ctrl — up/down) and "Rotate" (R, or ⟲/⟳ 90°), camera "Orbit"/"Fly" (WASD, E/Q up/down, Shift faster), the "View" menu, "Info" and "Export…". F focuses the selection, Esc clears it.
5. **Export…** lists where the opened model can go, with settings for each target.
6. If loading fails, "Copy diagnostics" puts the format, signature and a hex dump of the header on the clipboard.

Game assets and encryption keys are never bundled: the viewer works only with files you already have.
