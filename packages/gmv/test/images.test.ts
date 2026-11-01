import { describe, expect, it } from 'vitest';
import { decodeBC7 } from '../src/core/images/bc7';

describe('BC7', () => {
  it('все 8 режимов и разбиения совпадают с эталонным декодером (texture2ddecoder)', () => {
    // 8 рядов по 64 блока: в ряду m — блоки режима m со случайными битами (LCG), разбиения и P-биты вперемешку
    let x = 12345;
    const rnd = () => { x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff; return (x >> 16) & 255; };
    const src = new Uint8Array(8 * 64 * 16);
    for (let mode = 0, o = 0; mode < 8; mode++)
      for (let k = 0; k < 64; k++, o += 16) {
        for (let i = 0; i < 16; i++) src[o + i] = rnd();
        src[o] = (src[o]! & ~((1 << (mode + 1)) - 1) & 255) | (1 << mode);
      }
    const out = decodeBC7(src, 0, 256, 32);
    let h = 0x811c9dc5;
    for (const b of out) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    expect(h.toString(16)).toBe('83f9c9e');
  });
});

import { decodePct } from '../src/engines/spintires/pct';
describe('SnowRunner .pct', () => {
  const chunk = (tag: number, body: number[], at: number) => { const end = at + 6 + body.length; return [tag & 255, tag >> 8, end & 255, (end >> 8) & 255, (end >> 16) & 255, end >>> 24, ...body]; };
  const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
  it('блоки TCIP, размеры, таблица мипов, данные BC7', () => {
    const block = [0x40, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0]; // режим 6
    const parts: number[] = [];
    const add = (tag: number, body: number[]) => parts.push(...chunk(tag, body, parts.length));
    add(0xf0, [0x54, 0x43, 0x49, 0x50]);
    add(0x102, [...u32(4), ...u32(4), ...u32(1), ...u32(1)]);
    add(0xf2, u32(0x33));
    add(0xf9, u32(1));
    add(0x107, [...u32(0), ...u32(16)]);
    add(0xff, block);
    const img = decodePct(Uint8Array.from(parts).buffer);
    expect([img.width, img.height]).toEqual([4, 4]);
    expect(Array.from(img.rgba!)).toEqual(Array.from(decodeBC7(Uint8Array.from(block), 0, 4, 4)));
  });
  it('без заголовка — ошибка', () => expect(() => decodePct(new Uint8Array(16).buffer)).toThrow(/PCT/));
});
