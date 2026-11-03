// MF-A A1: круг .omf → чтение → writeOMF → чтение; сравнение ключей (xray-1.7 net1189).
//   npx vite-node tools/omf-roundtrip.ts -- <модель.ogf> <набор.omf> [ещё .omf…] [--out <папка для записанных>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseOGF, parseOMF, parseSMParams, readChunks, OGF } from '../packages/gmv/src/engines/xray/ogf';
import { writeOMF, type OmfInput } from '../packages/gmv/src/engines/xray/write-omf';

const args = process.argv.slice(2);
const oi = args.indexOf('--out'); const OUTDIR = oi >= 0 ? args.splice(oi, 2)[1]! : '';
const [ogfPath, ...omfs] = args;
if (!ogfPath || !omfs.length) { console.error('нужно: <модель.ogf> <набор.omf>…'); process.exit(2); }
const ab = (p: string) => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const ogf = parseOGF(ab(ogfPath));
const boneNames = ogf.bones.map((b) => b.name);
if (OUTDIR) mkdirSync(OUTDIR, { recursive: true });

for (const omfPath of omfs) {
  const buf = ab(omfPath);
  const top = readChunks(buf, 0, buf.byteLength), pc = top.find((x) => x.id === OGF.S_SMPARAMS);
  const params = pc ? parseSMParams(buf, pc) : null;
  const motions = parseOMF(buf, ogf.bones);
  const defs = new Map((params?.defs ?? []).map((d) => [d.name.toLowerCase(), d]));
  const input: OmfInput = {
    bones: boneNames,
    parts: params?.parts.map((p) => ({ name: p.name, bones: p.bones })),
    motions: motions.map((m) => {
      const d = defs.get(m.name.toLowerCase());
      // parseOMF обрезает треки анимации части до её костей; остальным даём позу покоя (в игре их ведёт другая часть)
      return { motion: m, def: d ? { flags: d.flags, boneOrPart: d.boneOrPart, speed: d.speed } : undefined };
    }),
  };
  const out = writeOMF(input);
  const back = parseOMF(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer, ogf.bones);
  let rotDiff = 0, transDiff = 0, missing = 0, checked = 0;
  for (let i = 0; i < motions.length; i++) {
    const a = motions[i]!, b = back[i];
    if (!b || b.name !== a.name || b.frames !== a.frames) { missing++; continue; }
    for (let bi = 0; bi < boneNames.length; bi++) {
      const ta = a.tracks[bi], tb = b.tracks[bi];
      if (!ta) continue;
      if (!tb) { missing++; continue; }
      checked++;
      const nr = ta.rot.length === 4 ? 4 : a.frames * 4;
      for (let k = 0; k < nr; k++) rotDiff = Math.max(rotDiff, Math.abs(ta.rot[ta.rot.length === 4 ? k % 4 : k]! - tb.rot[tb.rot.length === 4 ? k % 4 : k]!));
      const nt = ta.trans.length === 3 ? 3 : a.frames * 3;
      for (let k = 0; k < nt; k++) transDiff = Math.max(transDiff, Math.abs(ta.trans[ta.trans.length === 3 ? k % 3 : k]! - tb.trans[tb.trans.length === 3 ? k % 3 : k]!));
    }
  }
  console.log(`${basename(omfPath)}: движений ${motions.length} → ${back.length}, треков ${checked}, пропало ${missing}; ` +
    `поворот max ${rotDiff} квантов, смещение max ${(transDiff * 1000).toFixed(2)} мм; размер ${buf.byteLength} → ${out.length} байт`);
  if (OUTDIR) writeFileSync(join(OUTDIR, basename(omfPath)), out);
}
