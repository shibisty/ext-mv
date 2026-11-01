// RAGE (GTA V, Gen8): ресурсы RSC7 вне RPF — .ydr, .ydd, .yft, .ytd (моды «Add-On», файлы из OpenIV/CodeWalker).
// Зашифрованные RPF игры не читаются: ключи — часть исполняемого файла игры и с расширением не поставляются.
import { u32le } from '../../core/binary';
import { defineEngine, type FormatPlugin } from '../../core/plugin';

const sniff = (h: Uint8Array) => (u32le(h, 0) === 0x37435352 ? 0.8 : u32le(h, 0) === 0x38435352 ? 0.5 : 0);

/** Одноимённый .ytd и словари с именами диффузных текстур рядом с моделью (компоненты персонажей: uppr_diff_000_a_uni.ytd). */
const afterLoad: FormatPlugin['afterLoad'] = async ({ main, model, textures }) => {
  const arch = main.archive;
  if (!arch || !main.path) return;
  const { parseYtd } = await import('./load');
  const byName = (n: string) => arch.lookup(n) ?? arch.entries.find((x) => x.path.endsWith('/' + n.split('/').pop()));
  const loaded = new Set<string>();
  // Словарь подключается под именами своих текстур и под именем файла: игра выбирает .ytd по варианту компонента,
  // а внутреннее имя текстуры у модов часто другое (accs_diff_001_a_uni.ytd содержит «decl_diff_001_a_uni»).
  const add = async (e: { path: string }) => {
    if (loaded.has(e.path)) return;
    loaded.add(e.path);
    try {
      const { textures: list } = await parseYtd(await arch.fileOf(e).arrayBuffer());
      for (const t of list) textures.addDecoded(t.name, t, 'ytd');
      const base = e.path.split('/').pop()!.replace(/\.ytd$/, ''), diff = list.find((t) => /_diff_/.test(t.name)) ?? list[0];
      if (diff && !list.some((t) => t.name.toLowerCase() === base)) textures.addDecoded(base, diff, 'ytd');
    } catch { /* повреждённый словарь — текстуры просто не найдутся */ }
  };
  const dir = main.path.replace(/[^/]*$/, ''), names = new Set<string>([main.path.replace(/\.[^.]+$/, '.ytd')]);
  for (const m of model.meshes) if (m.texture && !m.image) names.add(`${dir}${m.texture.toLowerCase()}.ytd`);
  for (const n of names) { const e = byName(n); if (e) await add(e); }
  // имя текстуры от другого варианта (lowr_diff_004_a_whi у lowr_000): берём «<компонент>_diff_<номер файла>_a_*.ytd»
  const fileNum = /^([a-z]+)_(\d{3})_/.exec(main.name.toLowerCase());
  for (const m of model.meshes) {
    if (!m.texture || m.image || textures.find(m.texture)) continue;
    const t = /^([a-z]+)_diff_(\d{3})_([a-z])_/.exec(m.texture.toLowerCase());
    if (!t) continue;
    const num = fileNum && fileNum[1] === t[1] ? fileNum[2] : '000';
    const re = new RegExp(`(^|/)${t[1]}_diff_${num}_a_[a-z]+\\.ytd$`);
    const e = arch.entries.find((x) => re.test(x.path));
    if (!e) continue;
    await add(e);
    m.texture = e.path.split('/').pop()!.replace(/\.ytd$/, '');
  }
};

const fmt = (id: string, ext: string, title: string, load: FormatPlugin['load']): FormatPlugin => ({ id, title, engine: 'rage', extensions: [ext], status: 'beta', sniff, load, afterLoad });

export const rageEngine = defineEngine({
  id: 'rage',
  title: 'RAGE (GTA V)',
  formats: [
    fmt('rage-ydr', 'ydr', 'GTA V drawable (.ydr)', async (main) => (await import('./load')).loadYdr(main)),
    fmt('rage-ydd', 'ydd', 'GTA V словарь drawable (.ydd: одежда, части персонажа)', async (main) => (await import('./load')).loadYdd(main)),
    fmt('rage-yft', 'yft', 'GTA V фрагмент (.yft: машины, персонажи)', async (main, ctx) => (await import('./load')).loadYft(main, ctx)),
  ],
  dictionaries: [{ id: 'ytd', extensions: ['ytd'], parse: async (buf) => (await import('./load')).parseYtd(buf) }],
  games: [
    {
      id: 'gta5', group: 'Игры', title: 'GTA V (моды: ydr/ydd/yft/ytd)', engine: 'rage', formats: ['rage-ydr', 'rage-ydd', 'rage-yft'], status: 'beta', ui: { zUp: true }, markers: ['gta5.exe', 'playgtav.exe'],
      hint: 'Файлы мода (Add-On, stream/). Откройте папку через «Папку игры»: текстуры .ytd подтянутся по именам. Персонаж — его .yft (соберётся из компонентов *_000_*). Зашифрованные RPF игры не поддерживаются: извлеките файлы через OpenIV или CodeWalker.',
    },
  ],
});
