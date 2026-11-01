// Сборка расширения: ZIP-writer (пути через «/», читается нашим же openZip) и манифесты Chrome/Firefox.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openZip } from '../../../packages/gmv/src/index';
// @ts-expect-error — .mjs без типов
import { crc32, zipDir } from '../scripts/zip.mjs';
// @ts-expect-error — .mjs без типов
import { buildManifest } from '../scripts/manifest.mjs';

const root = resolve(__dirname, '..');

describe('zip.mjs', () => {
  it('CRC32 по эталону', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
  it('архив читается, вложенные пути через «/»', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gmv-zip-'));
    mkdirSync(join(dir, 'lib', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{"a":1}');
    writeFileSync(join(dir, 'lib', 'sub', 'big.txt'), 'x'.repeat(5000));
    const out = join(dir, '..', `t-${Date.now()}.zip`);
    zipDir(dir, out);
    const raw = readFileSync(out);
    expect(raw.includes(Buffer.from('lib\\sub'))).toBe(false);
    const a = await openZip(new File([raw], 't.zip'));
    expect(a.entries.map((e) => e.path).sort()).toEqual(['lib/sub/big.txt', 'manifest.json']);
    expect(new TextDecoder().decode(await a.read(a.lookup('lib/sub/big.txt')!))).toBe('x'.repeat(5000));
  });
});

describe('манифесты', () => {
  it('Chrome: service worker, без gecko', () => {
    const m = buildManifest(root, 'chrome');
    expect(m.manifest_version).toBe(3);
    expect(m.background).toEqual({ service_worker: 'background.js' });
    expect(m.browser_specific_settings).toBeUndefined();
    expect(m.content_security_policy.extension_pages).toContain("'wasm-unsafe-eval'");
  });
  it('Firefox: фоновые скрипты, id, минимальная версия, декларация сбора данных', () => {
    const m = buildManifest(root, 'firefox');
    expect(m.background).toEqual({ scripts: ['background.js'] });
    expect(m.browser_specific_settings.gecko.id).toMatch(/@/);
    expect(parseFloat(m.browser_specific_settings.gecko.strict_min_version)).toBeGreaterThanOrEqual(115);
    expect(m.browser_specific_settings.gecko.data_collection_permissions).toEqual({ required: ['none'] });
    expect(m.action.default_title).toBe(buildManifest(root, 'chrome').action.default_title);
  });
});

describe('patch-assimp.mjs', () => {
  it('убирает eval из настоящего assimpjs и модуль продолжает работать', async () => {
    // @ts-expect-error — .mjs без типов
    const { patchAssimp, findEval } = await import('../scripts/patch-assimp.mjs');
    const { createRequire } = await import('node:module');
    const { runInNewContext } = await import('node:vm');
    const require = createRequire(import.meta.url);
    const src = readFileSync(join(require.resolve('assimpjs/package.json'), '..', 'dist', 'assimpjs.js'), 'utf8');
    expect(findEval(src).length).toBeGreaterThan(0);
    const patched = patchAssimp(src);
    expect(findEval(patched)).toEqual([]);
    expect(patchAssimp(patched)).toBe(patched);
    // выполнить пропатченный модуль и сконвертировать OBJ
    const sandbox: Record<string, unknown> = { require, __filename: require.resolve('assimpjs'), __dirname: join(require.resolve('assimpjs'), '..'), module: { exports: {} }, exports: {}, process, console, WebAssembly, TextDecoder, TextEncoder, URL, setTimeout, clearTimeout, performance, Buffer };
    sandbox.globalThis = sandbox;
    runInNewContext(patched.replace('dist/assimpjs.wasm', 'assimpjs.wasm'), sandbox);
    const factory = (sandbox.module as { exports: () => Promise<any> }).exports;
    const ajs = await factory();
    const fl = new ajs.FileList();
    fl.AddFile('t.obj', new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'));
    const r = ajs.ConvertFileList(fl, 'assjson');
    expect(r.IsSuccess()).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(r.GetFile(0).GetContent())).meshes).toHaveLength(1);
  });
});
