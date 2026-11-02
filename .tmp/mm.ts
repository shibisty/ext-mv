import { readFileSync } from 'node:fs';
import { parseMdl, parseMesh, pickLod } from '../packages/gmv/src/engines/lithtech/model';
import { parseGameDb } from '../packages/gmv/src/engines/lithtech/gamedb';
const G = process.env.HOME + '/mnt/FEAR_Online/Game/';
const db = parseGameDb(readFileSync(G + 'database/Loki.gamedb'));
for (const n of process.argv.slice(2)) {
  const m = parseMdl(readFileSync(G + 'charf/mplayer/player/' + n + '.mdl')), me = parseMesh(readFileSync(G + 'charf/mplayer/player/' + n + '.mesh'));
  console.log(n, 'db', JSON.stringify(db.modelMaterials.get('charf/mplayer/player/' + n + '.mdl')));
  for (const k of pickLod(m, me)) console.log('  sec', k, m.sectionPiece.get(k), 'mat', me.sections[k]!.material, 'decl', me.sections[k]!.decl);
}
