// Отладка: простой программный рендер модели в PPM (без браузера). Не часть сборки.
import { writeFileSync } from 'node:fs';
import type { Model } from '../packages/gmv/src/index';
export function renderPPM(m: Model, out: string, opt: { yaw?: number; pitch?: number; zUp?: boolean; tex?: Map<number, { width: number; height: number; rgba?: Uint8Array }>; clipY?: number; W?: number; H?: number } = {}) {
  const W = opt.W ?? 900, H = opt.H ?? 700, zb = new Float32Array(W * H).fill(-1e9), img = Buffer.alloc(W * H * 3, 40);
  // скелет: вершины в текущей позе (как в шейдере: сумма весов skin-матриц)
  const posed = m.meshes.map((me) => {
    const sk = m.skeleton;
    if (!sk) return me.pos;
    const out = new Float32Array(me.vertexCount * 3);
    for (let v = 0; v < me.vertexCount; v++) {
      const x = me.pos[v * 3]!, y = me.pos[v * 3 + 1]!, z = me.pos[v * 3 + 2]!;
      let ws = 0;
      for (let k = 0; k < 4; k++) {
        const w = me.weight[v * 4 + k]!;
        if (!w) continue;
        ws += w;
        const M = sk.skinV[me.bone[v * 4 + k]!]!;
        out[v * 3] += w * (M[0]! * x + M[4]! * y + M[8]! * z + M[12]!);
        out[v * 3 + 1] += w * (M[1]! * x + M[5]! * y + M[9]! * z + M[13]!);
        out[v * 3 + 2] += w * (M[2]! * x + M[6]! * y + M[10]! * z + M[14]!);
      }
      if (!ws) { out[v * 3] = x; out[v * 3 + 1] = y; out[v * 3 + 2] = z; }
    }
    return out;
  });
  const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const P of posed) for (let v = 0; v < P.length; v += 3) for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k]!, P[v + k]!); b.max[k] = Math.max(b.max[k]!, P[v + k]!); }
  const c = [0, 1, 2].map((k) => (b.min[k]! + b.max[k]!) / 2), size = Math.max(...[0, 1, 2].map((k) => b.max[k]! - b.min[k]!)) || 1, sc = (Math.min(W, H) * 0.8) / size;
  const yaw = opt.yaw ?? 0.6, pitch = opt.pitch ?? 0.3, cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const tr = (x0: number, y0: number, z0: number) => {
    let x = x0 - c[0]!, y = y0 - c[1]!, z = z0 - c[2]!;
    if (opt.zUp) [y, z] = [z, -y]; // в Y-up
    if (m.flipZ) z = -z;
    const X = cy * x + sy * z, Z = -sy * x + cy * z;
    const Y2 = cp * y - sp * Z, D = sp * y + cp * Z;
    return [W / 2 + X * sc, H / 2 - Y2 * sc, D];
  };
  m.meshes.forEach((me, mi) => {
    const col = me.color ?? [0.8, 0.75, 0.6], t = opt.tex?.get(mi);
    for (let i = 0; i < me.indices.length; i += 3) {
      const ids = [me.indices[i]!, me.indices[i + 1]!, me.indices[i + 2]!];
      const P = posed[mi]!;
      if (opt.clipY !== undefined && ids.some((v) => P[v * 3 + 1]! > opt.clipY!)) continue; // разрез: убрать всё выше (потолки)
      const p = ids.map((v) => tr(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!));
      const e1 = [0, 1, 2].map((k) => P[ids[1]! * 3 + k]! - P[ids[0]! * 3 + k]!), e2 = [0, 1, 2].map((k) => P[ids[2]! * 3 + k]! - P[ids[0]! * 3 + k]!);
      const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!, ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!, nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
      const nl = Math.hypot(nx, ny, nz) || 1, sh = 0.35 + 0.65 * Math.abs((nx * 0.3 + (opt.zUp ? nz : ny) * 0.8 + 0.5 * (opt.zUp ? ny : nz)) / nl);
      const [a, bb, d] = p as number[][];
      const den = (bb![1]! - d![1]!) * (a![0]! - d![0]!) + (d![0]! - bb![0]!) * (a![1]! - d![1]!);
      if (!den) continue;
      const minx = Math.max(0, Math.floor(Math.min(a![0]!, bb![0]!, d![0]!))), maxx = Math.min(W - 1, Math.ceil(Math.max(a![0]!, bb![0]!, d![0]!)));
      const miny = Math.max(0, Math.floor(Math.min(a![1]!, bb![1]!, d![1]!))), maxy = Math.min(H - 1, Math.ceil(Math.max(a![1]!, bb![1]!, d![1]!)));
      for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
        const l1 = ((bb![1]! - d![1]!) * (x - d![0]!) + (d![0]! - bb![0]!) * (y - d![1]!)) / den, l2 = ((d![1]! - a![1]!) * (x - d![0]!) + (a![0]! - d![0]!) * (y - d![1]!)) / den, l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const z = l1 * a![2]! + l2 * bb![2]! + l3 * d![2]!;
        if (z <= zb[y * W + x]!) continue;
        zb[y * W + x] = z;
        let rgb = col;
        if (t?.rgba) {
          const u = l1 * me.uv[ids[0]! * 2]! + l2 * me.uv[ids[1]! * 2]! + l3 * me.uv[ids[2]! * 2]!, v = l1 * me.uv[ids[0]! * 2 + 1]! + l2 * me.uv[ids[1]! * 2 + 1]! + l3 * me.uv[ids[2]! * 2 + 1]!;
          const tx = ((Math.floor(u * t.width) % t.width) + t.width) % t.width, ty = ((Math.floor(v * t.height) % t.height) + t.height) % t.height, o = (ty * t.width + tx) * 4;
          rgb = [t.rgba[o]! / 255, t.rgba[o + 1]! / 255, t.rgba[o + 2]! / 255];
        }
        for (let k = 0; k < 3; k++) img[(y * W + x) * 3 + k] = Math.min(255, 255 * rgb[k]! * sh);
      }
    }
  });
  writeFileSync(out, Buffer.concat([Buffer.from(`P6 ${W} ${H} 255\n`), img]));
}
