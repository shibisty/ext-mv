import { describe, expect, it } from 'vitest';
import { lzhufDecompress } from '../src/core/codecs/lzhuf';
import { openXrayDb } from '../src/engines/xray/db';
import { createRegistry } from '../src/index';
import { allEngines } from '../src/engines/index';
import { lzhufCompress, makeXrayDb } from './helpers/xray';
import { file } from './helpers/bin';

const enc = (s: string) => new TextEncoder().encode(s);

describe('X-Ray: LZHUF и архивы .db', () => {
  it('LZHUF: короткий текст и длинный поток (перестройка дерева на 0x4000)', () => {
    const short = enc('configs\\\\configs\\\\creatures\\\\abcabcabcabc');
    expect(lzhufDecompress(lzhufCompress(short))).toEqual(short);
    // > 16384 символов: псевдослучайный текст с повторами
    let s = '', x = 12345;
    for (let i = 0; i < 40000; i++) { x = (x * 1103515245 + 12345) >>> 0; s += i % 7 ? String.fromCharCode(97 + (x >> 16) % 26) : 'meshes\\actors\\'; }
    const long = enc(s);
    expect(lzhufDecompress(lzhufCompress(long))).toEqual(long);
  });

  it('LZHUF: неправдоподобный размер (шифрованная таблица ТЧ) — ошибка, а не гигантский буфер', () => {
    expect(() => lzhufDecompress(Uint8Array.from([0x56, 0x1f, 0x21, 0x49, 1, 2, 3]))).toThrow(/неправдоподобный/);
  });

  it('.db: таблица файлов, папки пропускаются, LZO-сжатые файлы', async () => {
    const ogf = enc('OGF-data-0123456789'), ltx = enc('[section]\r\nkey = value\r\n');
    const db = makeXrayDb([{ path: 'meshes\\actors\\x.ogf', data: ogf }, { path: 'configs\\a.ltx', data: ltx, lzo: true }], ['meshes\\', 'configs\\']);
    const a = await openXrayDb(file(db, 'resources.db0'));
    expect(a.entries.map((e) => e.path)).toEqual(['meshes/actors/x.ogf', 'configs/a.ltx']);
    expect(await a.read(a.lookup('meshes/actors/x.ogf')!)).toEqual(ogf);
    expect(await a.read(a.lookup('configs/a.ltx')!)).toEqual(ltx);
  });

  it('.db: определяется реестром по расширению и [header]; испорченная таблица — понятная ошибка', async () => {
    const reg = createRegistry(allEngines), db = makeXrayDb([{ path: 'textures\\a.dds', data: enc('DDS ') }]);
    expect((await reg.archiveFor(file(db, 'resources.db1')))?.id).toBe('xray-db');
    const bad = db.slice();
    bad[bad.length - 3] ^= 0xff; bad[bad.length - 9] ^= 0x5a;
    await expect(openXrayDb(file(bad, 'gamedata.dbb'))).rejects.toThrow(/зашифрована|повреждена/);
  });
});
