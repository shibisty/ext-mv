// Материалы Doom 3 / Quake 4 (.mtr/.mat): имя материала -> diffusemap. Упрощённый сканер токенов.
export function parseMtr(text: string, map: Map<string, string> = new Map()): Map<string, string> {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  const re = /"([^"]*)"|\{|\}|[^\s{}"]+/g;
  let depth = 0, name = '', last = '', cur: { diffuse: string; editor: string; anyMap: string } | null = null, diffuseStage = false, m: RegExpExecArray | null;
  const toks: string[] = [];
  while ((m = re.exec(clean))) toks.push(m[1] !== undefined ? m[1] : m[0]);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!, l = t.toLowerCase();
    if (t === '{') {
      if (depth === 0) { name = last.toLowerCase(); cur = { diffuse: '', editor: '', anyMap: '' }; }
      depth++;
      diffuseStage = depth > 1 ? false : diffuseStage;
    } else if (t === '}') {
      depth--;
      if (depth === 0 && cur) { const p = cur.diffuse || cur.editor || cur.anyMap; /* эффекты (blend add/filter) — первая карта стадии */ if (p && name && !map.has(name)) map.set(name, p); cur = null; }
      diffuseStage = false;
    } else if (depth === 0) { if (l !== 'table' && l !== 'material' && l !== 'skin' && l !== 'particle') last = t; }
    else if (cur) {
      if (l === 'diffusemap' && (toks[i - 1] ?? '').toLowerCase() !== 'blend' && toks[i + 1] && toks[i + 1] !== '{') { if (!cur.diffuse) cur.diffuse = toks[i + 1]!; }
      else if (l === 'qer_editorimage') { if (!cur.editor) cur.editor = toks[i + 1] ?? ''; }
      else if (l === 'blend' && (toks[i + 1] ?? '').toLowerCase() === 'diffusemap') diffuseStage = true;
      else if (l === 'map') {
        let k = i + 1;
        while (/^(clamp|zeroclamp|alphazeroclamp)$/i.test(toks[k] ?? '')) k++;
        const m = toks[k] ?? '';
        if (diffuseStage && !cur.diffuse) cur.diffuse = m;
        else if (!cur.anyMap && m && m !== '{' && m !== '}') cur.anyMap = m;
      }
    }
  }
  return map;
}
