// E2E: настоящий Chromium загружает собранное расширение (dist/chrome), открывает просмотрщик и модели.
// Запуск: npm run test:e2e (сначала собирает расширение). Путь к Chromium: CHROMIUM_PATH или Playwright по умолчанию.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeDdsArgb, makeDdsDxt1, makeMd2, makeOgf } from '../../../packages/gmv/test/helpers/fixtures';
import { makeXrayDb } from '../../../packages/gmv/test/helpers/xray';
import { makeOdol, makePaaDxt1, makePbo, rapify } from '../../../packages/gmv/test/helpers/arma';
import { makeYdr } from '../../../packages/gmv/test/helpers/rage';
import { skinnedNif, turnKf } from '../../../packages/gmv/test/helpers/nif';

const ext = resolve(__dirname, '../dist/chrome');
const tmp = mkdtempSync(join(tmpdir(), 'gmv-e2e-'));
const put = (name: string, data: ArrayBuffer | string) => { const p = join(tmp, name); writeFileSync(p, typeof data === 'string' ? data : Buffer.from(data)); return p; };

let ctx: BrowserContext, page: Page, extId = '';
const errors: string[] = [];

beforeAll(async () => {
  ctx = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    acceptDownloads: true,
    headless: false,
    executablePath: process.env.CHROMIUM_PATH || (process.platform === 'linux' ? '/opt/pw-browsers/chromium' : undefined),
    args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
  page = await ctx.newPage();
  await page.setViewportSize({ width: 1100, height: 760 });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`chrome-extension://${extId}/viewer.html`);
});
afterAll(async () => { await ctx?.close(); });

const status = () => page.locator('#status');
const preset = () => page.locator('#btnGame').getAttribute('data-preset');
/** Выбрать игру на стартовом окне (из просмотра — через кнопку игры в верхней панели). */
async function chooseGame(id: string): Promise<void> {
  if (!(await page.locator('#start').isVisible())) await page.locator('#btnGame').click();
  await page.locator(`#gameGrid .card[data-game="${id}"]`).click();
  await expect.poll(() => page.locator('#app').isVisible()).toBe(true);
}
/** Действия в выпадающем меню «Вид». */
async function inView(fn: () => Promise<void>): Promise<void> {
  if (!(await page.locator('#viewMenu').isVisible())) await page.locator('#btnView').click();
  await fn();
  await page.keyboard.press('Escape');
}
/** Есть ли на холсте что-то кроме фона (декодируем скриншот прямо в странице). */
async function drawnPixels(): Promise<number> {
  await page.waitForTimeout(300);
  const png = (await page.locator('#gl').screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, bg = [d[0], d[1], d[2]];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - bg[0]!) + Math.abs(d[i + 1]! - bg[1]!) + Math.abs(d[i + 2]! - bg[2]!) > 30) n++;
    return n;
  }, png);
}

