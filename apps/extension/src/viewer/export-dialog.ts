// Окно экспорта: варианты выгрузки для открытой модели (из реестра: движки объявляют exporters), поля настроек варианта, запуск.
import { writeZip, type ExportContext, type ExportField, type ExporterPlugin, type ExportValues, type Model, type Registry } from 'gmv';

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

export function createExportDialog(d: ExportDialogDeps): { open(): void } {
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
    desc.textContent = chosen.description;
    for (const f of chosen.fields) {
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
        if (f.placeholder) el.placeholder = f.placeholder;
        if (f.min !== undefined) el.min = String(f.min);
        if (f.step !== undefined) el.step = String(f.step);
      }
      el.id = `exp_${f.id}`;
      if (f.type === 'checkbox') { lab.className = 'cb'; lab.append(el, document.createTextNode(' ' + f.label)); }
      else lab.append(document.createTextNode(f.label), el);
      if (f.hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = f.hint; lab.append(h); }
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
    st.textContent = 'Экспорт…';
    d.status(`Экспорт: ${chosen.title}…`);
    try {
      const r = await chosen.run(cur.model, values(), cur.ctx);
      const zip = writeZip(r.files), url = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url; a.download = `${r.name}.zip`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      rep.hidden = false;
      rep.textContent = r.report.join('\n');
      st.textContent = `Готово: ${r.files.size} файлов, ${(zip.length / 1048576).toFixed(1)} МБ — ${r.name}.zip`;
      d.status(`Экспорт готов: ${r.name}.zip`);
    } catch (e) {
      console.error(e);
      st.textContent = 'Ошибка: ' + (e as Error).message;
      d.status('Ошибка экспорта: ' + (e as Error).message, true);
    } finally { run.disabled = false; }
  };

  return {
    open() {
      cur = d.current();
      if (!cur) { d.status('Сначала загрузите модель или уровень', true); return; }
      const list = d.registry.exportersFor(cur.model, cur.ctx.sourceEngine);
      $('expSource').textContent = `из: ${cur.engineTitle}`;
      targets.textContent = '';
      for (const { exporter: x, recommended } of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'target';
        b.dataset.id = x.id;
        b.setAttribute('role', 'radio');
        const t = document.createElement('b');
        t.textContent = x.title;
        if (recommended) { const r = document.createElement('span'); r.className = 'rec'; r.textContent = 'для этой игры'; t.append(r); }
        const s = document.createElement('small');
        s.textContent = x.description.split('.')[0]!;
        b.append(t, s);
        b.onclick = () => choose(x);
        targets.append(b);
      }
      chosen = null;
      const last = prefGet('last'), pick = list.find((x) => x.exporter.id === last && x.recommended) ?? list[0] ?? list.find((x) => x.exporter.id === last);
      if (pick) choose(pick.exporter); else { desc.textContent = 'Для этой модели вариантов выгрузки пока нет.'; fields.textContent = ''; }
      run.disabled = !pick;
      if (!dlg.open) dlg.showModal();
    },
  };
}
