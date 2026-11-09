// Материал Source (.vmt, KeyValues): $basetexture, «patch»-материалы (include), признаки прозрачности.
export function vmtBase(text: string): string {
  return vmtKey(text, '$basetexture');
}

/** Значение ключа KeyValues (кавычки необязательны, комментарии // пропускаются). */
export function vmtKey(text: string, key: string): string {
  const k = key.replace(/\$/g, '\\$');
  const t = text.replace(/\/\/[^\r\n]*/g, '');
  const m = new RegExp(`(?:^|[\\s{])"?${k}"?[ \\t]+(?:"([^"\\r\\n]*)"|([^\\s"{}]+))`, 'i').exec(t);
  return m ? (m[1] ?? m[2] ?? '').trim() : '';
}

export interface VmtInfo { shader: string; base: string; include: string; alphaTest: boolean; translucent: boolean }

export function vmtInfo(text: string): VmtInfo {
  const shader = (/^\s*"?([\w.]+)"?/.exec(text.replace(/^\uFEFF/, '').replace(/^\s*\/\/.*$/gm, ''))?.[1] ?? '').toLowerCase();
  const on = (k: string) => { const v = vmtKey(text, k); return !!v && v !== '0'; };
  return { shader, base: vmtBase(text), include: shader === 'patch' ? vmtKey(text, 'include') : '', alphaTest: on('$alphatest'), translucent: on('$translucent') || on('$additive') };
}

/** Путь материала/текстуры: «Models\\X\\Y» -> «models/x/y» (без materials/ и расширения). */
export const matStem = (p: string): string => p.replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '').replace(/^materials\//, '').replace(/\.(vmt|vtf|tth)$/, '');