describe('расширение в Chromium', () => {
  it('service worker и страница просмотрщика без ошибок', async () => {
    expect(extId).toMatch(/^[a-p]{32}$/);
    // стартовое окно: карточки игр и форматов, поиск; выбор пускает в просмотр
    expect(await page.locator('#start').isVisible()).toBe(true);
    expect(await page.locator('#app').isVisible()).toBe(false);
    await expect.poll(() => page.locator('#gameGrid .card').count()).toBeGreaterThan(30);
    // язык по умолчанию — по браузеру (здесь английский); дальше тесты идут на русском
    expect(await page.locator('html').getAttribute('lang')).toBe('en');
    expect(await page.locator('#gameFilter').getAttribute('placeholder')).toBe('Search games and formats');
    expect(await page.locator('#gameGrid .card[data-game="stalker-soc"] b').textContent()).toContain('Shadow of Chernobyl');
    await page.locator('#start select.lang').selectOption('ru');
    expect(await page.locator('#gameFilter').getAttribute('placeholder')).toBe('Поиск игры или формата');
    expect(await page.locator('#gameGrid .card[data-game="stalker-soc"] b').textContent()).toContain('Тень Чернобыля');
    await page.locator('#gameFilter').fill('метро');
    expect(await page.locator('#gameGrid .card').count()).toBeLessThan(5);
    await page.locator('#gameFilter').fill('');
    await page.screenshot({ path: resolve(__dirname, '../dist/e2e-start.png') });
    await chooseGame('stalker-soc');
    expect(await preset()).toBe('stalker-soc');
    expect(await page.locator('#gameTitle').textContent()).toContain('Тень Чернобыля');
    expect(errors).toEqual([]);
  });

  it('MD2 + DDS: автопереключение пресета, текстура, отрисовка, анимация', async () => {
    await page.locator('#fileModel').setInputFiles(put('tris.md2', makeMd2()));
    await expect.poll(() => status().textContent()).toContain('Загружено: tris.md2');
    expect(await preset()).toBe('quake2');
    // диффузная + карта нормалей рядом (skin_n): нормаль находится по имени и проверяется на «похожесть»
    // + упакованная PBR-карта skin_orm (AO, шероховатость, металличность)
    await page.locator('#fileTex').setInputFiles([put('skin.dds', makeDdsDxt1(8, 8)), put('skin_n.dds', makeDdsArgb(8, 8, 0xff8080ff)), put('skin_orm.dds', makeDdsArgb(8, 8, 0xffff40c0))]);
    await expect.poll(() => page.locator('#mesh0 .st').textContent()).toBe('8×8 · N 8×8 · PBR M·R·AO');
    expect(await page.locator('#motionSel option').count()).toBe(2);
    await page.locator('#motionSel').selectOption('0');
    expect(await drawnPixels()).toBeGreaterThan(100);
    // режим «нормали цветом»: шейдер с картой нормалей компилируется и рисует
    for (const v of ['1', '2', '3']) {
      await inView(() => page.locator('#selNormView').selectOption(v).then(() => undefined));
      expect(await drawnPixels()).toBeGreaterThan(100);
    }
    await page.screenshot({ path: resolve(__dirname, '../dist/e2e-md2-normals.png') });
    await inView(async () => {
      await page.locator('#selNormView').selectOption('0');
      await page.locator('#rngNI').fill('2');
      await page.locator('#chkPbr').uncheck();
    });
    expect(await drawnPixels()).toBeGreaterThan(100);
    await inView(() => page.locator('#chkPbr').check());
    await page.screenshot({ path: resolve(__dirname, '../dist/e2e-md2.png') });
    // слои: модель и её меш
    expect(await page.locator('#layers .tn').count()).toBeGreaterThanOrEqual(2);
    // экспорт: окно с вариантами (X-Ray SDK, OBJ), поля варианта; ZIP скачивается
    await page.locator('#btnExport').click();
    expect(await page.locator('#dlgExport').isVisible()).toBe(true);
    const ids = await page.locator('#expTargets .target').evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.id));
    expect(ids).toEqual(expect.arrayContaining(['xray-sdk', 'obj']));
    await page.locator('#expTargets .target[data-id="xray-sdk"]').click();
    expect(await page.locator('#exp_instances').count()).toBe(0); // у модели без объектов сцены поля нет
    await page.screenshot({ path: resolve(__dirname, '../dist/e2e-export.png') });
    await page.locator('#exp_name').fill('e2e_md2');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#btnExpRun').click()]);
    expect(dl.suggestedFilename()).toBe('e2e_md2_xray_sdk.zip');
    const zipText = (await readFile((await dl.path())!)).toString('latin1');
    for (const f of ['rawdata/objects/gmv/e2e_md2/e2e_md2.object', 'rawdata/levels/e2e_md2.level', 'rawdata/levels/e2e_md2/scene_object.part', 'gamedata/textures/gmv/e2e_md2/skin.dds']) expect(zipText).toContain(f);
    expect(await page.locator('#expReport').textContent()).toMatch(/Объектов \.object: 1/);
    await page.locator('#expTargets .target[data-id="obj"]').click();
    await page.locator('#exp_name').fill('e2e_md2');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('#btnExpRun').click()]);
    expect(dl2.suggestedFilename()).toBe('e2e_md2_obj.zip');
    const objZip = (await readFile((await dl2.path())!)).toString('latin1');
    for (const f of ['e2e_md2.obj', 'e2e_md2.mtl', 'textures/skin_0.dds']) expect(objZip).toContain(f);
    await page.keyboard.press('Escape');
    expect(await page.locator('#dlgExport').isVisible()).toBe(false);
    expect(errors).toEqual([]);
  });

  it('OBJ через assimp (WASM под CSP расширения)', async () => {
    await chooseGame('obj');
    const obj = put('box.obj', 'mtllib box.mtl\nv -1 -1 0\nv 1 -1 0\nv 1 1 0\nv -1 1 0\nusemtl m\nf 1 2 3\nf 1 3 4\n');
    const mtl = put('box.mtl', 'newmtl m\nKd 0.8 0.2 0.2\n');
    await page.locator('#fileModel').setInputFiles([obj, mtl]);
    await expect.poll(() => status().textContent(), { timeout: 30000 }).toContain('Загружено: box.obj');
    expect(await page.locator('#info').textContent()).toContain('треугольников: 2');
    expect(await drawnPixels()).toBeGreaterThan(100);
    await page.screenshot({ path: resolve(__dirname, '../dist/e2e-obj.png') });
    expect(errors).toEqual([]);
  });

  it('Arma 3: PBO через «Открыть архив», класс оружия из config.bin, PAA', async () => {
    await chooseGame('arma3');
    const quad = { pos: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], uv: [[0, 0], [0.9, 0], [0.9, 0.9], [0, 0.9]], sections: [{ texture: '', faces: [[0, 1, 2, 3]], selection: 'camo' }] };
    const cfg = rapify({ CfgWeapons: { E2E_Gun: { model: '\\e2e\\gun.p3d', displayName: 'E2E', hiddenSelections: ['camo'], hiddenSelectionsTextures: ['\\e2e\\gun_co.paa'] } } });
    const pbo = makePbo('e2e', { 'config.bin': cfg, 'gun.p3d': makeOdol(quad), 'gun_co.paa': makePaaDxt1() });
    await page.locator('#fileArch').setInputFiles(put('e2e.pbo', pbo.slice().buffer));
    await expect.poll(() => page.locator('#archList option').count()).toBeGreaterThan(1);
    const idx = await page.locator('#archList option').evaluateAll((os) => os.findIndex((o) => o.textContent!.includes('e2e_gun.armacfg')));
    expect(idx).toBeGreaterThanOrEqual(0);
    await page.locator('#archList').selectOption(String(idx));
    await expect.poll(() => status().textContent()).toContain('Загружено');
    await expect.poll(() => page.locator('#mesh0 .st').textContent()).toBe('4×4');
    expect(await drawnPixels()).toBeGreaterThan(100);
    await page.screenshot({ path: resolve(__dirname, '../dist/e2e-arma.png') });
    expect(errors).toEqual([]);
  });

  it('GTA V: .ydr (RSC7, распаковка deflate в браузере) со встроенной текстурой', async () => {
    await page.locator('#fileModel').setInputFiles(put('prop.ydr', makeYdr().slice().buffer));
    await expect.poll(() => status().textContent()).toContain('Загружено: prop.ydr');
    expect(await preset()).toBe('gta5');
    await expect.poll(() => page.locator('#mesh0 .st').textContent()).toBe('4×4');
    expect(await drawnPixels()).toBeGreaterThan(50);
    expect(errors).toEqual([]);
  });

  it('Fallout NV: скинованный NIF + анимация .kf', async () => {
    await page.locator('#fileModel').setInputFiles(put('body.nif', skinnedNif()));
    await expect.poll(() => status().textContent()).toContain('Загружено: body.nif');
    await page.locator('#fileOmf').setInputFiles(put('turn.kf', turnKf()));
    await expect.poll(() => page.locator('#motionSel option').count()).toBe(2);
    await page.locator('#motionSel').selectOption({ index: 1 });
    await inView(() => page.locator('#chkSkeleton').check());
    expect(await drawnPixels()).toBeGreaterThan(50);
    await inView(() => page.locator('#chkSkeleton').uncheck());
    expect(errors).toEqual([]);
  });

  it('S.T.A.L.K.E.R.: архив .db (LZHUF-таблица) с OGF и текстурой', async () => {
    await chooseGame('stalker-cs');
    const db = makeXrayDb([{ path: 'meshes\\actors\\e2e.ogf', data: new Uint8Array(makeOgf(false)) }, { path: 'textures\\act\\act_stalker.dds', data: new Uint8Array(makeDdsDxt1(8, 8)) }], ['meshes\\', 'textures\\']);
    await page.locator('#fileArch').setInputFiles(put('resources.db0', db.slice().buffer));
    await expect.poll(() => page.locator('#archList option').count()).toBeGreaterThan(0);
    const idx = await page.locator('#archList option').evaluateAll((os) => os.findIndex((o) => o.textContent!.endsWith('e2e.ogf')));
    expect(idx).toBeGreaterThanOrEqual(0);
    await page.locator('#archList').selectOption(String(idx));
    await expect.poll(() => status().textContent()).toContain('Загружено');
    await expect.poll(() => page.locator('#mesh0 .st').textContent()).toBe('8×8');
    expect(await drawnPixels()).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });

  it('свободная камера: WASD двигает глаз, срез сверху убирает геометрию', async () => {
    // «столбик» высотой 20 (NIF, Z вверх): срез посередине убирает верхнюю половину
    await page.locator('#fileModel').setInputFiles(put('fly.nif', skinnedNif()));
    await expect.poll(() => status().textContent()).toContain('Загружено: fly.nif');
    const before = await drawnPixels();
    expect(before).toBeGreaterThan(100);
    await page.locator('#btnFly').click();
    expect(await page.locator('#lblFlySpeed').textContent()).toMatch(/ед\/с/);
    const eye = () => page.evaluate(() => (globalThis as unknown as { __gmvViewer: { camera: { eye(): number[] } } }).__gmvViewer.camera.eye());
    const eye0 = await eye();
    await page.keyboard.down('KeyW'); await page.waitForTimeout(400); await page.keyboard.up('KeyW');
    const eye1 = await eye();
    expect(Math.hypot(eye1[0]! - eye0[0]!, eye1[1]! - eye0[1]!, eye1[2]! - eye0[2]!)).toBeGreaterThan(0.01);
    await page.locator('#btnOrbit').click();
    await page.locator('#btnCam').click();
    await inView(() => page.locator('#rngClip').fill('500'));
    expect(await page.locator('#lblClip').textContent()).toBe('10.0');
    expect(await drawnPixels()).toBeLessThan(before);
    await inView(() => page.locator('#rngClip').fill('1000'));
    // выбор: инструмент «Выбор», щелчок по модели подсвечивает меш и строку в слоях; Esc снимает выбор
    await page.locator('#toolSelect').click();
    const box = (await page.locator('#gl').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => page.locator('#selInfo').isVisible()).toBe(true);
    expect(await page.locator('#layers .tn.cur').count()).toBe(1);
    expect(await page.locator('#meshList .mesh.cur').count()).toBe(1);
    // выбор не должен сдвигать раскладку (раньше scrollIntoView прокручивал всю страницу)
    expect(await page.evaluate(() => ['html', 'body', '#app', '#right', '#left'].map((s) => { const e = document.querySelector(s)!; return e.scrollLeft + e.scrollTop; }))).toEqual([0, 0, 0, 0, 0]);
    expect((await page.locator('#top').boundingBox())!.x).toBe(0);
    // содержимое правой панели не шире самой панели
    expect(await page.evaluate(() => [...document.querySelectorAll('#right, #right .pane')].every((e) => e.scrollWidth <= e.clientWidth + 1))).toBe(true);
    await page.screenshot({ path: resolve(__dirname, '../dist/e2e-select.png') });
    // «Двигать»: у обычного меша (не объекта сцены) — подсказка, что двигаются только объекты
    await page.locator('#toolMove').click();
    expect(await page.locator('#selInfo').textContent()).toMatch(/только объекты сцены/);
    await page.keyboard.press('Escape');
    expect(await page.locator('#selInfo').isVisible()).toBe(false);
    await page.locator('#toolCamera').click();
    expect(errors).toEqual([]);
  });

  it('смена языка на лету: интерфейс, слои, окно экспорта; выбор запоминается', async () => {
    await page.locator('#fileModel').setInputFiles(put('lang.md2', makeMd2()));
    await expect.poll(() => status().textContent()).toContain('Загружено: lang.md2');
    await page.locator('#top select.lang').selectOption('en');
    expect(await page.locator('#btnFolder').textContent()).toBe('Game folder…');
    expect(await status().textContent()).toBe('Loaded: lang.md2');
    expect(await page.locator('#toolSelect').textContent()).toContain('Select');
    expect(await page.locator('#paneMeshes h2').textContent()).toBe('Meshes and textures');
    expect(await page.locator('#layers .tn').first().textContent()).toContain('Model');
    expect(await page.locator('#gameTitle').textContent()).toBe('Quake II — MD2');
    await page.locator('#btnExport').click();
    expect(await page.locator('#expTargets .target[data-id="xray-sdk"] b').textContent()).toContain('X-Ray SDK 0.7 sources');
    expect(await page.locator('#btnExpRun').textContent()).toBe('Export');
    await page.screenshot({ path: resolve(__dirname, '../dist/e2e-en.png') });
    await page.keyboard.press('Escape');
    await page.reload();
    await expect.poll(() => page.locator('#gameFilter').getAttribute('placeholder')).toBe('Search games and formats');
    await page.locator('#start select.lang').selectOption('ru');
    await chooseGame('quake2');
    expect(await page.locator('#btnFolder').textContent()).toBe('Папка игры…');
    expect(errors).toEqual([]);
  });

  it('ошибка загрузки показывает кнопку диагностики', async () => {
    await chooseGame('quake2');
    const bad = new Uint8Array(makeMd2());
    new DataView(bad.buffer).setInt32(4, 7, true);
    await page.locator('#fileModel').setInputFiles(put('broken.md2', bad.buffer));
    await expect.poll(() => status().textContent()).toContain('Ошибка: Не MD2');
    expect(await page.locator('#btnDiag').isVisible()).toBe(true);
    errors.length = 0; // console.error от загрузчика ожидаем
  });
});
