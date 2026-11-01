// Терпимый разбор XML классов Spintires/MudRunner: несколько корней, «_templates», комментарии, без DTD.
export interface XEl { tag: string; attrs: Record<string, string>; children: XEl[]; parent: XEl | null }

export function parseXml(text: string): XEl {
  const root: XEl = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root, i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); i = e < 0 ? text.length : e + 3; continue; }
    if (text[lt + 1] === '?' || text[lt + 1] === '!') { const e = text.indexOf('>', lt); i = e < 0 ? text.length : e + 1; continue; }
    // конец тега с учётом кавычек
    let j = lt + 1, q = '';
    for (; j < text.length; j++) { const c = text[j]!; if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    const body = text.slice(lt + 1, j);
    i = j + 1;
    if (body.startsWith('/')) { if (cur.parent) cur = cur.parent; continue; }
    const self = body.endsWith('/'), inner = self ? body.slice(0, -1) : body;
    const m = /^\s*([\w.:-]+)/.exec(inner);
    if (!m) continue;
    const el: XEl = { tag: m[1]!, attrs: {}, children: [], parent: cur };
    for (const a of inner.slice(m[0].length).matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) el.attrs[a[1]!] = a[3] ?? a[4] ?? '';
    cur.children.push(el);
    if (!self) cur = el;
  }
  return root;
}

export const find = (el: XEl, tag: string): XEl | undefined => {
  for (const c of el.children) { if (c.tag === tag) return c; const d = find(c, tag); if (d) return d; }
  return undefined;
};
export const findAll = (el: XEl, tag: string, out: XEl[] = []): XEl[] => {
  for (const c of el.children) { if (c.tag === tag) out.push(c); findAll(c, tag, out); }
  return out;
};

/** Атрибуты с учётом «_template»: шаблоны ищутся в <_templates> по имени (любой глубины). */
export function attrsOf(el: XEl, root: XEl): Record<string, string> {
  const t = el.attrs._template;
  if (!t) return el.attrs;
  const tpls = findAll(root, '_templates');
  for (const tp of tpls) {
    const hit = find(tp, t);
    if (hit) return { ...attrsOf(hit, root), ...el.attrs };
  }
  return el.attrs;
}

/** «(1.5; 0.3; -0.2)» -> [1.5, 0.3, -0.2]. */
export const vec3 = (s: string | undefined): [number, number, number] => {
  const m = (s ?? '').replace(/[()]/g, '').split(/[;,]/).map((x) => parseFloat(x));
  return [m[0] || 0, m[1] || 0, m[2] || 0];
};
export const num = (s: string | undefined, def = 0): number => { const v = parseFloat(s ?? ''); return Number.isFinite(v) ? v : def; };
