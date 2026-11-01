// Материал CryEngine (.mtl, XML): текстура Diffuse для каждого подматериала (индекс = MatID подмеша).
export function parseCryMtl(xml: string): string[] {
  const attrs = (tag: string) => { const o: Record<string, string> = {}; tag.replace(/([\w:.-]+)\s*=\s*"([^"]*)"/g, (_, k: string, v: string) => { o[k.toLowerCase()] = v; return ''; }); return o; };
  const diffuseOf = (block: string) => {
    let first = '';
    for (const m of block.matchAll(/<Texture\b[^>]*>/gi)) {
      const a = attrs(m[0]);
      if (!a.file) continue;
      if (/^diffuse$/i.test(a.map ?? '')) return a.file;
      if (!first) first = a.file;
    }
    return first;
  };
  const sub = /<SubMaterials>([\s\S]*?)<\/SubMaterials>/i.exec(xml);
  if (sub) {
    const out: string[] = [], re = /<Material\b[^>]*?(?:\/>|>[\s\S]*?<\/Material>)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sub[1]!))) out.push(diffuseOf(m[0]));
    return out;
  }
  return [diffuseOf(xml)];
}
