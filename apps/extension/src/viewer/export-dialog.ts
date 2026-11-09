// Окно экспорта: варианты выгрузки для открытой модели (из реестра: движки объявляют exporters), поля настроек варианта, запуск.
import { exporterText, writeZip, type ExportContext, type ExportField, type ExporterPlugin, type ExportValues, type Model, type Registry } from '@gmvjs/core';

import { t } from './i18n';

const PREF = 'exp:';
const prefGet = (k: string): string | null => { try { return localStorage.getItem(PREF + k); } catch { return null; } };
const prefSet = (k: string, v: string): void => { try { localStorage.setItem(PREF + k, v); } catch { /* приватный режим */ } };

export interface ExportDialogDeps {
  registry: Registry;
  /** Текущая модель и контекст выгрузки (null — модели нет). */
  current(): { model: Model; ctx: ExportContext; engineTitle: string } | null;
  status(text: string, error?: boolean): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function createExportDialog(d: ExportDialogDeps): { open(): void; refresh(): void } {
  const dlg = $<HTMLDialogElement>('dlgExport'), targets = $('expTargets'), fields = $('expFields'), desc = $('expDesc'), rep = $('expReport'), st = $('expStatus'), run = $<HTMLButtonElement>('btnExpRun');
  let chosen: ExporterPlugin | null = null, cur: ReturnType<ExportDialogDeps['current']> = null;
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();

  const defaultOf = (f: ExportField): string | number | boolean | undefined => (typeof f.default === 'function' && cur ? f.default(cur.model, cur.ctx.baseName) : (f.default as string | number | boolean | undefined));

  const renderFields = () => {
    fields.textContent = '';
    inputs.clear();
    rep.hidden = true;
    st.textContent = '';
    if (!chosen || !cur) { desc.textContent = ''; return; }
    const tx = exporterText(chosen);
    desc.textContent = tx.description;
    for (const f of chosen.fields) {
      const ft = tx.field(f);
      if (f.when && !f.when(cur.model)) continue;
      const lab = document.createElement('label'), saved = f.id === 'name' ? null : prefGet(`${chosen.id}.${f.id}`), def = defaultOf(f);
      let el: HTMLInputElement | HTMLSelectElement;
      if (f.type === 'select') {
        el = document.createElement('select');
        for (const o of f.options ?? []) { const op = document.createElement('option'); op.value = o.value; op.textContent = o.label; el.append(op); }
        el.value = saved ?? String(def ?? f.options?.[0]?.value ?? '');
      } else {
        el = document.createElement('input');
        el.type = f.type === 'number' ? 'number' : f.type === 'checkbox' ? 'checkbox' : 'text';
        if (f.type === 'checkbox') el.checked = saved !== null ? saved === '1' : !!def;
        else el.value = saved ?? (def === undefined ? '' : String(def));
        if (ft.placeholder) el.placeholder = ft.placeholder;
        if (f.min !== undefined) el.min = String(f.min);
        if (f.step !== undefined) el.step = String(f.step);
      }
      el.id = `exp_${f.id}`;
      if (f.type === 'checkbox') { lab.className = 'cb'; lab.append(el, document.createTextNode(' ' + ft.label)); }
      else lab.append(document.createTextNode(ft.label), el);
      if (ft.hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = ft.hint; lab.append(h); }
      inputs.set(f.id, el);
      fields.append(lab);
    }
  };

  const choose = (x: ExporterPlugin) => {
    chosen = x;
    prefSet('last', x.id);
    for (const b of targets.querySelectorAll<HTMLElement>('.target')) { const on = b.dataset.id === x.id; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    renderFields();
  };

  const values = (): ExportValues => {
    const v: ExportValues = {};
    for (const [id, el] of inputs) {
      const f = chosen!.fields.find((x) => x.id === id)!;
      v[id] = f.type === 'checkbox' ? (el as HTMLInputElement).checked : f.type === 'number' ? (el.value.trim() === '' ? '' : +el.value) : el.value.trim();
      if (id !== 'name') prefSet(`${chosen!.id}.${id}`, f.type === 'checkbox' ? ((el as HTMLInputElement).checked ? '1' : '0') : el.value);
    }
    return v;
  };

  run.onclick = async () => {
    if (!chosen || !cur) return;
    run.disabled = true;
    st.textContent = t('exp.running');
    d.status(t('exp.statusRunning', { title: exporterText(chosen).title }));
    try {
      const r = await chosen.run(cur.model, values(), cur.ctx);
      const zip = writeZip(r.files), url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url; a.download = `${r.name}.zip`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      rep.hidden = false;
      rep.textContent = r.report.join('\n');
      st.textContent = t('exp.done', { n: r.files.size, mb: (zip.length / 1048576).toFixed(1), name: r.name });
      d.status(t('exp.statusDone', { name: r.name }));
    } catch (e) {
      console.error(e);
      st.textContent = t('exp.error', { error: (e as Error).message });
      d.status(t('exp.statusError', { error: (e as Error).message }), true);
    } finally { run.disabled = false; }
  };

  return {
    open() {
      cur = d.current();
      if (!cur) { d.status(t('exp.noModel'), true); return; }
      const list = d.registry.exportersFor(cur.model, cur.ctx.sourceEngine);
      $('expSource').textContent = t('exp.from', { src: cur.engineTitle });
      targets.textContent = '';
      for (const { exporter: x, recommended } of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'target';
        b.dataset.id = x.id;
        b.setAttribute('role', 'radio');
        const ttl = document.createElement('b');
        const tx = exporterText(x);
        ttl.textContent = tx.title;
        if (recommended) { const r = document.createElement('span'); r.className = 'rec'; r.textContent = t('exp.rec'); ttl.append(r); }
        const s = document.createElement('small');
        s.textContent = tx.description.split('.')[0]!;
        b.append(ttl, s);
        b.onclick = () => choose(x);
        targets.append(b);
      }
      chosen = null;
      const last = prefGet('last'), pick = list.find((x) => x.exporter.id === last && x.recommended) ?? list[0] ?? list.find((x) => x.exporter.id === last);
      if (pick) choose(pick.exporter); else { desc.textContent = t('exp.none'); fields.textContent = ''; }
      run.disabled = !pick;
      if (!dlg.open) dlg.showModal();
    },
    /** После смены языка: открытое окно перестраивается. */
    refresh() { if (dlg.open) this.open(); },
  };
}
