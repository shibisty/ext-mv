// Реестр: что показывается в выпадающем списке. Новая игра/формат = ещё одна запись (+ при необходимости новый загрузчик в js/loaders/).
const ASSIMP_ALL = ['gltf', 'glb', 'fbx', 'obj', 'dae', '3ds', 'stl', 'ply', 'blend', 'x', 'md5mesh', 'md2', 'md3', 'bvh', 'lwo', 'off', 'dxf', 'ms3d', 'smd', '3mf', 'ase', 'ac', 'ifc', 'xgl', 'cob', 'b3d', 'ogex'];
const XRAY = { loader: 'xray', exts: ['ogf'], features: { omf: true, invertQuat: true } };
const NIF = { loader: 'nif', exts: ['nif'], features: { archives: true, zUp: true } };
const RW = { loader: 'rw', exts: ['dff'], features: { archives: true, archiveExts: ['img', 'dir'], archiveLabel: 'Открыть .img (+ .dir для III/VC)…', zUp: true } };
const HPL = { loader: 'assimp', exts: ['dae'], features: { zUp: true, hplMat: true } };
const IDT = { loader: 'idtech' };
const AS = { loader: 'assimp', features: { zUp: true } };

export const FORMATS = [
  { id: 'stalker-soc', group: 'Игры', title: 'S.T.A.L.K.E.R.: Тень Чернобыля', ...XRAY, hint: 'OGF v4. Анимации — внутри модели или во внешнем .omf.' },
  { id: 'stalker-cs', group: 'Игры', title: 'S.T.A.L.K.E.R.: Чистое небо', ...XRAY, hint: 'OGF v4 (тот же загрузчик, что для ТЧ).' },
  { id: 'stalker-cop', group: 'Игры', title: 'S.T.A.L.K.E.R.: Зов Припяти', ...XRAY, hint: 'OGF v4; возможны 3/4-весовые вершины (менее проверено).' },
  { id: 'fo3', group: 'Игры', title: 'Fallout 3', ...NIF, hint: 'NIF 20.2.0.7. Откройте Meshes/Textures .bsa и выберите модель из списка (или загрузите .nif и текстуры файлами). Пока без анимаций (.kf) и скининга.' },
  { id: 'fnv', group: 'Игры', title: 'Fallout: New Vegas', ...NIF, hint: 'NIF 20.2.0.7. Архивы .bsa (zlib). Пока без анимаций и скининга.' },
  { id: 'skyrim', group: 'Игры', title: 'The Elder Scrolls V: Skyrim (LE)', ...NIF, hint: 'NIF 20.2.0.7, BSA v104. Пока без анимаций и скининга.' },
  { id: 'skyrimse', group: 'Игры', title: 'The Elder Scrolls V: Skyrim Special Edition', ...NIF, hint: 'BSTriShape, BSA v105 (LZ4). Пока без анимаций и скининга.' },
  { id: 'gta3', group: 'Игры', title: 'Grand Theft Auto III', ...RW, hint: 'DFF + TXD из gta3.img. Для IMG v1 выберите .img и одноимённый .dir вместе. Анимации (IFP) — позже.' },
  { id: 'gtavc', group: 'Игры', title: 'Grand Theft Auto: Vice City', ...RW, hint: 'DFF + TXD из gta3.img (IMG v1: .img + .dir).' },
  { id: 'gtasa', group: 'Игры', title: 'Grand Theft Auto: San Andreas', ...RW, hint: 'DFF + TXD из gta3.img / player.img (IMG v2, один файл). Скин персонажей поддержан.' },
  { id: 'penumbra', group: 'Игры', title: 'Penumbra: Overture / Black Plague / Requiem (HPL1)', ...HPL, hint: 'Модели Collada (.dae) через assimp. Выберите «Папку игры» — модели и текстуры найдутся сами. Нужен lib/assimpjs-all.*' },
  { id: 'amnesia', group: 'Игры', title: 'Amnesia: The Dark Descent (HPL2)', ...HPL, hint: 'Модели .dae (Collada) + материалы .mat. Скелеты и анимации — внутри .dae. Бинарный .msh пока не поддержан.' },
  { id: 'amfp', group: 'Игры', title: 'Amnesia: A Machine for Pigs (HPL2)', ...HPL, hint: 'Как для TDD: .dae + .mat. Нужен lib/assimpjs-all.*' },
  { id: 'quake', group: 'Игры', title: 'Quake (id Tech 2) — MDL', ...IDT, exts: ['mdl'], features: { archives: true, archiveExts: ['pak'], archiveLabel: 'Открыть .pak…', zUp: true }, hint: 'Откройте pak0.pak: палитра (gfx/palette.lmp) берётся оттуда. Скин встроен в MDL.' },
  { id: 'quake2', group: 'Игры', title: 'Quake II — MD2', ...IDT, exts: ['md2'], features: { archives: true, archiveExts: ['pak'], archiveLabel: 'Открыть .pak…', zUp: true }, hint: 'Модели из pak0.pak, скины PCX ищутся в архиве. Анимации — по группам кадров.' },
  { id: 'quake3', group: 'Игры', title: 'Quake III Arena — MD3', ...IDT, exts: ['md3'], features: { archives: true, archiveExts: ['pk3'], archiveLabel: 'Открыть .pk3…', zUp: true }, hint: 'pk3 = ZIP. Текстуры TGA/JPG по имени шейдера; .shader-скрипты пока не разбираются.' },
  { id: 'doom3', group: 'Игры', title: 'Doom 3 — MD5 (id Tech 4)', ...IDT, exts: ['md5mesh'], features: { archives: true, archiveExts: ['pk4'], archiveLabel: 'Открыть .pk4…', motionExt: 'md5anim', motionLabel: '+ .md5anim', sameDirMotions: true, mtr: true, zUp: true }, hint: 'pk4 = ZIP. Текстуры берутся из материалов .mtr, анимации .md5anim — из папки модели.' },
  { id: 'quake4', group: 'Игры', title: 'Quake 4 — MD5 (id Tech 4)', ...IDT, exts: ['md5mesh'], features: { archives: true, archiveExts: ['pk4'], archiveLabel: 'Открыть .pk4…', motionExt: 'md5anim', motionLabel: '+ .md5anim', sameDirMotions: true, mtr: true, zUp: true }, hint: 'Тот же формат MD5, что в Doom 3.' },
  { id: 'ue123', group: 'Игры', title: 'Unreal Engine 1–3 (Unreal, UT, UT2004, Gears…) — экспорт PSK/PSA', loader: 'unreal', exts: ['psk', 'pskx'], features: { motionExt: 'psa', motionLabel: '+ .psa', texGuess: true, zUp: true }, hint: 'Экспортируйте модель утилитой UModel (UEViewer) в PSK/PSKX (+ PSA для анимаций, текстуры в TGA/PNG) и выберите «Папку игры» с экспортом. Нативные .upk/.u пока не читаются.' },
  { id: 'ue45', group: 'Игры', title: 'Unreal Engine 4–5 — экспорт PSK/PSA (FModel/UModel)', loader: 'unreal', exts: ['psk', 'pskx'], features: { motionExt: 'psa', motionLabel: '+ .psa', texGuess: true, zUp: true }, hint: 'FModel/UModel: экспорт в PSK/PSKX/PSA и текстур в PNG. glTF из FModel открывайте через «Форматы (assimp) → glTF». Нативные .pak/.uasset пока не читаются.' },
  { id: 'goldsrc', group: 'Игры', title: 'Half-Life 1 / Counter-Strike 1.6 (GoldSrc)', loader: 'valve', exts: ['mdl'], features: { zUp: true }, hint: 'MDL с анимациями. Текстуры во внешнем *T.mdl и анимации в *01.mdl подтянутся, если открыть «Папку игры…» (папка models). Карты BSP/WAD пока нет.' },
  { id: 'source', group: 'Игры', title: 'Source: HL2, CS:S, TF2, GMod, L4D, Portal, CS:GO…', loader: 'valve', exts: ['mdl'], features: { archives: true, archiveExts: ['vpk'], archiveLabel: 'Открыть *_dir.vpk (+ части)…', vmt: true, zUp: true }, hint: 'MDL + VVD + VTX (v44–49). Откройте *_dir.vpk вместе с *_000.vpk… или «Папку игры…». Материалы VMT/VTF подбираются сами. Пока без скелета и анимаций.' },
  { id: 'source2', group: 'Игры', title: 'Source 2: Dota 2, CS2, Half-Life: Alyx — через экспорт glTF', loader: 'assimp', exts: ['glb', 'gltf'], features: { zUp: true }, hint: 'Нативные vmdl_c/vtex_c пока не читаются. Экспортируйте модели в glTF/GLB в Source 2 Viewer (ValveResourceFormat) и откройте здесь.' },
  { id: 'cod', group: 'Игры', title: 'Call of Duty (CoD4 и новее, Black Ops, MW, Warzone…) — экспорт Cast', loader: 'cast', exts: ['cast'], features: { motionAny: true, motionLabel: '+ анимация (.cast)', zUp: true },
    hint: 'Выгрузите модель утилитой Greyhound / Wraith / Mako в формате Cast (текстуры — PNG/DDS) и откройте «Папку игры…» с выгрузкой. Анимации — тоже .cast: кнопка «+ анимация» или клик в списке. SEModel/SEAnim: сконвертируйте в Cast утилитой SECast. CoD1/CoD2 (.iwd: xmodel/xmodelsurfs) пока не поддержаны.' },
  { id: 'nfs34', group: 'Игры', title: 'Need for Speed III: Hot Pursuit / NFS: High Stakes — автомобили (FCE)', loader: 'nfs', exts: ['fce'], features: { archives: true, archiveExts: ['viv', 'big'], archiveLabel: 'Открыть car.viv…' },
    hint: 'Откройте car.viv (контейнер BIGF) — внутри car.fce и car00.tga. Показывается LOD0. Остальные игры EA (NFS Underground/MW/Carbon, FIFA, Frostbite) пока не читаются.' },
  { id: 'cryengine', group: 'Игры', title: 'CryEngine 3/5 (Crysis 2/3, Hunt, KCD…) — .cgf/.cga/.skin, статика', loader: 'cry', exts: ['cgf', 'cga', 'skin', 'cgam', 'skinm'], features: { archives: true, archiveExts: ['pak'], archiveLabel: 'Открыть .pak (ZIP)…', cryMtl: true, zUp: true },
    hint: 'Нативно читается только контейнер CrCh с потоковой геометрией (LOD0, без скелета и трансформов узлов); материалы .mtl → текстуры DDS. Проверено лишь на синтетике.' },
  { id: 'cryengine-dae', group: 'Игры', title: 'CryEngine (Far Cry 1, Crysis, MWO, ArcheAge, Star Citizen…) — через Cryengine Converter (Collada)', loader: 'assimp', exts: ['dae'], features: { zUp: true },
    hint: 'Распакуйте .pak (это ZIP), сконвертируйте модели: cgf-converter <файл.cgf> -objectdir <папка данных> (Collada со скелетом), затем «Папка игры…» с папкой данных (Textures/…dds подхватятся). Нужен lib/assimpjs-all.*' },
  { id: 'assimp-auto', group: 'Форматы (assimp)', title: 'Авто (любой формат assimp)', ...AS, exts: ASSIMP_ALL, hint: 'Нужны lib/assimpjs-all.js и .wasm. Для .obj/.gltf выберите вместе с моделью .mtl/.bin.' },
  { id: 'gltf', group: 'Форматы (assimp)', title: 'glTF / GLB', ...AS, exts: ['gltf', 'glb'] },
  { id: 'fbx', group: 'Форматы (assimp)', title: 'FBX', ...AS, exts: ['fbx'] },
  { id: 'obj', group: 'Форматы (assimp)', title: 'Wavefront OBJ', ...AS, exts: ['obj'], hint: 'Выберите .obj и .mtl одновременно (Ctrl/Shift).' },
  { id: 'dae', group: 'Форматы (assimp)', title: 'Collada (DAE)', ...AS, exts: ['dae'] },
  { id: '3ds', group: 'Форматы (assimp)', title: '3DS', ...AS, exts: ['3ds'] },
  { id: 'blend', group: 'Форматы (assimp)', title: 'Blender (.blend)', ...AS, exts: ['blend'] },
  { id: 'stl', group: 'Форматы (assimp)', title: 'STL', ...AS, exts: ['stl'] },
  { id: 'ply', group: 'Форматы (assimp)', title: 'PLY', ...AS, exts: ['ply'] },
  { id: 'x', group: 'Форматы (assimp)', title: 'DirectX (.x)', ...AS, exts: ['x'] },
  { id: 'md', group: 'Форматы (assimp)', title: 'Quake/Doom: MD2, MD3, MD5', ...AS, exts: ['md2', 'md3', 'md5mesh'] },
  { id: 'smd', group: 'Форматы (assimp)', title: 'Source: SMD', ...AS, exts: ['smd'] },
  { id: 'other', group: 'Форматы (assimp)', title: 'Прочие (LWO, BVH, DXF, 3MF, MS3D, ASE…)', ...AS, exts: ['lwo', 'bvh', 'dxf', '3mf', 'ms3d', 'ase', 'ac', 'off', 'ifc', 'xgl', 'cob', 'b3d', 'ogex'] },
];
export const byId = (id) => FORMATS.find((f) => f.id === id);
export function detectByExt(ext, current) {
  if (current && current.exts.includes(ext)) return current;
  return FORMATS.find((f) => f.exts.includes(ext)) || null;
}
export const allModelExts = () => [...new Set(FORMATS.flatMap((f) => f.exts)), 'omf'];
