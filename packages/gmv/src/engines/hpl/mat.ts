// Материал HPL2 (.mat, XML): текстура в элементе <Diffuse File="..."> (формат не подтверждён — разбор «по возможности»).
export function matDiffuse(xml: string): string {
  const m = /<\s*Diffuse\b[^>]*?\bFile\s*=\s*"([^"]*)"/i.exec(xml);
  return m ? m[1]! : '';
}
