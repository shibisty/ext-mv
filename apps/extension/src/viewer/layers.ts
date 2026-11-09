// Слои сцены: дерево (геометрия, объекты по классам, меши), видимость галочками, выбор строки.
// Дочерние строки создаются при раскрытии группы; длинные группы показываются порциями.
import { sceneLeaves, type SceneNode } from '@gmvjs/core';
import { t } from './i18n';

const PAGE = 300;

export interface LayersView {
  /** Новое дерево (после загрузки модели). */
  set(tree: SceneNode[]): void;
  /** Подсветить строку узла (раскрыв родителей) или снять подсветку. */
  reveal(id: string | null): void;
  /** Обновить галочку листа (например, видимость меша изменили в другом списке). */
  syncLeaf(id: string): void;
}

export interface LayersHandlers {
  isVisible(leaf: SceneNode): boolean;
  setVisible(leaves: SceneNode[], visible: boolean): void;
  select(node: SceneNode): void;
  focus(node: SceneNode): void;
}

export function createLayers(box: HTMLElement, h: LayersHandlers): LayersView {
  let roots: SceneNode[] = [];
  const parent = new Map<string, SceneNode | null>(), byId = new Map<string, SceneNode>(), open = new Set<string>(), shown = new Map<string, number>();
  const rows = new Map<string, HTMLElement>();
  let current: string | null = null;

  const index = (n: SceneNode, p: SceneNode | null) => { byId.set(n.id, n); parent.set(n.id, p); for (const c of n.children ?? []) index(c, n); };
  const leafCache = new Map<string, SceneNode[]>();
  const leaves = (n: SceneNode) => { let l = leafCache.get(n.id); if (!l) leafCache.set(n.id, (l = sceneLeaves(n))); return l; };

  const checkState = (n: SceneNode): [boolean, boolean] => {
    if (n.kind !== 'group') return [h.isVisible(n), false];
    const ls = leaves(n);
    let on = 0;
    for (const l of ls) if (h.isVisible(l)) on++;
    return [on === ls.length && on > 0, on > 0 && on < ls.length];
  };
  const updateCheck = (n: SceneNode) => {
    const cb = rows.get(n.id)?.querySelector('input');
    if (!cb) return;
    const [c, ind] = checkState(n);
    cb.checked = c; cb.indeterminate = ind;
  };
  const updateAncestors = (n: SceneNode) => { for (let p = parent.get(n.id); p; p = parent.get(p.id)) updateCheck(p); };
  const updateSubtree = (n: SceneNode) => { updateCheck(n); if (open.has(n.id)) for (const c of n.children ?? []) updateSubtree(c); };

  const row = (n: SceneNode, depth: number): HTMLElement => {
    const r = document.createElement('div');
    r.className = 'tn' + (n.kind === 'group' ? ' grp' : '') + (n.id === current ? ' cur' : '');
    r.style.paddingLeft = `${2 + depth * 12}px`;
    r.dataset.id = n.id;
    r.setAttribute('role', 'treeitem');
    const tw = document.createElement('span');
    tw.className = 'tw';
    tw.textContent = n.kind === 'group' ? (open.has(n.id) ? '▾' : '▸') : '';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const [c, ind] = checkState(n);
    cb.checked = c; cb.indeterminate = ind;
    cb.title = t('layers.toggle');
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      h.setVisible(leaves(n), cb.checked);
      updateSubtree(n);
      updateAncestors(n);
    };
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = n.name;
    nm.title = n.name;
    const nt = document.createElement('span');
    nt.className = 'nt';
    nt.textContent = n.note ?? '';
    nt.title = n.note ?? '';
    r.append(tw, cb, nm, nt);
    tw.onclick = (e) => { e.stopPropagation(); toggle(n); };
    r.onclick = () => { if (n.kind === 'group') toggle(n); else h.select(n); };
    r.ondblclick = (e) => { e.preventDefault(); h.focus(n); };
    rows.set(n.id, r);
    return r;
  };

  // Прокрутить только список слоёв: scrollIntoView двигает и все родительские блоки (вплоть до всей страницы).
  const scrollToRow = (r: HTMLElement) => {
    const b = box.getBoundingClientRect(), q = r.getBoundingClientRect();
    if (q.top < b.top) box.scrollTop += q.top - b.top;
    else if (q.bottom > b.bottom) box.scrollTop += q.bottom - b.bottom;
    box.scrollLeft = 0;
  };

  const toggle = (n: SceneNode) => { if (open.has(n.id)) open.delete(n.id); else open.add(n.id); render(); };

  const render = () => {
    const top = box.scrollTop;
    box.textContent = '';
    rows.clear();
    const add = (n: SceneNode, depth: number) => {
      box.append(row(n, depth));
      if (n.kind !== 'group' || !open.has(n.id)) return;
      const kids = n.children ?? [], lim = shown.get(n.id) ?? PAGE;
      for (const c of kids.slice(0, lim)) add(c, depth + 1);
      if (kids.length > lim) {
        const more = document.createElement('div');
        more.className = 'more';
        more.style.paddingLeft = `${34 + depth * 12}px`;
        const b = document.createElement('button');
        b.textContent = t('layers.more', { n: Math.min(PAGE, kids.length - lim), left: kids.length - lim });
        b.onclick = () => { shown.set(n.id, lim + PAGE); render(); };
        more.append(b);
        box.append(more);
      }
    };
    for (const r of roots) add(r, 0);
    box.scrollTop = top;
  };

  return {
    set(tree) {
      roots = tree;
      parent.clear(); byId.clear(); open.clear(); shown.clear(); leafCache.clear();
      current = null;
      for (const r of tree) index(r, null);
      // первый уровень раскрыт; у сцены с объектами — и группа «Объекты»
      for (const r of tree) open.add(r.id);
      render();
    },
    reveal(id) {
      if (current) rows.get(current)?.classList.remove('cur');
      current = id;
      if (!id) return;
      const n = byId.get(id);
      if (!n) return;
      let changed = false;
      const path: SceneNode[] = [n];
      for (let p = parent.get(id); p; p = parent.get(p.id)) path.push(p);
      for (let k = 1; k < path.length; k++) {
        const p = path[k]!, i = (p.children ?? []).indexOf(path[k - 1]!);
        if (!open.has(p.id)) { open.add(p.id); changed = true; }
        // строка в непоказанной порции — расширить порцию
        if (i >= (shown.get(p.id) ?? PAGE)) { shown.set(p.id, i + 1); changed = true; }
      }
      if (changed) render();
      const r = rows.get(id);
      if (r) { r.classList.add('cur'); scrollToRow(r); }
    },
    syncLeaf(id) {
      const n = byId.get(id);
      if (!n) return;
      updateCheck(n);
      updateAncestors(n);
    },
  };
}
