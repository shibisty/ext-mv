// Unreal Engine 1–5 через экспорт ActorX (PSK/PSKX/PSA) из UModel / FModel.
import { baseName, hasMagic } from '../../core/binary';
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
  formats: [
    {
      id: 'unreal-psk', title: 'ActorX PSK/PSKX', engine: 'unreal', extensions: ['psk', 'pskx'], motionExtensions: ['psa'], status: 'bridge',
      sniff: (h) => (hasMagic(h, 'ACTRHEAD') ? 1 : 0.2),
      load: async (main) => (await import('./psk')).loadPsk(await main.arrayBuffer()),
      resolveTexture: async (mesh, _m, lib) => (mesh.texture ? guessTexture(mesh.texture, lib) : null),
    },
  ],
  games: [
    { id: 'ue123', group: 'Игры', title: 'Unreal Engine 1–3 (Unreal, UT, UT2004, Gears…) — экспорт PSK/PSA', engine: 'unreal', formats: ['unreal-psk'], ui, status: 'bridge',
      hint: 'Экспортируйте модель утилитой UModel (UEViewer) в PSK/PSKX (+ PSA для анимаций, текстуры в TGA/PNG) и выберите «Папку игры» с экспортом. Нативные .upk/.u пока не читаются.' },
    { id: 'ue45', group: 'Игры', title: 'Unreal Engine 4–5 — экспорт PSK/PSA (FModel/UModel)', engine: 'unreal', formats: ['unreal-psk'], ui, status: 'bridge',
      hint: 'FModel/UModel: экспорт в PSK/PSKX/PSA и текстур в PNG. glTF из FModel открывайте через «Форматы (assimp) → glTF». Нативные .pak/.uasset пока не читаются.' },
  ],
});
