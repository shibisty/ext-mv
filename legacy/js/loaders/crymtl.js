// Материал CryEngine (.mtl, XML): текстура Diffuse для каждого подматериала (индекс = MatID подмеша).
export function parseCryMtl(xml) {
  const attrs = (tag) => { const o = {}; tag.replace(/([\w:.-]+)\s*=\s*"([^"]*)"/g, (_, k, v) => { o[k.toLowerCase()] = v; return ''; }); return o; };
  const diffuseOf = (block) => {
    let first = '';
    for (const m of block.matchAll(/<Texture\b[^>]*>/gi)) { const a = attrs(m[0]); if (!a.file) continue; if (/^diffuse$/i.test(a.map || '')) return a.file; if (!first) first = a.file; }
    return first;
  };
  const sub = /<SubMaterials>([\s\S]*?)<\/SubMaterials>/i.exec(xml);
  if (sub) { const out = [], re = /<Material\b[^>]*?(?:\/>|>[\s\S]*?<\/Material>)/gi; let m; while ((m = re.exec(sub[1]))) out.push(diffuseOf(m[0])); return out; }
  return [diffuseOf(xml)];
}
