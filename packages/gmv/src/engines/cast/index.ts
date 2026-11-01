// Cast (.cast): выгрузка Greyhound / Wraith / Mako / Legion — Call of Duty и другие игры.
import { hasMagic } from '../../core/binary';
import { defineEngine } from '../../core/plugin';

export const castEngine = defineEngine({
  id: 'cast',
  title: 'Cast (Call of Duty и др., через экспорт)',
  formats: [
    {
      id: 'cast', title: 'Cast', engine: 'cast', extensions: ['cast'], motionExtensions: ['cast'], status: 'bridge',
      sniff: (h) => (hasMagic(h, 'cast') ? 1 : 0),
      load: async (main) => { const m = await import('./cast'); return m.convertCast(m.parseCast(await main.arrayBuffer())); },
    },
  ],
  games: [
    { id: 'cod', group: 'Игры', title: 'Call of Duty (CoD4 и новее, Black Ops, MW, Warzone…) — экспорт Cast', engine: 'cast', formats: ['cast'], status: 'bridge',
      ui: { motionAny: true, motionLabel: '+ анимация (.cast)', zUp: true },
      hint: 'Выгрузите модель утилитой Greyhound / Wraith / Mako в формате Cast (текстуры — PNG/DDS) и откройте «Папку игры…» с выгрузкой. Анимации — тоже .cast: кнопка «+ анимация» или клик в списке. SEModel/SEAnim: сконвертируйте в Cast утилитой SECast. CoD1/CoD2 (.iwd: xmodel/xmodelsurfs) пока не поддержаны.' },
  ],
});
