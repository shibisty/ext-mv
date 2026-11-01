# Model Viewer (S.T.A.L.K.E.R. OGF + assimp) — расширение Chrome

Установка: chrome://extensions → «Режим разработчика» → «Загрузить распакованное» → эта папка.

Работа: 1) выберите игру/формат в списке, 2) выберите модель (для OBJ/glTF — вместе с .mtl/.bin), 3) текстуры (файлы или папка).
Игры: S.T.A.L.K.E.R. ТЧ/ЧН/ЗП (.ogf v4, анимации из модели или .omf).
Форматы assimp (glTF, FBX, OBJ, DAE, 3DS, STL, PLY, Blend, X, MD2/3/5, SMD и др.): требуется положить assimpjs в lib/ (см. lib/README.txt).
Новая игра/формат = запись в js/formats.js + загрузчик в js/loaders/, возвращающий ту же структуру модели, что js/loaders/xray.js.

## Bethesda (часть 1)
Fallout 3, New Vegas, Skyrim LE/SE: NIF 20.2.0.7 + архивы BSA (v103/104 zlib, v105 LZ4).
Выберите игру → «Открыть .bsa…» (Meshes и Textures) → найдите модель в списке; текстуры подтянутся из архивов.
Пока нет: анимации (.kf), скининг, Oblivion/Morrowind (старые версии NIF), Fallout 4 (.ba2), текстуры .tga.

## Rockstar (часть 1): GTA III / Vice City / San Andreas
RenderWare DFF + TXD, архивы IMG (v1: .img + одноимённый .dir, v2: один .img). Выберите игру → «Открыть .img…» → модель из списка;
одноимённый .txd подгружается сам, дополнительные .txd (vehicle.txd, generic.txd) можно перетащить в окно.
Скин (Skin PLG + HAnim) поддержан. Пока нет: анимации IFP, GTA IV/V (RAGE: WDR/YDR), консольные версии.

## «Папка игры» (для любой игры) и HPL (Penumbra, Amnesia)
Кнопка «Папка игры…» индексирует выбранную папку (без чтения файлов): список моделей по формату игры, текстуры ищутся по суффиксу пути.
HPL1/HPL2: модели .dae (Collada) через assimp (нужен lib/assimpjs-all.*), текстура берётся из одноимённого .mat (элемент <Diffuse File="…">, разбор по возможности).
Не поддержано: бинарный .msh (спецификация не найдена), SOMA/HPL3 (исходники движка не опубликованы).

## id Tech 1–4
Quake (MDL, pak0.pak даёт палитру), Quake II (MD2, скины PCX), Quake III (MD3, pk3), Doom 3 / Quake 4 (MD5mesh + md5anim, pk4, материалы .mtr).
MD2/MD3/MDL — покадровая анимация вершин; MD5 — скелет и скиннинг. Архивы: PAK, ZIP (pk3/pk4). Декодеры текстур: TGA, PCX, DDS.
Не поддержано: карты BSP, .shader-скрипты Quake III, статика Doom 3 (.lwo/.ase — открывается через assimp), id Tech 5+ (закрытые форматы;
для Doom 2016/Eternal экспортируйте модели утилитой SAMUEL в OBJ/LWO и откройте через «Форматы (assimp)»).

## Unreal Engine 1–5 (через экспорт)
Нативные пакеты Unreal (.upk/.u, .pak/.uasset, IoStore) здесь не читаются. Поддержан обменный формат ActorX, в который сохраняют UModel и FModel:
PSK (скелетная модель), PSKX (статика), PSA (анимации). Левосторонняя Z-вверх система UE приводится к правосторонней автоматически;
трактовка кватернионов костей подбирается автоматически. Текстуры (TGA/PNG/DDS из экспорта) ищутся по имени материала (M_/MI_ → T_ + _D/_BaseColor…).
Работа: «Папка игры…» → папка экспорта → выбрать .psk → «+ .psa» или клик по .psa в списке.

## Valve: GoldSrc, Source, Source 2
GoldSrc (Half-Life 1, CS 1.6): MDL v10 со скелетом и анимациями; текстуры из внешнего *T.mdl и анимации из *01.mdl подтягиваются при открытии «Папки игры…».
Source 1 (v44–49): MDL + VVD + VTX, LOD 0, материалы VMT → VTF; архивы VPK v1/v2 (выберите *_dir.vpk вместе с *_000.vpk…). Скелет и анимации Source — следующая часть.
Source 2: нативно не читается; экспортируйте модели в glTF/GLB в Source 2 Viewer (ValveResourceFormat) и откройте через запись «Source 2».
Не поддержано: карты BSP, WAD3, SPR, PHY, flex-анимации лица.

## Call of Duty (через Cast)
Нативные форматы CoD (fastfile, xmodel*, CASC в новых частях) здесь не читаются. Поддержан Cast (.cast) — формат выгрузки Greyhound / Wraith / Mako / Legion:
модель, скелет, веса (до 4 костей на вершину), материалы (текстура из файла-узла albedo/diffuse), анимации (кривые rq/tx/ty/tz, абсолютный режим).
Работа: выгрузите ассеты в Cast + PNG/DDS → «Папка игры…» → .cast → «+ анимация (.cast)» (или клик по файлу анимации в списке).
Не поддержано: SEModel/SEAnim (конвертируйте SECast), CoD1/CoD2 .iwd (xmodel/xmodelparts/xmodelsurfs), форматы текстур .iwi, xmodel_export/xanim_export.

## Electronic Arts (часть 1): NFS III / High Stakes
Контейнер BIGF (car.viv, .big) и модели автомобилей FCE3 / FCE4 (car.fce) с текстурой car00.tga из того же VIV.
Таблицы частей в FCE находятся по структуре (first/num вершин и треугольников дают префиксные суммы), а не по зашитым смещениям; размеры заголовка 0x1F04 / 0x2038 перебираются с проверкой.
LOD0 (части :M/:L/:T скрыты), оси подбираются по габаритам кузова. Не поддержано: NFS2 (GEO), NFS Porsche, Underground/MW/Carbon (EAGL: GEOMETRY.BIN, TPK, JDLZ/HUFF/RefPack),
FSH/QFS-текстуры, FIFA (.big/.rx3), Frostbite (.cas/.sb/.toc).

## CryEngine
1) Нативно: .cgf/.cga/.skin в контейнере «CrCh» с потоковой геометрией (DataStream позиций/индексов/UV + MeshSubsets): LOD0, поза покоя, подмеши по MatID;
материал .mtl (XML) → Diffuse → DDS из .pak/папки. Размер записи подмеша и начало тела чанка определяются по границам чанков. Без трансформов узлов, скелета, анимаций.
2) Через Cryengine Converter (Collada): Far Cry 1 («CryT»/0x744), Crysis, MWO, ArcheAge, Star Citizen («#ivo») — запись «CryEngine … через Cryengine Converter» (assimp).
.pak у CryEngine — ZIP (store/deflate); зашифрованные .pak и Star Citizen .p4k (ZIP64 + Zstd + AES) не поддерживаются. Не поддержано: .chr/.caf, split-DDS (.dds.1…), BC4/BC5/BC7.
