import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseWldClient } from '../packages/gmv/src/engines/lithtech/world';
import { parseMesh, sectionMesh } from '../packages/gmv/src/engines/lithtech/model';
const root = process.argv[2]!;
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.wldclnt') ? [p] : []; });
for (const f of walk(root)) {
  const u = readFileSync(f), c = parseWldClient(u), dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const boxes: Array<number[] | null> = []; const uv: boolean[] = []; const regStart: number[] = [];
  for (const r of c.regions) {
    regStart.push(boxes.length); const m = parseMesh(readFileSync(join(root, '..', r.mesh.replace(/\\/g, '/'))));
    for (let k = 0; k < m.sections.length; k++) {
      // рамка по всем вершинам секции (как в файле: и тени)
      const s = m.sections[k]!; let sm = null; try { sm = sectionMesh(m, k, undefined); } catch {}
      uv.push(!!sm);
      if (!sm) { boxes.push(null); continue; }
      const p = sm.mesh.pos, b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
      for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a]!, p[i + a]!); b[a + 3] = Math.max(b[a + 3]!, p[i + a]!); }
      boxes.push(b); void s;
    }
  }
  const st = new Set<number>();
  for (let o = 0x30; o + 32 <= u.length; o++) {
    const lid = dv.getUint32(o + 28, true);
    for (let r = 0; r < regStart.length; r++) {
      const id = regStart[r]! + lid; if (id >= (regStart[r + 1] ?? boxes.length)) continue; const b = boxes[id]; if (!b) continue;
      let ok = true; for (let a = 0; a < 6 && ok; a++) { const v = dv.getFloat32(o + a * 4, true); if (!(Math.abs(v - b[a]!) <= 1 + Math.abs(b[a]!) * 1e-4)) ok = false; }
      if (ok) st.add(id);
    }
  }
  const uvn = uv.filter(Boolean).length, rest = boxes.map((b, i) => (b && !st.has(i) ? i : -1)).filter((i) => i >= 0);
  const near = rest.filter((i) => { const b = boxes[i]!; return Math.max(...b.map(Math.abs)) < 3000; });
  console.log(f.split('/').pop(), 'uv', uvn, 'static', st.size, 'rest', rest.length, 'nearOrigin', near.length, rest.slice(0, 12).join(','));
}
