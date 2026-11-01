// Стартовое окно: карточки игр и форматов по группам, поиск; выбор пускает в просмотр.
import type { GamePreset } from 'gmv';

export interface StartScreen {
  show(current: string | null, canGoBack?: boolean): void;
  hide(): void;
  readonly visible: boolean;
}

export function createStartScreen(root: HTMLElement, grid: HTMLElement, filter: HTMLInputElement, back: HTMLButtonElement, games: readonly GamePreset[], onPick: (id: string) => void): StartScreen {
  let last: string | null = null;
  const render = () => {
    const q = filter.value.trim().toLowerCase();
    grid.textContent = '';
    for (const group of [...new Set(games.map((g) => g.group))]) {
      const list = games.filter((g) => g.group === group && (!q || `${g.title} ${g.id} ${g.hint ?? ''}`.toLowerCase().includes(q)));
      if (!list.length) continue;
      const h = document.createElement('h3');
      h.textContent = group;
      const box = document.createElement('div');
      box.className = 'cards';
      for (const g of list) {
        const b = document.createElement('button');
        b.className = 'card' + (g.id === last ? ' last' : '');
        b.dataset.game = g.id;
        b.title = g.hint ?? '';
        const t = document.createElement('b');
        t.textContent = g.title;
        if (g.status && g.status !== 'stable') { const s = document.createElement('span'); s.className = 'badge'; s.textContent = g.status === 'beta' ? 'бета' : 'мост'; t.append(s); }
        const sub = document.createElement('small');
        sub.textContent = g.id === last ? 'последняя выбранная' : (g.hint ?? '').split(/[.;]/)[0]!.slice(0, 80);
        b.append(t, sub);
        b.onclick = () => onPick(g.id);
        box.append(b);
      }
      grid.append(h, box);
    }
    if (!grid.childElementCount) grid.textContent = 'Ничего не найдено';
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
    get visible() { return !root.hidden; },
  };
}
