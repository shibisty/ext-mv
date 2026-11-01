// Стартовое окно: карточки игр и форматов по группам, поиск; выбор пускает в просмотр.
import { presetText, type GamePreset } from 'gmv';
import { t } from './i18n';

export interface StartScreen {
  show(current: string | null, canGoBack?: boolean): void;
  hide(): void;
  readonly visible: boolean;
  /** Перерисовать (после смены языка). */
  refresh(): void;
}

export function createStartScreen(root: HTMLElement, grid: HTMLElement, filter: HTMLInputElement, back: HTMLButtonElement, games: readonly GamePreset[], onPick: (id: string) => void): StartScreen {
  let last: string | null = null;
  const render = () => {
    const q = filter.value.trim().toLowerCase();
    grid.textContent = '';
    for (const group of [...new Set(games.map((g) => g.group))]) {
      const list = games.filter((g) => { const x = presetText(g); return g.group === group && (!q || `${x.title} ${g.title} ${g.id} ${x.hint}`.toLowerCase().includes(q)); });
      if (!list.length) continue;
      const h = document.createElement('h3');
      h.textContent = presetText(list[0]!).group;
      const box = document.createElement('div');
      box.className = 'cards';
      for (const g of list) {
        const b = document.createElement('button');
        b.className = 'card' + (g.id === last ? ' last' : '');
        b.dataset.game = g.id;
        const x = presetText(g);
        b.title = x.hint;
        const ttl = document.createElement('b');
        ttl.textContent = x.title;
        if (g.status && g.status !== 'stable') { const s = document.createElement('span'); s.className = 'badge'; s.textContent = t(g.status === 'beta' ? 'badge.beta' : 'badge.bridge'); ttl.append(s); }
        const sub = document.createElement('small');
        sub.textContent = g.id === last ? t('start.last') : x.hint.split(/[.;]/)[0]!.slice(0, 80);
        b.append(ttl, sub);
        b.onclick = () => onPick(g.id);
        box.append(b);
      }
      grid.append(h, box);
    }
    if (!grid.childElementCount) grid.textContent = t('start.none');
  };
  filter.oninput = render;
  filter.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const first = grid.querySelector<HTMLButtonElement>('.card');
    if (first) first.click();
  };
  const hide = () => { root.hidden = true; };
  back.onclick = hide;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden && !back.hidden) hide(); });
  return {
    show(current, canGoBack = false) {
      last = current;
      back.hidden = !canGoBack;
      root.hidden = false;
      render();
      filter.focus();
    },
    hide,
    refresh: () => { if (!root.hidden) render(); },
    get visible() { return !root.hidden; },
  };
}
