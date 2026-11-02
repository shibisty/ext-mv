import { readFileSync } from 'node:fs';
import { parsePrefab } from '../packages/gmv/src/engines/lithtech/world';
import { sectionMesh } from '../packages/gmv/src/engines/lithtech/model';
for (const f of process.argv.slice(2)) { try { const p = parsePrefab(readFileSync(f)); console.log(f, p.mats, p.mesh.decls.map((d) => d.map((e) => e.type + '/' + e.usage).join(' ')), p.mesh.sections.length); for (let k = 0; k < p.mesh.sections.length; k++) { try { const s = sectionMesh(p.mesh, k, undefined); console.log('  ', k, JSON.stringify(p.mesh.sections[k]), s ? s.mesh.vertexCount : null); } catch (e) { console.log('  ', k, (e as Error).message); } } } catch (e) { console.log(f, 'ERR', (e as Error).message); } }
