import { describe, expect, it } from 'vitest';
import { lzhufDecompress } from '../src/core/codecs/lzhuf';
import { openXrayDb, resetSocKeys } from '../src/engines/xray/db';
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

import { findSocKey, peDataWords } from '../src/engines/xray/soc-key';
import { makePe, makeSocDb } from './helpers/xray';
import { ViewerSession } from '../src/index';

describe('X-Ray: зашифрованные архивы «Тени Чернобыля»', () => {
  const key = { tableSeed: 0x1a2b3c4d, encryptSeed: 0x5e6f7081, iterations: 2048 };
  const noise = Array.from({ length: 300 }, (_, i) => (Math.imul(i + 1, 0x9e3779b1) >>> 0) | 0x10000);
  const exe = makePe([...noise.slice(0, 150), key.tableSeed, ...noise.slice(150, 200), key.encryptSeed, ...noise.slice(200)]);
  const files = [{ path: 'meshes\\actors\\x.ogf', data: enc('OGF-data-0123456789') }, { path: 'config\\system.ltx', data: enc('[sec]\r\nk = v\r\n') }];

  it('ключ находится в данных исполняемого файла: перебор кандидатов, проверка распаковкой таблицы', () => {
    expect(peDataWords(exe)).toContain(key.tableSeed);
    expect(peDataWords(exe)).not.toContain(0xdeadbeef); // код не перебирается
    const db = makeSocDb(files, key), dv = new DataView(db.buffer);
    const tabAt = 8 + dv.getUint32(4, true), probe = db.subarray(tabAt + 8);
    expect(findSocKey(exe, probe, (t) => t.length > 16)).toEqual(key);
    expect(findSocKey(makePe(noise), probe, (t) => t.length > 16)).toBeNull();
  });

  it('.db ТЧ открывается, если вместе с архивом выбран XR_3DA.exe; без него — понятная ошибка', async () => {
    const db = makeSocDb(files, key);
    await expect(openXrayDb(file(db, 'gamedata.db0'))).rejects.toThrow(/XR_3DA\.exe/);
    const a = await openXrayDb(file(db, 'gamedata.db0'), [file(exe, 'XR_3DA.exe')]);
    expect(a.entries.map((e) => e.path)).toEqual(['meshes/actors/x.ogf', 'config/system.ltx']);
    expect(new TextDecoder().decode(await a.read(a.entries[1]!))).toContain('[sec]');
  });

  it('«Открыть .db…» в два шага: сначала XR_3DA.exe (запоминается), затем архивы', async () => {
    resetSocKeys();
    const s = new ViewerSession(createRegistry(allEngines), 'stalker-soc'), log: string[] = [];
    s.on('status', (e) => log.push(e.text));
    await s.addArchives([file(exe, 'XR_3DA.exe')]);
    expect(log.at(-1)).toMatch(/Запомнено: XR_3DA\.exe/);
    await s.addArchives([file(makeSocDb(files, key), 'gamedata.db0')]);
    expect(s.archives.map((a) => a.entries.length)).toEqual([2]);
  });

  it('без исполняемого файла — в ошибке сказано, что exe не выбран', async () => {
    resetSocKeys();
    await expect(openXrayDb(file(makeSocDb(files, key), 'gamedata.db0'))).rejects.toThrow(/Исполняемых файлов игры среди выбранных нет/);
    await expect(openXrayDb(file(makeSocDb(files, key), 'gamedata.db0'), [file(makePe(noise), 'XR_3DA.exe')])).rejects.toThrow(/ключ не найден/);
  });

  it('«Папка игры» ТЧ: gamedata.db* открываются сами, ключ — из bin/XR_3DA.exe', async () => {
    resetSocKeys();
    const s = new ViewerSession(createRegistry(allEngines), 'stalker-soc');
    const folder = await s.addFolderAsync([file(makeSocDb(files, key), 'gamedata.db0', 'SoC/gamedata.db0'), file(exe, 'XR_3DA.exe', 'SoC/bin/XR_3DA.exe'), file(enc('x'), 'fsgame.ltx', 'SoC/fsgame.ltx')]);
    expect(await s.openFolderArchives(folder)).toBe(1);
    expect(s.archives[1]!.entries.length).toBe(2);
  });
});
