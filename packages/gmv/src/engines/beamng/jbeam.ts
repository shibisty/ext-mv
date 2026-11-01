// JBeam (BeamNG.drive): «JSON с вольностями» — комментарии, висячие и пропущенные запятые. Плюс вычисление выражений "$=…".

export type JValue = string | number | boolean | null | JValue[] | { [k: string]: JValue };

/** Разбор jbeam/pc/materials.json: комментарии // и /* *\/, запятые необязательны. */
export function parseJbeam(text: string): JValue {
  let i = 0;
  const n = text.length;
  const skip = () => {
    for (;;) {
      while (i < n && /[\s,]/.test(text[i]!)) i++;
      if (text[i] === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      if (text[i] === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      break;
    }
  };
  const err = (msg: string) => { const line = text.slice(0, i).split('\n').length; return new Error(`jbeam: ${msg} (строка ${line})`); };
  const value = (): JValue => {
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const o: { [k: string]: JValue } = {};
      for (;;) {
        skip();
        if (text[i] === '}') { i++; return o; }
        if (i >= n) throw err('незакрытый объект');
        const k = value();
        skip();
        if (text[i] !== ':') throw err('ожидалось «:»');
        i++;
        o[String(k)] = value();
      }
    }
    if (c === '[') {
      i++;
      const a: JValue[] = [];
      for (;;) {
        skip();
        if (text[i] === ']') { i++; return a; }
        if (i >= n) throw err('незакрытый массив');
        a.push(value());
      }
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') { const e = text[i + 1]!; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; i += 2; }
        else s += text[i++];
      }
      i++;
      return s;
    }
    const m = /^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|true|false|null|nil|-?inf|nan)/i.exec(text.slice(i, i + 40));
    if (!m) throw err(`неожиданный символ «${c ?? 'конец'}»`);
    i += m[0].length;
    const t = m[0].toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null' || t === 'nil') return null;
    if (t === 'inf') return Infinity;
    if (t === '-inf') return -Infinity;
    if (t === 'nan') return NaN;
    return +m[0];
  };
  const v = value();
  return v;
}

// ---------- выражения "$=…" (подмножество Lua, как в BeamNG) ----------
export type Vars = Map<string, number | string | boolean | null>;
type V = number | string | boolean | null;

/** Значение поля jbeam: число, "$var" или "$=выражение". */
export function evalValue(v: JValue | undefined, vars: Vars): V {
  if (typeof v !== 'string') return (v ?? null) as V;
  if (v.startsWith('$=')) return evalExpr(v.slice(2), vars);
  if (/^\$[A-Za-z_]\w*$/.test(v)) return vars.has(v) ? vars.get(v)! : null;
  return v;
}
export const evalNumber = (v: JValue | undefined, vars: Vars, def = 0): number => {
  const r = evalValue(v, vars);
  return typeof r === 'number' && Number.isFinite(r) ? r : typeof r === 'boolean' ? +r : def;
};

const FUNCS: Record<string, (...a: V[]) => V> = {
  case: (...a) => { for (let k = 0; k + 1 < a.length; k += 2) if (a[k] !== null && a[k] !== false) return a[k + 1]!; return a.length % 2 ? a[a.length - 1]! : null; },
  min: (...a) => Math.min(...a.map(Number)),
  max: (...a) => Math.max(...a.map(Number)),
  abs: (a) => Math.abs(Number(a)),
  clamp: (x, lo, hi) => Math.min(Number(hi), Math.max(Number(lo), Number(x))),
  round: (x) => Math.round(Number(x)),
  floor: (x) => Math.floor(Number(x)),
  ceil: (x) => Math.ceil(Number(x)),
  sqrt: (x) => Math.sqrt(Number(x)),
  sin: (x) => Math.sin(Number(x)),
  cos: (x) => Math.cos(Number(x)),
  tan: (x) => Math.tan(Number(x)),
  rad: (x) => (Number(x) * Math.PI) / 180,
  deg: (x) => (Number(x) * 180) / Math.PI,
};

export function evalExpr(src: string, vars: Vars): V {
  const toks = src.match(/\$?[A-Za-z_][\w.]*|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+|==|~=|!=|<=|>=|&&|\|\||[-+*/%^()<>,!?:]|"[^"]*"/g) ?? [];
  let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  const truthy = (v: V) => v !== null && v !== false;
  const num = (v: V) => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : Number(v) || 0);
  const primary = (): V => {
    const t = next();
    if (t === undefined) return null;
    if (t === '(') { const v = ternary(); next(); return v; }
    if (t === '-') return -num(unary());
    if (t === 'not' || t === '!') return !truthy(unary());
    if (t.startsWith('"')) return t.slice(1, -1);
    if (/^[\d.]/.test(t)) return +t;
    if (t.startsWith('$')) return vars.has(t) ? vars.get(t)! : null;
    if (t === 'nil') return null;
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (peek() === '(') {
      next();
      const args: V[] = [];
      while (peek() !== ')' && p < toks.length) { args.push(ternary()); if (peek() === ',') next(); }
      next();
      const f = FUNCS[t.replace(/^math\./, '')];
      return f ? f(...args) : null;
    }
    return null;
  };
  const unary = (): V => primary();
  const power = (): V => { let a = unary(); while (peek() === '^') { next(); a = num(a) ** num(unary()); } return a; };
  const mul = (): V => {
    let a = power();
    for (let t = peek(); t === '*' || t === '/' || t === '%'; t = peek()) { next(); const b = num(power()); a = t === '*' ? num(a) * b : t === '/' ? num(a) / b : num(a) % b; }
    return a;
  };
  const add = (): V => { let a = mul(); for (let t = peek(); t === '+' || t === '-'; t = peek()) { next(); const b = num(mul()); a = t === '+' ? num(a) + b : num(a) - b; } return a; };
  const cmp = (): V => {
    let a = add();
    for (let t = peek(); t && ['==', '~=', '!=', '<', '>', '<=', '>='].includes(t); t = peek()) {
      next();
      const b = add();
      a = t === '==' ? a === b : t === '~=' || t === '!=' ? a !== b : t === '<' ? num(a) < num(b) : t === '>' ? num(a) > num(b) : t === '<=' ? num(a) <= num(b) : num(a) >= num(b);
    }
    return a;
  };
  const and = (): V => { let a = cmp(); while (peek() === 'and' || peek() === '&&') { next(); const b = cmp(); a = truthy(a) ? b : a; } return a; };
  const or = (): V => { let a = and(); while (peek() === 'or' || peek() === '||') { next(); const b = and(); a = truthy(a) ? a : b; } return a; };
  const ternary = (): V => { const c = or(); if (peek() === '?') { next(); const a = ternary(); next(); const b = ternary(); return truthy(c) ? a : b; } return c; };
  return ternary();
}
