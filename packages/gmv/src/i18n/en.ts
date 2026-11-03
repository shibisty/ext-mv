// English texts for game presets, engines and export targets (Russian is the default, written in the plugins themselves).

export const PRESETS_EN: Record<string, { title?: string; hint?: string; archiveLabel?: string; motionLabel?: string }> = {
  'stalker-soc': { title: 'S.T.A.L.K.E.R.: Shadow of Chernobyl', hint: 'OGF v4. Animations are inside the model or in an external .omf. gamedata.db* archives open through “Game folder” (the file-table key is taken from your game’s bin/XR_3DA.exe) or with “Open .db…” together with XR_3DA.exe; mod .xdb archives and an unpacked gamedata folder open too. External .omf files referenced by a model are attached automatically when the gamedata folder or archives are open; torso animations play together with legs (choose in “Other body parts”). Levels include grass from level.details; SDK sources: .object with skeleton and animations, .skl/.skls.', archiveLabel: 'Open .db…' },
  'stalker-cs': { title: 'S.T.A.L.K.E.R.: Clear Sky', hint: 'OGF v4. Open resources.db0–db2 (models and textures) and patches/xpatch_*.db, or a gamedata folder. External .omf files referenced by a model are attached automatically when the gamedata folder or archives are open; torso animations play together with legs (choose in “Other body parts”). Levels include grass from level.details; SDK sources: .object with skeleton and animations, .skl/.skls.', archiveLabel: 'Open .db…' },
  'stalker-cop': { title: 'S.T.A.L.K.E.R.: Call of Pripyat', hint: 'OGF v4, including 3- and 4-weight vertices. .db archives as in Clear Sky. External .omf files referenced by a model are attached automatically when the gamedata folder or archives are open; torso animations play together with legs (choose in “Other body parts”). Levels include grass from level.details; SDK sources: .object with skeleton and animations, .skl/.skls.', archiveLabel: 'Open .db…' },
  fo3: { hint: 'NIF 20.2.0.7. Open the Meshes/Textures .bsa and pick a model from the list (or load .nif and textures as files). Characters and creatures come with their skeleton (skeleton.nif) and .kf animations.', archiveLabel: 'Open .bsa…' },
  fnv: { hint: 'NIF 20.2.0.7. .bsa archives (zlib). Skinning via skeleton.nif, .kf animations (characters/_male/locomotion/mtidle.kf and others).', archiveLabel: 'Open .bsa…' },
  skyrim: { hint: 'NIF 20.2.0.7, BSA v104. Skinning and .kf animations (Havok .hkx is not supported).', archiveLabel: 'Open .bsa…' },
  skyrimse: { hint: 'BSTriShape, BSA v105 (LZ4). Skinned SSE meshes are not shown yet.', archiveLabel: 'Open .bsa…' },
  gta3: { hint: 'DFF + TXD from gta3.img. For IMG v1 select the .img and the .dir with the same name together. Animations (IFP) — later.', archiveLabel: 'Open .img (+ .dir for III/VC)…' },
  gtavc: { hint: 'DFF + TXD from gta3.img (IMG v1: .img + .dir).', archiveLabel: 'Open .img (+ .dir for III/VC)…' },
  gtasa: { hint: 'DFF + TXD from gta3.img / player.img (IMG v2, single file). Character skinning is supported.', archiveLabel: 'Open .img (+ .dir for III/VC)…' },
  penumbra: { hint: 'Collada models (.dae) via assimp. Choose "Game folder" — models and textures are found automatically.' },
  amnesia: { hint: '.dae (Collada) models + .mat materials. Skeletons and animations are inside the .dae. Binary .msh is not supported yet.' },
  amfp: { hint: 'Same as TDD: .dae + .mat.' },
  quake: { hint: 'Open pak0.pak: the palette (gfx/palette.lmp) is taken from it. The skin is embedded in the MDL.', archiveLabel: 'Open .pak…' },
  quake2: { hint: 'Models from pak0.pak; PCX skins are looked up in the archive. Animations are grouped by frame names.', archiveLabel: 'Open .pak…' },
  quake3: { hint: 'pk3 = ZIP. TGA/JPG textures by shader name; .shader scripts are not parsed yet.', archiveLabel: 'Open .pk3…' },
  doom3: { hint: 'pk4 = ZIP. Textures come from .mtr materials, .md5anim animations from the model folder.', archiveLabel: 'Open .pk4…' },
  quake4: { hint: 'The same MD5 format as Doom 3.', archiveLabel: 'Open .pk4…' },
  ue123: { title: 'Unreal Engine 1–3 (Unreal, UT, UT2004, Gears…) — PSK/PSA export', hint: 'Export the model with UModel (UEViewer) to PSK/PSKX (+ PSA for animations, textures as TGA/PNG) and open the export folder with "Game folder". Native .upk/.u are not read yet.' },
  ue45: { title: 'Unreal Engine 4–5 — PSK/PSA export (FModel/UModel)', hint: 'FModel/UModel: export to PSK/PSKX/PSA and textures to PNG. Open glTF from FModel via "Formats (assimp) → glTF". Native .pak/.uasset are not read yet.' },
  goldsrc: { hint: 'MDL with animations. External textures (*T.mdl) and animations (*01.mdl) are picked up when you open the "Game folder…" (models folder). BSP/WAD maps — not yet.' },
  source: { hint: 'MDL + VVD + VTX (v44–49). Open *_dir.vpk together with *_000.vpk… or the "Game folder…". VMT/VTF materials are matched automatically. No skeleton or animations yet.', archiveLabel: 'Open *_dir.vpk (+ parts)…' },
  source2: { title: 'Source 2: Dota 2, CS2, Half-Life: Alyx — via glTF export', hint: 'Native vmdl_c/vtex_c are not read yet. Export models to glTF/GLB with Source 2 Viewer (ValveResourceFormat) and open them here.' },
  cod: { title: 'Call of Duty (CoD4 and later, Black Ops, MW, Warzone…) — Cast export', hint: 'Export the model with Greyhound / Wraith / Mako to Cast (textures as PNG/DDS) and open the export with "Game folder…". Animations are .cast too: the "+ animation" button or a click in the list. SEModel/SEAnim: convert to Cast with SECast. CoD1/CoD2 (.iwd: xmodel/xmodelsurfs) are not supported yet.', motionLabel: '+ animation (.cast)' },
  nfs34: { title: 'Need for Speed III: Hot Pursuit / NFS: High Stakes — cars (FCE)', hint: 'Open car.viv (a BIGF container) — it holds car.fce and car00.tga. LOD0 is shown. Other EA games (NFS Underground/MW/Carbon, FIFA, Frostbite) are not read yet.', archiveLabel: 'Open car.viv…' },
  cryengine: { title: 'CryEngine 3/5 (Crysis 2/3, Hunt, KCD…) — .cgf/.cga/.skin, static', hint: 'Only the CrCh container with streamed geometry is read natively (LOD0, no skeleton or node transforms); .mtl materials → DDS textures. Checked on synthetic files only.', archiveLabel: 'Open .pak (ZIP)…' },
  'cryengine-dae': { title: 'CryEngine (Far Cry 1, Crysis, MWO, ArcheAge, Star Citizen…) — via Cryengine Converter (Collada)', hint: 'Unpack the .pak (it is a ZIP), convert models: cgf-converter <file.cgf> -objectdir <data folder> (Collada with skeleton), then open the data folder with "Game folder…" (Textures/…dds are picked up).' },
  beamng: { hint: 'Open a mod (.zip) or the vehicles/<car> folder with "Game folder" and pick a .pc configuration. Parts missing from the mod (shared game parts) are found if the game\'s content/vehicles is open too.', archiveLabel: 'Open mod (.zip)…' },
  arma3: { hint: 'Open the mod folder (@Mod/addons) with "Game folder" or select .pbo files. .p3d models are in the archives; the "config" folder of each PBO lists classes (weapons with attachments, uniforms, vests, helmets, soldiers with gear) with textures from the config.', archiveLabel: 'Open .pbo (all from addons is fine)…' },
  arma2: { hint: 'PBO from the AddOns folder; binarized P3D.', archiveLabel: 'Open .pbo…' },
  gta5: { title: 'GTA V (mods: ydr/ydd/yft/ytd)', hint: 'Mod files (Add-On, stream/). Open the folder with "Game folder": .ytd textures are matched by name. A character is its .yft (assembled from *_000_* components). Encrypted game RPF archives are not supported: extract files with OpenIV or CodeWalker.' },
  snowrunner: { hint: 'Open the mod .pak (zip): meshes are prebuild/meshes/*, .pct textures are in pc.pak (open both). Whole trucks from classes/trucks/*.xml.', archiveLabel: 'Open mod .pak (+ pc.pak with textures)…' },
  mudrunner: { hint: 'Open the mod folder (with Media/ or _m/, _t/) with "Game folder": meshes are extension-less files in MeshCache or _m, textures are in TextureCache, _t, colors/default.' },
  survarium: { hint: 'Open the game folder (or select all resources.*.db files — updates are applied on top) and choose a model folder models/…/*.model or *.skinned_model, a character outfit models/character/…/*.outfit (parts + head) or a level projects/<level>/<mode>.vlevel.', archiveLabel: 'Open resources.*.db…' },
  farcry2: { hint: 'Open the game folder (or Data_Win32): the .fat/.dat archives connect by themselves and file names are taken from the game\'s own resource lists. Models are graphics/…/*.xbg; levels are worlds/<world>/maps/*.fc2level (a 1×1 km map: terrain and objects) and worlds/<world>/<world>.fc2level (the whole world, terrain only).', archiveLabel: 'Open *.fat + *.dat…' },
  'fear-online': { hint: 'Open the game folder (the *.arch01 archives and the Game folder with Game/database/Loki.gamedb are picked up automatically) and choose a .mdl model: weapons weaponsf/…, characters charf/… and char/…, props models/…. Levels: Game/worlds/…/<map>.wld (geometry and prefabs). Animations are found automatically: the model’s own, sets in its folder and its anim/ subfolders (players: Game/charf/…/anim), shared AI sets char/ai/global/…; they are read when picked; add any other set with «+ .mdl».', archiveLabel: 'Open *.arch01 archives…' },
  metro2033: { hint: 'Select content.vfi together with content.vfs0 and textures.vfs0/1 (or the game folder) and open maps/<level>/level (level geometry and objects) or meshes/…/*.model.', archiveLabel: 'Open content.vfi + .vfs…' },
  'assimp-auto': { title: 'Auto (any assimp format)', hint: 'For .obj/.gltf, select the .mtl/.bin together with the model.' },
  obj: { hint: 'Select the .obj and .mtl together (Ctrl/Shift).' },
  other: { title: 'Other (LWO, BVH, DXF, 3MF, MS3D, ASE…)' },
};

