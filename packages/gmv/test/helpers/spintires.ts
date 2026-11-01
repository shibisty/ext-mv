// Синтетический MeshCache MudRunner: один узел со статическим мешем (треугольник) и узел коллизии.
import { Bin } from './bin';

export function makeMeshCache(opt: { xml: string; node: string; translate: [number, number, number]; snow?: boolean }): Uint8Array {
  const b = new Bin(), xml = new TextEncoder().encode(opt.xml + '\n\0');
  b.u32(xml.length).bytes(xml);
  b.u32(opt.snow ? 0x0133ef63 : 0x01337b44).u32(2).f32s(0, 0, 0, 1, 1, 1).u32(1);
  // узел 0: корень с мешем
  b.i16(-2).u16(0).u32(1).u32(opt.node.length + 1).cstr(opt.node);
  b.f32s(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...opt.translate, 1);
  b.u32(3).u32(1).u32(5).cstr('mesh');
  b.u32(1).u32(0).u16(0); // флаг, костей 0, номер узла
  b.f32s(0, 0, 0, 1, 1, 0);
  b.u32(1).u32(0).u32(0).u32(1).u32(0).u32(3); // диапазон атрибутов
  b.u32(2); // объявление: позиция FLOAT3, UV FLOAT2, конец
  b.u16(0).u16(0).u8(2).u8(0).u8(0).u8(0);
  b.u16(0).u16(12).u8(1).u8(0).u8(5).u8(0);
  b.u16(0xff).u16(0).u8(17).u8(0).u8(0).u8(0);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1]] as const) b.f32s(x, y, 0, x * 0.5, y * 0.5);
  b.u16(0).u16(1).u16(2);
  b.u32(0); // номер меша
  // узел 1: коллизия неизвестного формата — должна пропуститься поиском
  b.i16(0).u16(1).u32(0).u32(4).cstr('cdt');
  b.f32s(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  b.u32(0x900004).u32(0x12345678).u32(7);
  return b.toU8();
}
