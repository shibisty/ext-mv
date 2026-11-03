// Двоичный XML Dunia (XmlResourceFile: worlds/<мир>/generated/<мир>.game.xml и др.).
// u8 0, u8 ?, затем упакованные u32 (u8 < 0xFE или 0xFF + u32): размер таблицы строк, число узлов, число атрибутов;
// узел: имя, значение (смещения в таблице строк), число атрибутов, число детей; атрибут: 0, имя, значение; дети — подряд.
// После дерева — таблица строк (UTF-8, через \0); имена и значения — смещения в ней.

export interface RmlNode { name: string; value: string; attrs: Record<string, string>; children: RmlNode[] }

export function parseRml(u: Uint8Array): RmlNode {
  if (u.length < 5 || u[0] !== 0) throw new Error('Не двоичный XML Dunia');
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let p = 2;
  const pk = () => {
    if (p >= u.length) throw new Error('Двоичный XML обрезан');
    const b = u[p++]!;
    if (b < 0xfe) return b;
    if (b === 0xfe || p + 4 > u.length) throw new Error('Двоичный XML: неверное число');
    const v = dv.getUint32(p, true); p += 4; return v;
  };
  const stSize = pk(); pk(); pk();
  type Raw = { n: number; v: number; a: Array<[number, number]>; c: Raw[] };
  const node = (depth: number): Raw => {
    if (depth > 256) throw new Error('Двоичный XML: слишком глубоко');
    const n = pk(), v = pk(), ac = pk(), cc = pk();
    const a: Array<[number, number]> = [];
    for (let i = 0; i < ac; i++) { pk(); a.push([pk(), pk()]); }
    const c: Raw[] = [];
    for (let i = 0; i < cc; i++) c.push(node(depth + 1));
    return { n, v, a, c };
  };
  const raw = node(0);
  if (p + stSize > u.length) throw new Error('Двоичный XML: таблица строк обрезана');
  const st = u.subarray(p, p + stSize), dec = new TextDecoder('utf-8'), cache = new Map<number, string>();
  const s = (i: number) => {
    let r = cache.get(i);
    if (r === undefined) { let e = st.indexOf(0, i); if (e < 0) e = st.length; r = dec.decode(st.subarray(i, e)); cache.set(i, r); }
    return r;
  };
  const conv = (r: Raw): RmlNode => ({ name: s(r.n), value: s(r.v), attrs: Object.fromEntries(r.a.map(([k, v]) => [s(k), s(v)])), children: r.c.map(conv) });
  return conv(raw);
}

export const rmlChild = (n: RmlNode | undefined, name: string): RmlNode | undefined => n?.children.find((c) => c.name === name);
export const rmlAll = (n: RmlNode | undefined, name: string): RmlNode[] => n?.children.filter((c) => c.name === name) ?? [];

/** Элементы XML по порядку (двоичный XML Dunia или текстовый — как в worlds/tmpla): имя, атрибуты, глубина. */
export function xmlElements(u: Uint8Array): Array<{ name: string; attrs: Record<string, string>; depth: number }> {
  const out: Array<{ name: string; attrs: Record<string, string>; depth: number }> = [];
  if (u[0] === 0) {
    const walk = (n: RmlNode, d: number) => { out.push({ name: n.name, attrs: n.attrs, depth: d }); for (const c of n.children) walk(c, d + 1); };
    walk(parseRml(u), 0);
    return out;
  }
  const text = new TextDecoder('utf-8').decode(u);
  let depth = 0;
  for (const m of text.matchAll(/<(\/?)([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/g)) {
    if (m[1]) { depth--; continue; }
    const attrs: Record<string, string> = {};
    for (const a of m[3]!.matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]!] = a[2]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    out.push({ name: m[2]!, attrs, depth });
    if (!m[4]) depth++;
  }
  return out;
}