export const GROUPS_EN: Record<string, string> = { 'Игры': 'Games', 'Форматы (assimp)': 'Formats (assimp)' };

export const ENGINES_EN: Record<string, string> = {
  core: 'Common formats', unreal: 'Unreal Engine (ActorX export)', cast: 'Cast (Call of Duty etc., via export)', ea: 'Electronic Arts (NFS3/HS)', assimp: 'assimp (bridge)',
};

export const EXPORTERS_EN: Record<string, { title?: string; description?: string; fields?: Record<string, { label?: string; hint?: string; placeholder?: string }> }> = {
  'xray-sdk': {
    title: 'S.T.A.L.K.E.R.: X-Ray SDK 0.7 sources',
    description: 'For LevelEditor and ActorEditor (Call of Pripyat, SDK 0.7): .object geometry (large maps are split into cells), a .level + scene_object.part scene, DDS + .thm textures — one ZIP. Lights, sectors, the AI grid and the xrLC build are done in the SDK.',
    fields: {
      name: { label: 'Level name', hint: 'Latin letters, digits, "_": rawdata/objects/gmv/<name>, rawdata/levels/<name>.level' },
      cell: { label: 'Cell, m', placeholder: 'auto', hint: 'Split the geometry into objects (0 — a single object; 32–64 suits maps)' },
      scale: { label: 'Scale', hint: 'Metres per model unit (X-Ray: 1 unit = 1 m)' },
      instances: { label: 'Level objects as references', hint: 'Each object model becomes one .object in props, the scene holds references with poses. Uncheck to merge objects into the cell geometry' },
    },
  },
  obj: {
    title: 'OBJ + MTL (Blender, 3ds Max, any 3D editor)',
    description: 'Bind-pose geometry, UVs, normals and materials with DDS textures — one ZIP. OBJ does not store bones or animations.',
    fields: { name: { label: 'File name' }, scale: { label: 'Scale' } },
  },
};
