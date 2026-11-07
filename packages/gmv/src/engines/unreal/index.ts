// Unreal Engine 1–5 через экспорт ActorX (PSK/PSKX/PSA) из UModel / FModel; Unreal Engine 2 — нативно (пакеты Lineage II).
import { baseName, hasMagic, u32le } from '../../core/binary';
import { defineEngine, type GamePreset } from '../../core/plugin';
import type { TextureLibrary } from '../../core/textures';

const ui: GamePreset['ui'] = { motionLabel: '+ .psa', zUp: true };

/** Имя материала -> вероятные имена текстур (M_/MI_ -> T_ + _D/_BaseColor…). */
export function guessTexture(mat: string, lib: TextureLibrary) {
  const base = baseName(mat).toLowerCase().replace(/\.[^.]+$/, ''), stem = base.replace(/^(mi|m|mat)_/, '');
  const names = new Set<string>();
  for (const b of [base, stem, 't_' + stem]) for (const s of ['', '_d', '_diffuse', '_basecolor', '_albedo', '_color', '_bc', '_df']) names.add(b + s);
  for (const n of names) { const f = lib.find(n); if (f) return f; }
  return null;
}

export const unrealEngine = defineEngine({
  id: 'unreal',
  title: 'Unreal Engine (экспорт ActorX)',
  archives: [
    {
      id: 'ue2', title: 'Пакеты Unreal Engine 2 (.usx, .utx, .ukx; Lineage II — с расшифровкой)', engine: 'unreal', extensions: ['usx', 'utx', 'ukx'],
      sniff: (h) => (u32le(h, 0) === 0x9e2a83c1 || /^L\0i\0n\0e\0a\0g\0e\x002\0V\0e\0r\0/.test(String.fromCharCode(...h.subarray(0, 22))) ? 1 : 0),
      // в «Папке игры» пакеты открываются сами: читаются только заголовок и таблицы, объекты — по выбору
      openFromFolder: (_h, name) => /\.(usx|utx|ukx)$/i.test(name),
      open: async (file) => (await import('./ue2archive')).openUe2Package(file),
    },
  ],
  codecs: [{ id: 'ue2-texture', extensions: ['utex'], decode: async (buf) => (await import('./ue2archive')).unpackRgba(buf) }],
  formats: [
    {
      id: 'ue2-staticmesh', title: 'Unreal Engine 2: StaticMesh (из пакета .usx)', engine: 'unreal', extensions: ['ue2sm'], status: 'beta',
      load: async (main) => (await import('./ue2mesh')).loadUe2StaticMesh(main),
    },
    {
      id: 'ue2-map', title: 'Unreal Engine 2: карта (.unr — ландшафт и StaticMesh)', engine: 'unreal', extensions: ['unr'], status: 'beta',
      sniff: (h) => (u32le(h, 0) === 0x9e2a83c1 || /^L\0i\0n\0e\0a\0g\0e\x002\0/.test(String.fromCharCode(...h.subarray(0, 16))) ? 1 : 0),
      load: async (main) => (await import('./ue2map')).loadUe2Map(main),
    },
    {
      id: 'ue2-skeletalmesh', title: 'Unreal Engine 2: SkeletalMesh с анимациями (из пакета .ukx)', engine: 'unreal', extensions: ['ue2skm'], status: 'beta',
      load: async (main) => (await import('./ue2mesh')).loadUe2SkeletalMesh(main),
    },
    {
      id: 'unreal-psk', title: 'ActorX PSK/PSKX', engine: 'unreal', extensions: ['psk', 'pskx'], motionExtensions: ['psa'], status: 'bridge',
      sniff: (h) => (hasMagic(h, 'ACTRHEAD') ? 1 : 0.2),
      load: async (main) => (await import('./psk')).loadPsk(await main.arrayBuffer()),
      resolveTexture: async (mesh, _m, lib) => (mesh.texture ? guessTexture(mesh.texture, lib) : null),
    },
  ],
  games: [
    { id: 'lineage2', group: 'Игры', title: 'Lineage II (Unreal Engine 2) — статика, персонажи и монстры', engine: 'unreal', formats: ['ue2-staticmesh', 'ue2-skeletalmesh', 'ue2-map'], status: 'beta', markers: ['System/l2.exe', 'StaticMeshes', 'SysTextures'],
      ui: { archives: true, archiveExts: ['usx', 'utx', 'ukx'], archiveLabel: 'Открыть пакеты…', zUp: true },
      hint: 'Откройте «Папку игры» (папку клиента с StaticMeshes, Animations, Textures, SysTextures) — пакеты расшифруются и подключатся сами. Статика — объекты StaticMesh из .usx, персонажи и монстры — SkeletalMesh из .ukx с анимациями своего пакета; текстуры и материалы (Shader, FinalBlend) — из .utx. Карты MAPS/xx_yy.unr — ландшафт со слоями и все StaticMeshActor (меши и текстуры берутся из открытых пакетов). Поддержано шифрование Lineage2Ver111/121 (Prelude, C1–C4); RSA поздних хроник (Ver41x) — нет.' },
    { id: 'ue123', group: 'Игры', title: 'Unreal Engine 1–3 (Unreal, UT, UT2004, Gears…) — экспорт PSK/PSA', engine: 'unreal', formats: ['unreal-psk'], ui, status: 'bridge',
      hint: 'Экспортируйте модель утилитой UModel (UEViewer) в PSK/PSKX (+ PSA для анимаций, текстуры в TGA/PNG) и выберите «Папку игры» с экспортом. Нативные .upk/.u пока не читаются.' },
    { id: 'ue45', group: 'Игры', title: 'Unreal Engine 4–5 — экспорт PSK/PSA (FModel/UModel)', engine: 'unreal', formats: ['unreal-psk'], ui, status: 'bridge',
      hint: 'FModel/UModel: экспорт в PSK/PSKX/PSA и текстур в PNG. glTF из FModel открывайте через «Форматы (assimp) → glTF». Нативные .pak/.uasset пока не читаются.' },
  ],
});
