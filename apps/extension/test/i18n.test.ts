// Языки интерфейса: одинаковый набор ключей, все ключи разметки есть в словарях, тексты пресетов и экспорта переведены.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegistry, engineTitle, exporterText, presetText, setLocale, tr } from '@gmvjs/core';
import { allEngines } from '@gmvjs/all';
import { DICTS, LANGS, matchBrowserLang } from '../src/viewer/i18n';

const root = resolve(__dirname, '..');
const CODE = ['main.ts', 'start.ts', 'layers.ts', 'export-dialog.ts'].map((f) => 'src/viewer/' + f);

describe('языки интерфейса', () => {
  it('русский и английский словари интерфейса — одинаковые ключи, без пустых строк', () => {
    expect(Object.keys(DICTS.en).sort()).toEqual(Object.keys(DICTS.ru).sort());
    for (const d of Object.values(DICTS)) for (const v of Object.values(d)) expect(v.trim()).not.toBe('');
  });

  it('все ключи разметки viewer.html и t() в коде есть в словаре', () => {
    const html = ['viewer.html', 'popup.html', 'sidebar.html'].map((f) => readFileSync(resolve(root, f), 'utf8')).join('\n');
    const keys = [...html.matchAll(/data-i(?:-title|-ph|-aria)?="([^"]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(40);
    const code = [...CODE, 'src/mini/main.ts'].map((f) => readFileSync(resolve(root, f), 'utf8')).join('\n');
    keys.push(...[...code.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]!));
    for (const k of new Set(keys)) expect(DICTS.ru[k], k).toBeDefined();
  });

  it('в коде интерфейса не осталось русских строк вне словаря', () => {
    for (const f of [...CODE, 'src/mini/main.ts', 'src/background.ts']) {
      const lines = readFileSync(resolve(root, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\/\/.*$|\/\*.*?\*\//g, ''));
      expect(lines.filter((l) => /['"`][^'"`]*[А-Яа-яЁё]/.test(l)), f).toEqual([]);
    }
  });

  it('пресеты, группы и экспорт по-английски; библиотека переключает статусы и слои', () => {
    const reg = createRegistry(allEngines);
    // тексты движка — только про его собственные пресеты и выгрузку
    for (const e of reg.engines) {
      for (const id of Object.keys(e.i18n?.en?.presets ?? {})) expect(e.games?.some((g) => g.id === id), `${e.id}: ${id}`).toBe(true);
      for (const id of Object.keys(e.i18n?.en?.exporters ?? {})) expect(e.exporters?.some((x) => x.id === id), `${e.id}: ${id}`).toBe(true);
    }
    setLocale('en');
    try {
      for (const g of reg.games) {
        const x = presetText(g);
        expect(`${x.title} ${x.hint} ${x.group} ${x.archiveLabel ?? ''} ${x.motionLabel ?? ''}`, g.id).not.toMatch(/[А-Яа-яЁё]/);
      }
      for (const e of reg.engines) expect(engineTitle(e), e.id).not.toMatch(/[А-Яа-яЁё]/);
      for (const e of reg.exporters) {
        const x = exporterText(e);
        expect(`${x.title} ${x.description} ${e.fields.map((f) => Object.values(x.field(f)).join(' ')).join(' ')}`, e.id).not.toMatch(/[А-Яа-яЁё]/);
      }
      expect(tr('session.loaded', { name: 'a.md2' })).toBe('Loaded: a.md2');
    } finally { setLocale('ru'); }
    expect(tr('session.loaded', { name: 'a.md2' })).toBe('Загружено: a.md2');
  });

  it('манифест: название и описание из _locales (en по умолчанию, ru)', () => {
    const base = JSON.parse(readFileSync(resolve(root, 'manifests/base.json'), 'utf8'));
    expect(base.default_locale).toBe('en');
    for (const l of ['en', 'ru']) {
      const m = JSON.parse(readFileSync(resolve(root, `public/_locales/${l}/messages.json`), 'utf8'));
      for (const k of ['appName', 'appDesc', 'actionTitle', 'sidebarTitle', 'menuFull', 'menuSide']) expect(m[k]?.message, `${l}.${k}`).toBeTruthy();
      expect(m.appDesc.message.length, `${l}: description ≤ 132`).toBeLessThanOrEqual(132);
    }
  });

  const placeholders = (v: string) => [...v.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
  const locales = Object.fromEntries(readdirSync(resolve(root, 'src/viewer/locales')).map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(root, 'src/viewer/locales', f), 'utf8')) as Record<string, string>]));

  it('все языки интерфейса: те же ключи, что у английского, без пустых строк, те же {параметры}', () => {
    expect(Object.keys(locales).length).toBe(50);
    for (const [code, d] of Object.entries(locales)) {
      expect(Object.keys(d).sort(), code).toEqual(Object.keys(DICTS.en).sort());
      for (const [k, v] of Object.entries(d)) {
        expect(v.trim(), `${code}.${k}`).not.toBe('');
        expect(placeholders(v), `${code}.${k}`).toEqual(placeholders(DICTS.en[k]!));
      }
    }
  });

  it('список языков = английский, русский и файлы locales; _locales — те же коды и en_AU/en_GB/en_US', () => {
    const codes = LANGS.map(([c]) => c).sort();
    expect(codes).toEqual(['en', 'ru', ...Object.keys(locales)].sort());
    const store = readdirSync(resolve(root, 'public/_locales')).sort();
    expect(store).toEqual([...codes, 'en_AU', 'en_GB', 'en_US'].sort());
    expect(store.length).toBe(55);
  });

  it('язык браузера -> язык интерфейса', () => {
    const cases: Array<[string, string]> = [
      ['ru-RU', 'ru'], ['uk', 'uk'], ['be-BY', 'en'], ['en-US', 'en'], ['en-GB', 'en'], ['de-AT', 'de'], ['pt-BR', 'pt_BR'], ['pt-PT', 'pt_PT'], ['pt', 'pt_BR'],
      ['es-419', 'es_419'], ['es-MX', 'es_419'], ['es-ES', 'es'], ['zh-CN', 'zh_CN'], ['zh-TW', 'zh_TW'], ['zh-Hant-HK', 'zh_TW'], ['zh', 'zh_CN'],
      ['iw', 'he'], ['in-ID', 'id'], ['tl', 'fil'], ['nb-NO', 'no'], ['nn', 'no'], ['xx', 'en'], ['fil-PH', 'fil'],
    ];
    for (const [raw, want] of cases) expect(matchBrowserLang(raw), raw).toBe(want);
  });
});
