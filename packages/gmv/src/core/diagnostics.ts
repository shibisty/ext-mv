// Текст диагностики для отчёта об ошибке: файл, формат, сигнатура и шестнадцатеричный дамп заголовка.
import { readHead } from './binary';
import type { BlobFile, VFile } from './types';

export function hexDump(u8: Uint8Array, width = 16): string {
  const lines: string[] = [];
  for (let o = 0; o < u8.length; o += width) {
    const row = u8.subarray(o, o + width);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(width * 3 - 1);
    const txt = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${o.toString(16).padStart(4, '0')}  ${hex}  ${txt}`);
  }
  return lines.join('\n');
}

export interface DiagnosticsInput {
  file: VFile | BlobFile;
  format?: string;
  preset?: string;
  error: string;
  appVersion?: string;
}

export async function buildDiagnostics(d: DiagnosticsInput, headBytes = 64): Promise<string> {
  let head: Uint8Array = new Uint8Array(0);
  try { head = await readHead(d.file, headBytes); } catch { /* файл недоступен */ }
  const size = typeof Blob !== 'undefined' && d.file instanceof Blob ? d.file.size : undefined;
  return [
    `gmv ${d.appVersion ?? ''}`.trim(),
    `Файл: ${('path' in d.file && d.file.path) || d.file.name}${size !== undefined ? ` (${size} байт)` : ''}`,
    d.preset ? `Пресет: ${d.preset}` : '',
    d.format ? `Формат: ${d.format}` : '',
    `Ошибка: ${d.error}`,
    `Сигнатура: ${Array.from(head.subarray(0, 4), (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')}`,
    `Заголовок (${head.length} байт):`,
    hexDump(head),
  ].filter(Boolean).join('\n');
}
