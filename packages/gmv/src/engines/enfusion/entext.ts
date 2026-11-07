// Текстовый формат конфигов Enfusion (.et префабы, .conf, .emat): блоки «Заголовок … [: "{GUID}родитель"] { … }»,
// свойства «Ключ значение…» по строке, элементы массивов — строки без ключа. Наследование: свойства родителя, поверх —
// свои; дочерние блоки сливаются по одинаковому заголовку (класс + имя/GUID), новые добавляются.

export interface EnfNode {
  /** Токены заголовка до «:» (например ['RegisteringComponentSlotInfo', 'Door_L01'] или ['MeshObject', '{51DA…}']). */
  header: string[];
  parent?: string;
  props: Map<string, string[]>;
  items: string[];
  children: EnfNode[];
  /** «Ключ + { … }» — элементы дописываются к унаследованным, а не заменяют их. */
  append?: boolean;
}

type Tok = { t: string; q: boolean } | null; // null — перевод строки

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '\n') { out.push(null); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== '"') { if (src[j] === '\\' && j + 1 < n) j++; s += src[j]; j++; }
      out.push({ t: s, q: true }); i = j + 1; continue;
    }
    if (c === '{' || c === '}' || c === ':') { out.push({ t: c, q: false }); i++; continue; }
    let j = i;
    while (j < n && !/[\s{}"]/.test(src[j]!) && !(src[j] === ':' && j > i && /[\s"]/.test(src[j + 1] ?? ' '))) j++;
    out.push({ t: src.slice(i, j), q: false }); i = j;
  }
  return out;
}

export function parseEnfText(src: string): EnfNode {
  const toks = tokenize(src);
  let p = 0;
  const body = (node: EnfNode): void => {
    for (;;) {
      while (p < toks.length && toks[p] === null) p++;
      if (p >= toks.length) return;
      if (toks[p]!.t === '}' && !toks[p]!.q) { p++; return; }
      const line: Array<{ t: string; q: boolean }> = [];
      let open = false;
      while (p < toks.length && toks[p] !== null) {
        const k = toks[p]!;
        if (!k.q && k.t === '{') { open = true; p++; break; }
        if (!k.q && k.t === '}') break;
        line.push(k); p++;
      }
      if (open) {
        const ci = line.findIndex((k) => !k.q && k.t === ':');
        const head = (ci >= 0 ? line.slice(0, ci) : line).filter((k) => k.q || k.t !== '+').map((k) => k.t);
        const child: EnfNode = { header: head, props: new Map(), items: [], children: [] };
        if ((ci >= 0 ? line.slice(0, ci) : line).some((k) => !k.q && k.t === '+')) child.append = true;
        if (ci >= 0 && line[ci + 1]) child.parent = line[ci + 1]!.t;
        node.children.push(child);
        body(child);
        continue;
      }
      if (!line.length) continue;
      if (line[0]!.q) {
        // «"Sort Priority" 1» — ключ в кавычках со значением; «"a" "b"» — элементы массива
        if (line.length > 1 && !line[1]!.q) node.props.set(line[0]!.t, line.slice(1).map((k) => k.t));
        else node.items.push(...line.map((k) => k.t));
        continue;
      }
      node.props.set(line[0]!.t, line.slice(1).map((k) => k.t));
    }
  };
  const root: EnfNode = { header: [], props: new Map(), items: [], children: [] };
  body(root);
  return root;
}

const keyOf = (n: EnfNode) => n.header.join(' ');

/** Наложить потомка на родителя (копия родителя, поверх — свойства и блоки потомка). */
export function mergeEnf(base: EnfNode, over: EnfNode): EnfNode {
  const out: EnfNode = { header: over.header.length ? over.header : base.header, parent: over.parent ?? base.parent, props: new Map(base.props), items: over.append ? [...base.items, ...over.items] : over.items.length ? over.items : base.items, children: [] };
  if (over.append && base.append) out.append = true;
  for (const [k, v] of over.props) out.props.set(k, v);
  const used = new Set<EnfNode>();
  for (const bc of base.children) {
    const oc = over.children.find((c) => !used.has(c) && keyOf(c) === keyOf(bc));
    if (oc) { used.add(oc); out.children.push(mergeEnf(bc, oc)); } else out.children.push(bc);
  }
  for (const oc of over.children) if (!used.has(oc)) out.children.push(oc);
  return out;
}

export const enfChild = (n: EnfNode | undefined, cls: string): EnfNode | undefined => n?.children.find((c) => c.header[0] === cls || c.header[1] === cls);
export const enfChildren = (n: EnfNode | undefined, cls: string): EnfNode[] => n?.children.filter((c) => c.header[0] === cls || c.header[1] === cls) ?? [];
export const enfProp = (n: EnfNode | undefined, key: string): string | undefined => n?.props.get(key)?.join(' ');
export const enfVec = (n: EnfNode | undefined, key: string): [number, number, number] | null => {
  const v = n?.props.get(key)?.map(Number);
  return v && v.length >= 3 && v.every(Number.isFinite) ? [v[0]!, v[1]!, v[2]!] : null;
};
