// Материал Source (.vmt, KeyValues): $basetexture.
export function vmtBase(text: string): string {
  const m = /"?\$basetexture"?\s+"?([^"\r\n]+?)"?\s*(?:[\r\n]|$)/i.exec(text);
  return m ? m[1]!.trim() : '';
}
