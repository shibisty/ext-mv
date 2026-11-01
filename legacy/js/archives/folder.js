// «Папка игры»: loose-файлы выбранной папки как виртуальный архив (список моделей + поиск текстур по пути).
const IMG = /\.(dds|tga|png|jpe?g|bmp|webp)$/;
export const stripExt = (p) => p.replace(/\.[^./]+$/, '');

export function openFolder(files) {
  const entries = [], index = new Map(), byKey = new Map(), byBase = new Map(), bySuffix = new Map();
  let root = '';
  for (const f of files) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/'), path = rel.toLowerCase();
    if (!root && rel.includes('/')) root = rel.split('/')[0];
    const e = { path, file: null, src: f };
    entries.push(e); index.set(path, e);
    const base = path.split('/').pop(); if (!byBase.has(base)) byBase.set(base, e);
    { const sp = path.split('/'); for (let i = 0; i < sp.length; i++) { const k = sp.slice(i).join('/'); if (!bySuffix.has(k)) bySuffix.set(k, e); } }
    if (IMG.test(path)) {            // ключи по всем суффиксам пути: a/b/c, b/c, c — без привязки к корню папки
      const parts = stripExt(path).split('/');
      for (let i = 0; i < parts.length; i++) { const k = parts.slice(i).join('/'); if (!byKey.has(k)) byKey.set(k, e); }
    }
  }
  const arch = {
    name: root || 'папка', version: 0, entries, index, byKey, byBase,
    lookup(p) { return index.get(p) || bySuffix.get(p) || null; },
    async read(e) { return new Uint8Array(await e.src.arrayBuffer()); },
    fileOf(e) {
      if (!e.file) e.file = { name: e.src.name, path: e.path, archive: arch, arrayBuffer: () => e.src.arrayBuffer() };
      return e.file;
    },
  };
  return arch;
}

// Материал HPL2 (.mat, XML): ищем текстуру в элементе <Diffuse File="..."> (формат не подтверждён — разбор «по возможности»)
export function matDiffuse(xml) {
  const m = /<\s*Diffuse\b[^>]*?\bFile\s*=\s*"([^"]*)"/i.exec(xml);
  return m ? m[1] : '';
}

// Материал Source (.vmt, KeyValues): $basetexture
export function vmtBase(text) {
  const m = /"?\$basetexture"?\s+"?([^"\r\n]+?)"?\s*(?:[\r\n]|$)/i.exec(text);
  return m ? m[1].trim() : '';
}
