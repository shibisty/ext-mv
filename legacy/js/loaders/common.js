// Границы модели в bind-позе (для камеры): применяем skin-матрицы NodeSkeleton к вершинам.
export function computeBounds(sk, meshes) {
  sk.pose(null, 0, false);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) for (let v = 0; v < m.vertexCount; v++) {
    const x = m.pos[v * 3], y = m.pos[v * 3 + 1], z = m.pos[v * 3 + 2], o = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const w = m.weight[v * 4 + k]; if (!w) continue; const M = sk.skinV[m.bone[v * 4 + k]];
      o[0] += w * (M[0] * x + M[4] * y + M[8] * z + M[12]); o[1] += w * (M[1] * x + M[5] * y + M[9] * z + M[13]); o[2] += w * (M[2] * x + M[6] * y + M[10] * z + M[14]);
    }
    for (let k = 0; k < 3; k++) { if (o[k] < min[k]) min[k] = o[k]; if (o[k] > max[k]) max[k] = o[k]; }
  }
  return { min, max };
}
