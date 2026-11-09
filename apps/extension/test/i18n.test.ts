// Языки интерфейса: одинаковый набор ключей, все ключи разметки есть в словарях, тексты пресетов и экспорта переведены.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRegistry, engineTitle, exporterText, presetText, setLocale, tr } from '@gmvjs/core';
import { allEngines } from '@gmvjs/all';
import { DICTS } from '../src/viewer/i18n';

const root = resolve(__dirname, '..');

describe('языки интерфейса', () => {
  it('русский и английский словари интерфейса — одинаковые ключи, без пустых строк', () => {
    expect(Object.keys(DICTS.en).sort()).toEqual(Object.keys(DICTS.ru).sort());
    for (const d of Object.values(DICTS)) for (const v of Object.values(d)) expect(v.trim()).not.toBe('');
  });

  it('все ключи разметки viewer.html и t() в коде есть в словаре', () => {
    const html = readFileSync(resolve(root, 'viewer.html'), 'utf8');
    const keys = [...html.matchAll(/data-i(?:-title|-ph|-aria)?="([^"]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(40);
    const code = ['main.ts', 'start.ts', 'layers.ts', 'export-dialog.ts'].map((f) => readFileSync(resolve(root, 'src/viewer', f), 'utf8')).join('\n');
    keys.push(...[...code.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]!));
    for (const k of new Set(keys)) expect(DICTS.ru[k], k).toBeDefined();
  });

  it('в коде интерфейса не осталось русских строк вне словаря', () => {
    for (const f of ['main.ts', 'start.ts', 'layers.ts', 'export-dialog.ts']) {
      const lines = readFileSync(resolve(root, 'src/viewer', f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\/\/.*$|\/\*.*?\*\//g, ''));
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
      for (const k of ['appName', 'appDesc', 'actionTitle']) expect(m[k]?.message, `${l}.${k}`).toBeTruthy();
    }
  });
});
