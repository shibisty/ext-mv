import { readFileSync } from 'node:fs';
import { parseMdl } from '../packages/gmv/src/engines/lithtech/model';
const s = parseMdl(readFileSync(process.argv[2]!)); console.log(s.anims.length, s.anims.slice(0, 40).map((a) => a.name).join(' '));
