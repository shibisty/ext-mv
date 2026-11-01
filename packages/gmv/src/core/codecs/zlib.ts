// Распаковка zlib / raw deflate через стандартный DecompressionStream (браузеры, Node 18+).
async function run(u8: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array> {
  const stream = new Blob([u8 as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** zlib-поток (с заголовком 78 xx). */
export const inflateZlib = (u8: Uint8Array): Promise<Uint8Array> => run(u8, 'deflate');
/** Сырой deflate (ZIP, метод 8). */
export const inflateRaw = (u8: Uint8Array): Promise<Uint8Array> => run(u8, 'deflate-raw');
