const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aBone; layout(location=4) in vec4 aWeight;
uniform mat4 uProj, uMV; uniform sampler2D uBones; uniform bool uSkinned;
out vec3 vN; out vec2 vUV;
mat4 bm(float f){ int i=int(f+0.5); return mat4(texelFetch(uBones,ivec2(0,i),0),texelFetch(uBones,ivec2(1,i),0),texelFetch(uBones,ivec2(2,i),0),texelFetch(uBones,ivec2(3,i),0)); }
void main(){
  vec4 p=vec4(aPos,1.0); vec3 n=aNor;
  if(uSkinned){ mat4 m=bm(aBone.x)*aWeight.x; if(aWeight.y!=0.0)m+=bm(aBone.y)*aWeight.y; if(aWeight.z!=0.0)m+=bm(aBone.z)*aWeight.z; if(aWeight.w!=0.0)m+=bm(aBone.w)*aWeight.w; p=m*p; n=mat3(m)*n; }
  vN=mat3(uMV)*n; vUV=aUV; gl_Position=uProj*uMV*p;
}`;
const FS = `#version 300 es
precision highp float;
in vec3 vN; in vec2 vUV; out vec4 o;
uniform sampler2D uTex; uniform bool uHasTex, uAlphaTest, uFlat; uniform vec3 uFlatColor, uBase;
void main(){
  if(uFlat){ o=vec4(uFlatColor,1.0); return; }
  vec4 c=uHasTex?texture(uTex,vUV):vec4(uBase,1.0);
  if(uAlphaTest&&c.a<0.5) discard;
  float d=abs(dot(normalize(vN),normalize(vec3(0.4,0.6,1.0))));
  o=vec4(c.rgb*(0.4+0.7*d),1.0);
}`;
const LVS = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uProj, uMV; void main(){ gl_Position=uProj*uMV*vec4(aPos,1.0); }`;
const LFS = `#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 o; void main(){ o=uColor; }`;

function prog(gl, vs, fs) {
  const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
  const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function mulCol(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
function perspective(fovy, asp, n, f) { const t = 1 / Math.tan(fovy / 2), nf = 1 / (n - f); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0]); }
function lookAt(e, c, u) {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2], l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx; l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
}
const FLIPZ = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]); // X-Ray левосторонний -> GL

const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const ZUP = new Float32Array([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]); // Z-вверх -> Y-вверх

export class OrbitCamera {
  constructor() { this.reset(); }
  reset() { this.yaw = Math.PI; this.pitch = 0.15; this.dist = 3; this.target = [0, 1, 0]; }
  eye() { const cp = Math.cos(this.pitch); return [this.target[0] + this.dist * cp * Math.sin(this.yaw), this.target[1] + this.dist * Math.sin(this.pitch), this.target[2] + this.dist * cp * Math.cos(this.yaw)]; }
  view() { return lookAt(this.eye(), this.target, [0, 1, 0]); }
  rotate(dx, dy) { this.yaw -= dx * 0.01; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.01)); }
  zoom(f) { this.dist = Math.max(0.01, this.dist * f); }
  pan(dx, dy) {
    const e = this.eye(), f = [this.target[0] - e[0], this.target[1] - e[1], this.target[2] - e[2]], l = Math.hypot(...f); f.forEach((_, i) => f[i] /= l);
    let r = [f[1] * 0 - f[2] * 1, f[2] * 0 - f[0] * 0, f[0] * 1 - f[1] * 0]; const rl = Math.hypot(...r) || 1; r = r.map((v) => v / rl);
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]], k = this.dist * 0.0015;
    for (let i = 0; i < 3; i++) this.target[i] += (-r[i] * dx + u[i] * dy) * k;
  }
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = this.gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL2 недоступен');
    this.p = prog(gl, VS, FS); this.lp = prog(gl, LVS, LFS);
    const u = (p, n) => gl.getUniformLocation(p, n);
    this.U = { proj: u(this.p, 'uProj'), mv: u(this.p, 'uMV'), bones: u(this.p, 'uBones'), skinned: u(this.p, 'uSkinned'), tex: u(this.p, 'uTex'),
      hasTex: u(this.p, 'uHasTex'), alpha: u(this.p, 'uAlphaTest'), flat: u(this.p, 'uFlat'), flatColor: u(this.p, 'uFlatColor'), base: u(this.p, 'uBase') };
    this.LU = { proj: u(this.lp, 'uProj'), mv: u(this.lp, 'uMV'), color: u(this.lp, 'uColor') };
    this.meshes = []; this.boneCount = 0;
    this.boneTex = gl.createTexture();
    this.gridVao = this.mkLineVao(); this.skelVao = this.mkLineVao(); this.gridN = 0; this.skelN = 0;
    this.bounds = { center: [0, 0, 0], radius: 1 };
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.flip = FLIPZ; this.flipOn = true; this.zUp = false; this.rawBounds = { min: [0, 0, 0], max: [1, 1, 1] };
  }
  mkLineVao() { const gl = this.gl, vao = gl.createVertexArray(), buf = gl.createBuffer(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); return { vao, buf }; }
  buf(target, data) { const gl = this.gl, b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, gl.STATIC_DRAW); return b; }
  attribs(m) { const gl = this.gl, sets = [[m.bPos, 3], [m.bNor, 3], [m.bUV, 2], [m.bBone, 4], [m.bWt, 4]];
    sets.forEach(([b, n], i) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, 0, 0); }); }

  clear() {
    const gl = this.gl;
    for (const m of this.meshes) { gl.deleteVertexArray(m.vao); if (m.vaoW) gl.deleteVertexArray(m.vaoW); if (m.tex) gl.deleteTexture(m.tex);
      [m.bPos, m.bNor, m.bUV, m.bBone, m.bWt, m.bIdx, m.bLine].forEach((b) => b && gl.deleteBuffer(b)); }
    this.meshes = [];
  }

  setModel(model) {
    const gl = this.gl; this.clear();
    for (const d of model.meshes) {
      const m = { count: d.indices.length, data: d, visible: true, tex: null, itype: d.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
      m.bPos = this.buf(gl.ARRAY_BUFFER, d.pos); m.bNor = this.buf(gl.ARRAY_BUFFER, d.nor); m.bUV = this.buf(gl.ARRAY_BUFFER, d.uv);
      m.bBone = this.buf(gl.ARRAY_BUFFER, d.bone); m.bWt = this.buf(gl.ARRAY_BUFFER, d.weight);
      m.vao = gl.createVertexArray(); gl.bindVertexArray(m.vao); this.attribs(m);
      m.bIdx = this.buf(gl.ELEMENT_ARRAY_BUFFER, d.indices);
      this.meshes.push(m);
    }
    this.boneCount = model.skeleton ? model.skeleton.n : 0; this.skelN = 0;
    this.flipOn = !!model.flipZ; this.flip = this.flipOn ? FLIPZ : IDENT; this.yaw0 = model.cameraYaw ?? (this.flipOn ? Math.PI : 0); this.zUp = false; this.rawBounds = model.bounds;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, Math.max(1, this.boneCount), 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.buildGrid(); this.computeBounds();
  }
  updateGeometry() {   // покадровая вершинная анимация (MD2/MD3/MDL)
    const gl = this.gl; gl.bindVertexArray(null);
    for (const m of this.meshes) {
      if (!m.data.dynamic) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, m.bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, m.data.pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.bNor); gl.bufferSubData(gl.ARRAY_BUFFER, 0, m.data.nor);
    }
  }
  setZUp(v) { this.zUp = v; this.buildGrid(); }
  computeBounds() {
    const { min, max } = this.rawBounds; let c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    if (this.zUp) c = [c[0], c[2], -c[1]];
    if (this.flipOn) c[2] = -c[2];
    this.bounds = { center: c, radius: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1 };
  }
  buildGrid() {
    const gl = this.gl, { min, max } = this.rawBounds;
    const lo = this.zUp ? [min[0], min[2], -max[1]] : min, hi = this.zUp ? [max[0], max[2], -min[1]] : max;
    const half = Math.max(hi[0] - lo[0], hi[2] - lo[2], (hi[1] - lo[1]) * 0.6) || 1, g = [];
    for (let i = -10; i <= 10; i++) { const v = i * half / 10; g.push(-half, lo[1], v, half, lo[1], v, v, lo[1], -half, v, lo[1], half); }
    gl.bindVertexArray(this.gridVao.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.gridVao.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g), gl.STATIC_DRAW); this.gridN = g.length / 3;
  }
  fit(camera) { this.computeBounds(); const b = this.bounds; camera.reset(); camera.yaw = this.yaw0; camera.target = [...b.center]; camera.dist = b.radius * 2.6; }

  setTexture(i, img) {
    const gl = this.gl, m = this.meshes[i]; if (!m) return;
    if (m.tex) gl.deleteTexture(m.tex);
    const t = m.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (img.rgba) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.rgba);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img.bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  }

  updatePose(skel) {
    const gl = this.gl, n = skel ? skel.n : 0; if (!n) return;
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, n, gl.RGBA, gl.FLOAT, skel.skin);
    const l = [];
    for (let i = 0; i < n; i++) { const p = skel.parent[i]; if (p < 0) continue; const a = skel.worldV[p], b = skel.worldV[i]; l.push(a[12], a[13], a[14], b[12], b[13], b[14]); }
    gl.bindVertexArray(this.skelVao.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.skelVao.buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(l), gl.DYNAMIC_DRAW); this.skelN = l.length / 3;
  }

  draw(cam, o) {
    const gl = this.gl, c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(c.clientWidth * dpr)), h = Math.max(1, Math.floor(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h); gl.clearColor(0.12, 0.14, 0.17, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const r = this.bounds.radius, proj = perspective(0.8, w / h, Math.max(r * 0.01, cam.dist * 0.01), r * 100 + cam.dist * 2), mvG = mulCol(cam.view(), this.flip), mv = this.zUp ? mulCol(mvG, ZUP) : mvG;
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.p);
    gl.uniformMatrix4fv(this.U.proj, false, proj); gl.uniformMatrix4fv(this.U.mv, false, mv);
    gl.uniform1i(this.U.bones, 1); gl.uniform1i(this.U.tex, 0); gl.uniform1i(this.U.skinned, this.boneCount > 0 ? 1 : 0); gl.uniform1i(this.U.alpha, o.alpha ? 1 : 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
    gl.uniform1i(this.U.flat, 0);
    for (const m of this.meshes) {
      if (!m.visible) continue;
      gl.activeTexture(gl.TEXTURE0); const has = o.tex && m.tex; gl.bindTexture(gl.TEXTURE_2D, has ? m.tex : null); gl.uniform1i(this.U.hasTex, has ? 1 : 0); gl.uniform3fv(this.U.base, m.data.color || [0.7, 0.72, 0.76]);
      gl.bindVertexArray(m.vao); gl.drawElements(gl.TRIANGLES, m.count, m.itype, 0);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if (o.wire) {
      gl.uniform1i(this.U.flat, 1); gl.uniform3f(this.U.flatColor, 0.9, 0.95, 1);
      for (const m of this.meshes) {
        if (!m.visible) continue;
        if (!m.vaoW) {
          const d = m.data.indices, e = new d.constructor(d.length * 2);
          for (let t = 0; t < d.length; t += 3) { const k = t * 2; e.set([d[t], d[t + 1], d[t + 1], d[t + 2], d[t + 2], d[t]], k); }
          m.vaoW = gl.createVertexArray(); gl.bindVertexArray(m.vaoW); this.attribs(m); m.bLine = this.buf(gl.ELEMENT_ARRAY_BUFFER, e); m.lineCount = e.length;
        }
        gl.bindVertexArray(m.vaoW); gl.drawElements(gl.LINES, m.lineCount, m.itype, 0);
      }
    }
    gl.useProgram(this.lp); gl.uniformMatrix4fv(this.LU.proj, false, proj); gl.uniformMatrix4fv(this.LU.mv, false, mvG);
    if (o.grid && this.gridN) { gl.uniform4f(this.LU.color, 0.35, 0.4, 0.45, 1); gl.bindVertexArray(this.gridVao.vao); gl.drawArrays(gl.LINES, 0, this.gridN); }
    if (o.skeleton && this.skelN) { gl.uniformMatrix4fv(this.LU.mv, false, mv); gl.disable(gl.DEPTH_TEST); gl.uniform4f(this.LU.color, 1, 0.85, 0.2, 1); gl.bindVertexArray(this.skelVao.vao); gl.drawArrays(gl.LINES, 0, this.skelN); }
  }
}
