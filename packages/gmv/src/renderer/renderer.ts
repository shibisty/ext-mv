// WebGL2-рендерер модели gmv: скининг в вершинном шейдере (матрицы костей в float-текстуре), сетка, каркас, скелет.
import { computeTangents, type NormalPacking } from '../core/normals';
import type { Bounds, DecodedImage, Lightmap, Mesh, Model, ScreenFx, SkeletonRuntime } from '../core/types';
import type { OrbitCamera } from './camera';
import { FLIPZ, IDENT, invert, mulCol, perspective, ZUP } from './mat4';
import { boxVisible, buildCells, growCells, meshBox, visibleRanges, type CellLayout } from './cull';

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aBone; layout(location=4) in vec4 aWeight; layout(location=5) in vec4 aTan; layout(location=6) in vec2 aUV2; layout(location=7) in float aAlpha; layout(location=8) in vec4 aShade;
uniform mat4 uProj, uMV, uModel; uniform sampler2D uBones; uniform bool uSkinned;
out vec3 vN, vP, vO, vS; out vec4 vT; out vec2 vUV, vUV2; out float vY, vA;
mat4 bm(float f){ int i=int(f+0.5); return mat4(texelFetch(uBones,ivec2(0,i),0),texelFetch(uBones,ivec2(1,i),0),texelFetch(uBones,ivec2(2,i),0),texelFetch(uBones,ivec2(3,i),0)); }
void main(){
  vec4 p=vec4(aPos,1.0); vec3 n=aNor, t=aTan.xyz;
  if(uSkinned){ mat4 m=bm(aBone.x)*aWeight.x; if(aWeight.y!=0.0)m+=bm(aBone.y)*aWeight.y; if(aWeight.z!=0.0)m+=bm(aBone.z)*aWeight.z; if(aWeight.w!=0.0)m+=bm(aBone.w)*aWeight.w; p=m*p; n=mat3(m)*n; t=mat3(m)*t; }
  vO=aPos; vec4 q=uMV*p; vP=q.xyz; vN=mat3(uMV)*n; vT=vec4(mat3(uMV)*t,aTan.w); vUV=aUV; vUV2=aUV2; vA=aAlpha; vS=aShade.rgb*2.0; vY=(uModel*p).y; gl_Position=uProj*q;
}`;
const FS = `#version 300 es
precision highp float;
in vec3 vN, vP, vO, vS; in vec4 vT; in vec2 vUV, vUV2; in float vY, vA; out vec4 o;
// слои ландшафта: номер слоя на тексель (uTIdx, R8), текстуры слоёв (массив), период повтора, подкраска, средний цвет
uniform bool uTerr, uTHasN, uTHasM; uniform highp sampler2D uTIdx; uniform highp sampler2DArray uTLay, uTNrm, uTMid; uniform vec2 uTPar[32], uTMPar[32]; uniform vec3 uTMean[32], uTMMean[32]; uniform float uTFade;
uniform mat4 uMV;
// нормаль слоёв ландшафта (касательное пространство: X, Z модели) и AO — из terrainColor
vec3 gTerrN=vec3(0.0,0.0,1.0); float gTerrAO=1.0;
vec3 terrainColor(vec3 sat){
  vec2 sz=vec2(textureSize(uTIdx,0)), f=vUV*sz-0.5, w=fract(f); ivec2 i0=ivec2(floor(f)), mx=ivec2(sz)-1;
  vec3 acc=vec3(0.0); vec2 nxy=vec2(0.0); float ao=0.0;
  for(int k=0;k<4;k++){
    ivec2 d=ivec2(k&1,k>>1);
    int L=int(texelFetch(uTIdx,clamp(i0+d,ivec2(0),mx),0).r*255.0+0.5);
    float wk=(d.x==1?w.x:1.0-w.x)*(d.y==1?w.y:1.0-w.y);
    if(wk<=0.0) continue;
    vec2 pr=uTPar[L], tuv=vO.xz/pr.x;
    vec3 c=texture(uTLay,vec3(tuv,float(L))).rgb;
    // средний масштаб: изменчивость (MiddleScaleUV) — отношение к среднему цвету, сила MiddleBCRBlend
    if(uTHasM){ vec2 mp=uTMPar[L]; if(mp.y>0.0){ vec3 mc=texture(uTMid,vec3(vO.xz/mp.x,float(L))).rgb; c*=mix(vec3(1.0),mc/max(uTMMean[L],vec3(0.03)),mp.y); } }
    if(uTHasN){ vec4 nh=texture(uTNrm,vec3(tuv,float(L))); nxy+=wk*(nh.rg*2.0-1.0); ao+=wk*nh.a; } else ao+=wk;
    // подкраска цветовой картой: узор слоя, тон и яркость — от карты (SatMapBlend)
    acc+=wk*mix(c,c*sat/max(uTMean[L],vec3(0.03)),pr.y);
  }
  // вдали — только цветовая карта (как у игры: детали до DetailMaxDistance)
  float fd=clamp((length(vP)-uTFade*0.5)/(uTFade*0.5),0.0,1.0);
  // DirectX: зелёный — к −V; V по +Z модели
  nxy=vec2(nxy.x,-nxy.y)*(1.0-fd);
  gTerrN=vec3(nxy,sqrt(max(0.0,1.0-dot(nxy,nxy)))); gTerrAO=mix(ao,1.0,fd);
  return mix(clamp(acc*mix(1.0,ao,0.5),0.0,1.0),sat,fd);
}
// карта освещения уровня (яркость в R) по второму набору UV
uniform sampler2D uLm; uniform bool uHasLm; uniform bool uLmRgb; uniform float uLmK;
// рельеф (Source bump lightmaps): три карты по направлениям базиса, смешиваются по нормали из карты нормалей (касательное пространство)
uniform highp sampler2DArray uLmB; uniform bool uHasLmB;
bool gBump=false; vec3 gBumpN=vec3(0.0,0.0,1.0);
vec3 lmap(){
  vec3 l;
  if(gBump){
    vec3 w=max(vec3(dot(gBumpN,vec3(0.81649658,0.0,0.57735027)),dot(gBumpN,vec3(-0.40824829,0.70710678,0.57735027)),dot(gBumpN,vec3(-0.40824829,-0.70710678,0.57735027))),0.0);
    w*=w;
    l=(w.x*texture(uLmB,vec3(vUV2,0.0)).rgb+w.y*texture(uLmB,vec3(vUV2,1.0)).rgb+w.z*texture(uLmB,vec3(vUV2,2.0)).rgb)/max(w.x+w.y+w.z,1e-4);
  } else l=texture(uLm,vUV2).rgb;
  return (uLmRgb ? l : vec3(l.r))*uLmK;
}
// плоскость отсечения (отражение воды): в координатах модели, рисуется то, что с её положительной стороны
uniform bool uClipOn; uniform vec4 uClipPl;
// вода и стекло: отражение (uRefl), снимок сцены и его глубина (uRefr, uDepth); uFxK — искажение преломления/отражения, туман: начало/конец
uniform int uFx; uniform sampler2D uRefl, uRefr, uDepth; uniform vec2 uScreen, uNF, uFxScroll; uniform vec3 uFxRT, uFxLT, uFogC; uniform vec4 uFxK; uniform bool uFxRefl, uFxFog; uniform float uTime;
float linDepth(float z){ float n=uNF.x, f=uNF.y; return 2.0*n*f/(f+n-(z*2.0-1.0)*(f-n)); }
// срез сверху: всё выше uClipY (мировая высота показа) не рисуется — чтобы заглянуть внутрь уровня
uniform float uClipY;
uniform sampler2D uTex, uNorm, uSurf; uniform bool uHasTex, uAlphaTest, uFlat, uHasNorm, uHasSurf; uniform vec3 uFlatColor, uBase; uniform float uFlatAlpha;
// uNormPack: 0 — xyz в RGB, 1 — XY в RG (BC5), 2 — X в альфе, Y в зелёном (DXT5nm); uNormY: +1 OpenGL (Y вверх), -1 Direct3D; uMirror: -1 при отражённой сцене
uniform int uNormPack, uView; uniform float uNormY, uMirror, uNI;
vec3 tangentNormal(vec4 t){
  vec3 n;
  if(uNormPack==0) n=t.rgb*2.0-1.0;
  else { vec2 xy=(uNormPack==1?t.rg:t.ag)*2.0-1.0; n=vec3(xy,sqrt(max(0.0,1.0-dot(xy,xy)))); }
  n.y*=uNormY;
  return normalize(n);
}
const float PI=3.14159265;
// процедурное окружение для отражений (небо сверху, земля снизу), размывается по шероховатости
vec3 envColor(vec3 R, float rough){
  vec3 sky=mix(vec3(0.55,0.60,0.68),vec3(0.28,0.38,0.58),clamp(R.y,0.0,1.0));
  vec3 gnd=mix(vec3(0.30,0.30,0.31),vec3(0.14,0.12,0.11),clamp(-R.y*3.0,0.0,1.0));
  vec3 e=R.y>0.0?sky:gnd;
  return mix(e,vec3(0.30,0.32,0.36),rough*rough);
}
// аппроксимация интеграла BRDF для окружения (Karis, UE4 mobile)
vec3 envBRDF(vec3 F0, float rough, float NdV){
  vec4 r=rough*vec4(-1.0,-0.0275,-0.572,0.022)+vec4(1.0,0.0425,1.04,-0.04);
  float a004=min(r.x*r.x,exp2(-9.28*NdV))*r.x+r.y;
  vec2 AB=vec2(-1.04,1.04)*a004+r.zw;
  return F0*AB.x+AB.y;
}
vec4 screenFx(){
  vec2 suv=gl_FragCoord.xy/uScreen, d=vec2(0.0);
  vec3 N=normalize(vN), V=normalize(-vP);
  if(dot(N,V)<0.0) N=-N;
  if(uHasNorm){
    // две копии карты нормалей с разной прокруткой — рябь не повторяется явно
    vec2 sc=uFxScroll*uTime;
    vec3 a=tangentNormal(texture(uNorm,vUV+sc)), b=tangentNormal(texture(uNorm,vUV*0.73+vec2(0.31,0.17)-sc*0.6));
    d=(a.xy+b.xy)*0.5;
  } else d=vec2(sin(vO.x*0.05+uTime*1.3)+sin(vO.y*0.07-uTime),cos(vO.y*0.05+uTime)+cos(vO.x*0.06-uTime*0.8))*0.12;
  float wz=-vP.z;
  vec2 ru=clamp(suv+d*uFxK.x,vec2(0.001),vec2(0.999));
  float sz=linDepth(texture(uDepth,ru).r);
  if(sz<wz){ ru=suv; sz=linDepth(texture(uDepth,ru).r); } // искажение захватило то, что перед поверхностью
  vec3 refr=texture(uRefr,ru).rgb*uFxRT;
  // стекло: преломление и блик окружения ($envmap × $envmaptint) по Френелю
  if(uFx==2) return vec4(refr+envColor(reflect(-V,normalize(N+vec3(d*0.5,0.0))),0.2)*uFxLT*mix(0.15,1.0,pow(1.0-max(dot(N,V),0.0),3.0)),1.0);
  if(uFxFog){ float th=max(0.0,sz-wz)*length(vP)/max(wz,1e-3); refr=mix(refr,uFogC,clamp((th-uFxK.z)/max(uFxK.w-uFxK.z,1.0),0.0,1.0)); }
  vec3 refl=uFxRefl ? texture(uRefl,clamp(suv+d*uFxK.y,vec2(0.001),vec2(0.999))).rgb : envColor(reflect(-V,N),0.3);
  float fr=mix(0.25,1.0,pow(1.0-max(dot(N,V),0.0),3.0));
  return vec4(mix(refr,refl*uFxLT,fr),1.0);
}
void main(){
  if(vY>uClipY) discard;
  if(uClipOn&&dot(vec4(vO,1.0),uClipPl)<-0.25) discard;
  if(uFlat){ o=vec4(uFlatColor,uFlatAlpha); return; }
  if(uFx>0){ o=screenFx(); return; }
  vec4 c=uHasTex?texture(uTex,vUV):vec4(uBase,1.0);
  if(uAlphaTest&&c.a<0.5) discard;
  if(uTerr) c.rgb=terrainColor(c.rgb);
  c.rgb*=vS; // запечённый свет по вершинам (без него — 1)
  // нормали моделей бывают развёрнуты как угодно (обход граней у игр разный, сцена может быть отражена):
  // освещаем сторону, обращённую к камере
  vec3 V=normalize(-vP), N=normalize(vN);
  float side=dot(N,V)<0.0?-1.0:1.0;
  vec3 Ng=N*side, Nw=Ng, nt=vec3(0.0,0.0,1.0);
  if(uTerr&&uTHasN){
    vec3 T=mat3(uMV)*vec3(1.0,0.0,0.0), B=mat3(uMV)*vec3(0.0,0.0,1.0);
    T=normalize(T-Ng*dot(Ng,T)); B=normalize(B-Ng*dot(Ng,B)-T*dot(T,B));
    vec3 tn=normalize(vec3(gTerrN.xy*uNI,max(gTerrN.z,0.001)));
    Nw=normalize(T*tn.x+B*tn.y+Ng*tn.z);
  }
  if(uHasNorm){
    vec3 T=vT.xyz-N*dot(N,vT.xyz);
    if(dot(T,T)>1e-10){
      T=normalize(T);
      vec3 B=cross(N,T)*vT.w*uMirror;
      // как в Normal Map Studio: сила рельефа масштабирует XY касательной нормали
      nt=tangentNormal(texture(uNorm,vUV));
      nt=normalize(vec3(nt.xy*uNI,max(nt.z,0.001)));
      Nw=normalize(mat3(T,B,N)*nt)*side;
      // базис рельефа Source — в осях текстуры как они записаны в карте (без пересчёта Y под соглашение показа)
      gBump=uHasLmB; gBumpN=vec3(nt.x,nt.y*uNormY,nt.z);
    }
  }
  if(uView==1){ o=vec4(Nw*0.5+0.5,1.0); return; } // нормали (пространство камеры)
  if(uView==2){ o=vec4(nt*0.5+0.5,1.0); return; } // карта нормалей (касательное пространство)
  if(uView==3&&!uHasSurf){ o=vec4(0.0,0.6,0.0,1.0); return; } // поверхность: нет карты — AO 0, шероховатость 0.6, металл 0
  vec3 L=normalize(vec3(0.4,0.6,1.0)), H=normalize(L+V);
  vec3 alb=pow(c.rgb,vec3(2.2));
  if(uHasSurf){
    // PBR (metal/rough, GGX): R — AO, G — шероховатость, B — металличность, A — блик неметалла (0.5 = F0 0.04)
    vec4 sf=texture(uSurf,vUV);
    float ao=sf.r, rough=clamp(sf.g,0.045,1.0), metal=sf.b, a=rough*rough, a2=a*a;
    if(uView==3){ o=vec4(sf.rgb,1.0); return; }
    vec3 F0=mix(vec3(0.08*sf.a),alb,metal);
    float NdL=max(dot(Nw,L),0.0), NdV=max(dot(Nw,V),1e-3), NdH=max(dot(Nw,H),0.0), VdH=max(dot(V,H),0.0);
    float geo=smoothstep(0.0,0.15,dot(Ng,L));
    float dd=NdH*NdH*(a2-1.0)+1.0, D=a2/(PI*dd*dd);
    float k=(rough+1.0)*(rough+1.0)/8.0, G=(NdL/(NdL*(1.0-k)+k))*(NdV/(NdV*(1.0-k)+k));
    vec3 F=F0+(1.0-F0)*pow(1.0-VdH,5.0);
    vec3 spec=D*G*F/max(4.0*NdL*NdV,1e-4);
    vec3 kd=(1.0-F)*(1.0-metal);
    vec3 direct=(kd*alb/PI+spec)*vec3(1.0,0.97,0.92)*NdL*geo*PI*1.2;
    vec3 amb=mix(vec3(0.05,0.05,0.06),vec3(0.20,0.22,0.26),Nw.y*0.5+0.5);
    vec3 R=reflect(-V,Nw);
    vec3 ambient=(alb*(1.0-metal)*amb+envColor(R,rough)*envBRDF(F0,rough,NdV))*ao;
    if(uHasLm){ vec3 lm=lmap(); direct*=lm*0.5; ambient=ambient*0.25+alb*(1.0-metal)*lm*ao; }
    o=vec4(pow(direct+ambient,vec3(1.0/2.2)),vA);
    return;
  }
  // освещение из Normal Map Studio: линейный цвет, полусферический фон, «геометрическая» тень, блик Блинна
  float ndl=max(dot(Nw,L),0.0), geo=smoothstep(0.0,0.15,dot(Ng,L));
  float sp=uHasNorm?pow(max(dot(Nw,H),0.0),32.0)*0.25*geo*step(0.0,ndl):0.0;
  vec3 amb=mix(vec3(0.05,0.05,0.06),vec3(0.20,0.22,0.26),Nw.y*0.5+0.5);
  vec3 col=alb*(amb+vec3(1.0,0.97,0.92)*ndl*geo*1.2)+vec3(sp);
  if(uHasLm){ vec3 lm=lmap(); col=alb*(lm*(0.75+0.25*ndl*geo)+amb*0.15)+vec3(sp)*lm; }
  o=vec4(pow(col,vec3(1.0/2.2)),vA);
}`;
// вывод готового кадра (из промежуточного буфера) на холст
const QVS = `#version 300 es
void main(){ vec2 p=vec2(gl_VertexID==1?3.0:-1.0, gl_VertexID==2?3.0:-1.0); gl_Position=vec4(p,0.0,1.0); }`;
const QFS = `#version 300 es
precision mediump float; uniform sampler2D uT; out vec4 o; void main(){ o=texelFetch(uT,ivec2(gl_FragCoord.xy),0); }`;
const LVS = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uProj, uMV; void main(){ gl_Position=uProj*uMV*vec4(aPos,1.0); }`;
const LFS = `#version 300 es
precision mediump float; uniform vec4 uColor; out vec4 o; void main(){ o=uColor; }`;

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (t: number, s: string) => {
    const sh = gl.createShader(t)!;
    gl.shaderSource(sh, s);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
    return sh;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program');
  return p;
}

export interface DrawOptions {
  tex: boolean; wire: boolean; skeleton: boolean; grid: boolean; alpha: boolean;
  /** Карты нормалей (если найдены). */
  normals?: boolean;
  /** Инвертировать зелёный канал относительно соглашения игры (GL ↔ DX). */
  normalFlipY?: boolean;
  /** Отладка: 0/false — освещение, 1/true — нормали цветом, 2 — карта нормалей (касательное пространство), 3 — поверхность PBR (R AO, G шероховатость, B металл). */
  normalView?: boolean | 0 | 1 | 2 | 3;
  /** Запечённое освещение уровня (если есть карта). По умолчанию включено. */
  lightmap?: boolean;
  /** Яркость карты освещения (множитель к масштабу модели). */
  lightmapScale?: number;
  /** PBR (шероховатость, металличность, AO), если у меша есть поверхность. */
  pbr?: boolean;
  /** Сила рельефа карт нормалей (1 — как есть). */
  normalStrength?: number;
  /** Срез сверху: не рисовать выше этой высоты (координаты показа, Y вверх). */
  clipY?: number;
  /** Слои поверхности ландшафта вблизи (если есть). По умолчанию включено. */
  terrainLayers?: boolean;
  /** Дальность прорисовки в единицах модели (части уровня дальше не рисуются); по умолчанию — без ограничения. */
  drawDistance?: number;
  /** Отражение и преломление на воде и стекле (Mesh.screenFx). По умолчанию включено; выкл. — полупрозрачный цвет. */
  screenFx?: boolean;
  /** Освещение рельефа по картам базиса (Source bump lightmaps), если они есть. По умолчанию включено. */
  bumpLightmap?: boolean;
}

/** Промежуточные буферы кадра для воды и стекла: сцена (MSAA), её снимок с глубиной, отражение. */
interface FxTargets {
  w: number; h: number;
  fbA: WebGLFramebuffer; rbColor: WebGLRenderbuffer; rbDepth: WebGLRenderbuffer;
  fbB: WebGLFramebuffer; texColor: WebGLTexture; texDepth: WebGLTexture;
  fbR: WebGLFramebuffer; texRefl: WebGLTexture; rbReflDepth: WebGLRenderbuffer; rw: number; rh: number;
}

/** Цвета сцены (для тем оформления). */
export interface RendererTheme {
  background: [number, number, number];
  grid: [number, number, number, number];
  skeleton: [number, number, number, number];
  wire: [number, number, number];
  base: [number, number, number];
}
export const DARK_THEME: RendererTheme = {
  background: [0.12, 0.14, 0.17], grid: [0.35, 0.4, 0.45, 1], skeleton: [1, 0.85, 0.2, 1], wire: [0.9, 0.95, 1], base: [0.7, 0.72, 0.76],
};
export const LIGHT_THEME: RendererTheme = {
  background: [0.93, 0.94, 0.96], grid: [0.7, 0.73, 0.78, 1], skeleton: [0.85, 0.45, 0.05, 1], wire: [0.15, 0.2, 0.3], base: [0.62, 0.64, 0.68],
};

interface GpuMesh {
  count: number; data: Mesh; visible: boolean; tex: WebGLTexture | null; itype: number;
  /** Индексы на GPU (скрытые экземпляры — вырожденные треугольники). */
  idx: Uint16Array | Uint32Array;
  norm: WebGLTexture | null; normPack: NormalPacking; surf: WebGLTexture | null;
  /** Карта слоёв ландшафта (R8, ближайший). */
  tIdx: WebGLTexture | null;
  bPos: WebGLBuffer; bNor: WebGLBuffer; bUV: WebGLBuffer; bBone: WebGLBuffer | null; bWt: WebGLBuffer | null; bTan: WebGLBuffer; bIdx: WebGLBuffer; bUV2: WebGLBuffer | null;
  /** Прозрачность по вершинам (слои ландшафта), null — 1. */
  bA: WebGLBuffer | null;
  bS: WebGLBuffer | null;
  vao: WebGLVertexArrayObject; vaoW?: WebGLVertexArrayObject; bLine?: WebGLBuffer; lineCount?: number;
  /** Рамка меша для отсечения (null — меш двигается: скелет, вершинная анимация — рисуется всегда). */
  box: Float32Array | null;
  /** Большой меш: треугольники по клеткам, свой буфер индексов в порядке клеток. */
  cells?: CellLayout; vaoS?: WebGLVertexArrayObject; bIdxS?: WebGLBuffer; sortDirty?: boolean;
  /** Вода/стекло: рисуется после сцены по её снимку. */
  fx: ScreenFx | null;
}
interface LineVao { vao: WebGLVertexArrayObject; buf: WebGLBuffer }

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  meshes: GpuMesh[] = [];
  theme: RendererTheme = DARK_THEME;
  bounds = { center: [0, 0, 0], radius: 1 };
  private readonly p: WebGLProgram;
  private readonly lp: WebGLProgram;
  private readonly qp: WebGLProgram;
  private readonly qVao: WebGLVertexArrayObject;
  private fxT: FxTargets | null = null;
  private fxFailed = false;
  private lmBTex: WebGLTexture | null = null;
  /** Что нарисовано водой и стеклом в последнем кадре: мешей, было ли плоское отражение. */
  fxStats = { meshes: 0, reflection: false };
  private readonly U: Record<string, WebGLUniformLocation | null>;
  private readonly LU: Record<string, WebGLUniformLocation | null>;
  private readonly boneTex: WebGLTexture;
  private readonly gridVao: LineVao;
  private readonly skelVao: LineVao;
  private readonly aniso: EXT_texture_filter_anisotropic | null;
  private boneCount = 0;
  private gridN = 0;
  private skelN = 0;
  private flip: Float32Array = FLIPZ;
  private flipOn = true;
  private zUp = false;
  private normalY = -1;
  private yaw0 = Math.PI;
  private rawBounds: Bounds = { min: [0, 0, 0], max: [1, 1, 1] };
  private highlight: Array<{ mesh: number; iStart: number; iCount: number }> = [];
  private lmTex: WebGLTexture | null = null;
  private layTex: WebGLTexture | null = null;
  private layNrm: WebGLTexture | null = null;
  private layMid: WebGLTexture | null = null;
  private layMPar = new Float32Array(64);
  private layMMean = new Float32Array(96);
  private layPar = new Float32Array(64);
  private layMean = new Float32Array(96);
  private layFade = 150;
  private lmScale = 1;
  private lmRgb = false;
  /** Что нарисовано в последнем кадре (после отсечения): треугольники, вызовы, клеток всего. */
  drawStats = { tris: 0, calls: 0, cells: 0 };
  /** Матрицы последнего кадра: проекция × вид × модель (для выбора лучом). */
  lastPVM: Float32Array | null = null;
  get zUpOn(): boolean { return this.zUp; }
  /** Точка модели в координатах показа (с учётом отражения Z и «Z вверх»). */
  toView(x: number, y: number, z: number): number[] {
    let p = this.zUp ? [x, z, -y] : [x, y, z];
    if (this.flipOn) p = [p[0]!, p[1]!, -p[2]!];
    return p;
  }

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) throw new Error('WebGL2 недоступен');
    this.gl = gl;
    this.p = program(gl, VS, FS);
    this.lp = program(gl, LVS, LFS);
    this.qp = program(gl, QVS, QFS);
    this.qVao = gl.createVertexArray()!;
    const u = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
    this.U = { proj: u(this.p, 'uProj'), mv: u(this.p, 'uMV'), model: u(this.p, 'uModel'), clipY: u(this.p, 'uClipY'), bones: u(this.p, 'uBones'), skinned: u(this.p, 'uSkinned'), tex: u(this.p, 'uTex'),
      hasTex: u(this.p, 'uHasTex'), alpha: u(this.p, 'uAlphaTest'), flat: u(this.p, 'uFlat'), flatColor: u(this.p, 'uFlatColor'), flatAlpha: u(this.p, 'uFlatAlpha'), lm: u(this.p, 'uLm'), hasLm: u(this.p, 'uHasLm'), lmRgb: u(this.p, 'uLmRgb'), lmK: u(this.p, 'uLmK'), base: u(this.p, 'uBase'),
      terr: u(this.p, 'uTerr'), tIdx: u(this.p, 'uTIdx'), tLay: u(this.p, 'uTLay'), tNrm: u(this.p, 'uTNrm'), tMid: u(this.p, 'uTMid'), tHasN: u(this.p, 'uTHasN'), tHasM: u(this.p, 'uTHasM'), tMPar: u(this.p, 'uTMPar'), tMMean: u(this.p, 'uTMMean'), tPar: u(this.p, 'uTPar'), tMean: u(this.p, 'uTMean'), tFade: u(this.p, 'uTFade'),
      lmB: u(this.p, 'uLmB'), hasLmB: u(this.p, 'uHasLmB'), clipOn: u(this.p, 'uClipOn'), clipPl: u(this.p, 'uClipPl'),
      fx: u(this.p, 'uFx'), refl: u(this.p, 'uRefl'), refr: u(this.p, 'uRefr'), depth: u(this.p, 'uDepth'), screen: u(this.p, 'uScreen'), nf: u(this.p, 'uNF'), fxScroll: u(this.p, 'uFxScroll'),
      fxRT: u(this.p, 'uFxRT'), fxLT: u(this.p, 'uFxLT'), fogC: u(this.p, 'uFogC'), fxK: u(this.p, 'uFxK'), fxRefl: u(this.p, 'uFxRefl'), fxFog: u(this.p, 'uFxFog'), time: u(this.p, 'uTime'),
      norm: u(this.p, 'uNorm'), hasNorm: u(this.p, 'uHasNorm'), normPack: u(this.p, 'uNormPack'), normY: u(this.p, 'uNormY'), mirror: u(this.p, 'uMirror'), view: u(this.p, 'uView'), ni: u(this.p, 'uNI'), surf: u(this.p, 'uSurf'), hasSurf: u(this.p, 'uHasSurf') };
    this.LU = { proj: u(this.lp, 'uProj'), mv: u(this.lp, 'uMV'), color: u(this.lp, 'uColor') };
    this.boneTex = gl.createTexture()!;
    this.gridVao = this.mkLineVao();
    this.skelVao = this.mkLineVao();
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  }

  private mkLineVao(): LineVao {
    const gl = this.gl, vao = gl.createVertexArray()!, buf = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    return { vao, buf };
  }
  private buf(target: number, data: ArrayBufferView): WebGLBuffer {
    const gl = this.gl, b = gl.createBuffer()!;
    gl.bindBuffer(target, b);
    gl.bufferData(target, data as BufferSource, gl.STATIC_DRAW);
    return b;
  }
  private attribs(m: GpuMesh): void {
    const gl = this.gl, sets: Array<[WebGLBuffer | null, number]> = [[m.bPos, 3], [m.bNor, 3], [m.bUV, 2], [m.bBone, 4], [m.bWt, 4], [m.bTan, 4], [m.bUV2, 2], [m.bA, 1]];
    // без скелета кости и веса, без второго UV — постоянные значения атрибутов, а не буферы (уровни: миллионы вершин)
    sets.forEach(([b, n], i) => {
      if (b) { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, 0, 0); }
      else { gl.disableVertexAttribArray(i); if (i === 4 || i === 7) gl.vertexAttrib4f(i, 1, 0, 0, 0); else gl.vertexAttrib4f(i, 0, 0, 0, 0); }
    });
    // запечённый свет: байты RGBA (нормированные), 128 — единица; нет буфера — постоянные 0.5
    if (m.bS) { gl.bindBuffer(gl.ARRAY_BUFFER, m.bS); gl.enableVertexAttribArray(8); gl.vertexAttribPointer(8, 4, gl.UNSIGNED_BYTE, true, 0, 0); }
    else { gl.disableVertexAttribArray(8); gl.vertexAttrib4f(8, 0.5, 0.5, 0.5, 0.5); }
  }

  /** Освободить GPU-ресурсы текущей модели. */
  clear(): void {
    const gl = this.gl;
    for (const m of this.meshes) {
      gl.deleteVertexArray(m.vao);
      if (m.vaoW) gl.deleteVertexArray(m.vaoW);
      if (m.tex) gl.deleteTexture(m.tex);
      if (m.norm) gl.deleteTexture(m.norm);
      if (m.surf) gl.deleteTexture(m.surf);
      if (m.tIdx) gl.deleteTexture(m.tIdx);
      if (m.vaoS) gl.deleteVertexArray(m.vaoS);
      for (const b of [m.bPos, m.bNor, m.bUV, m.bBone, m.bWt, m.bTan, m.bIdx, m.bLine, m.bUV2, m.bA, m.bS, m.bIdxS]) if (b) gl.deleteBuffer(b);
    }
    this.meshes = [];
    this.highlight = [];
    if (this.layTex) { gl.deleteTexture(this.layTex); this.layTex = null; }
    if (this.layNrm) { gl.deleteTexture(this.layNrm); this.layNrm = null; }
    if (this.layMid) { gl.deleteTexture(this.layMid); this.layMid = null; }
  }

  /** Полностью освободить контекст (при уничтожении просмотрщика). */
  dispose(): void {
    const gl = this.gl;
    this.clear();
    gl.deleteTexture(this.boneTex);
    for (const v of [this.gridVao, this.skelVao]) { gl.deleteVertexArray(v.vao); gl.deleteBuffer(v.buf); }
    gl.deleteProgram(this.p);
    gl.deleteProgram(this.lp);
    gl.deleteProgram(this.qp);
    gl.deleteVertexArray(this.qVao);
    this.freeTargets();
    if (this.lmBTex) gl.deleteTexture(this.lmBTex);
  }

  setModel(model: Model): void {
    const gl = this.gl;
    this.clear();
    // клетки отсечения: 1/16 размера сцены, не меньше 8 единиц; у моделей со скелетом вершины двигаются — без отсечения
    const B = model.bounds, ext = Math.max(B.max[0]! - B.min[0]!, B.max[1]! - B.min[1]!, B.max[2]! - B.min[2]!);
    const cellSize = Math.max(8, ext / 16), still = !model.skeleton;
    this.drawStats = { tris: 0, calls: 0, cells: 0 };
    for (const d of model.meshes) {
      const bPos = this.buf(gl.ARRAY_BUFFER, d.pos), bNor = this.buf(gl.ARRAY_BUFFER, d.nor), bUV = this.buf(gl.ARRAY_BUFFER, d.uv);
      const skin = !!model.skeleton;
      const bBone = skin ? this.buf(gl.ARRAY_BUFFER, d.bone) : null, bWt = skin ? this.buf(gl.ARRAY_BUFFER, d.weight) : null, bTan = this.buf(gl.ARRAY_BUFFER, computeTangents(d));
      const bUV2 = d.uv2 ? this.buf(gl.ARRAY_BUFFER, d.uv2) : null, bA = d.vertexAlpha ? this.buf(gl.ARRAY_BUFFER, d.vertexAlpha) : null, bS = d.vertexShade ? this.buf(gl.ARRAY_BUFFER, d.vertexShade) : null;
      const vao = gl.createVertexArray()!;
      const m: GpuMesh = { fx: d.screenFx ?? null, count: d.indices.length, data: d, idx: d.indices.slice(), visible: !d.defaultHidden, tex: null, norm: null, normPack: 'rgb', surf: null, tIdx: null, itype: d.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
        bPos, bNor, bUV, bBone, bWt, bTan, bUV2, bA, bS, vao, bIdx: null as unknown as WebGLBuffer, box: still && !d.dynamic ? meshBox(d.pos, d.indices) : null };
      gl.bindVertexArray(vao);
      this.attribs(m);
      m.bIdx = this.buf(gl.ELEMENT_ARRAY_BUFFER, m.idx);
      if (m.box) {
        const L = buildCells(d.pos, m.idx, cellSize);
        if (L) {
          m.cells = L;
          m.vaoS = gl.createVertexArray()!;
          gl.bindVertexArray(m.vaoS);
          this.attribs(m);
          m.bIdxS = this.buf(gl.ELEMENT_ARRAY_BUFFER, L.sorted);
        }
      }
      if (d.terrainIndex && model.terrainLayers) m.tIdx = this.uploadR8(d.terrainIndex);
      this.meshes.push(m);
    }
    gl.bindVertexArray(null);
    this.setTerrainLayers(model.terrainLayers ?? null);
    this.boneCount = model.skeleton ? model.skeleton.n : 0;
    this.skelN = 0;
    this.flipOn = !!model.flipZ;
    this.flip = this.flipOn ? FLIPZ : IDENT;
    this.yaw0 = model.cameraYaw ?? (this.flipOn ? Math.PI : 0);
    this.zUp = false;
    this.normalY = model.normalY === 'gl' ? 1 : -1;
    this.rawBounds = model.bounds;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, Math.max(1, this.boneCount), 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.setLightmap(model.lightmap ?? null);
    this.buildGrid();
    this.computeBounds();
  }

  /** Карта освещения уровня: яркость 1 байт на пиксель (R8) с mip-уровнями. */
  setLightmap(lm: Lightmap | null): void {
    const gl = this.gl;
    if (this.lmTex) { gl.deleteTexture(this.lmTex); this.lmTex = null; }
    if (this.lmBTex) { gl.deleteTexture(this.lmBTex); this.lmBTex = null; }
    if (!lm) return;
    if (lm.bump && lm.rgb) {
      // три карты базиса рельефа — слои массива текстур
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGB8, lm.width, lm.height, 3, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
      lm.bump.forEach((d, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, lm.width, lm.height, 1, gl.RGB, gl.UNSIGNED_BYTE, d));
      gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.lmBTex = t;
    }
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (lm.rgb) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, lm.width, lm.height, 0, gl.RGB, gl.UNSIGNED_BYTE, lm.data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, lm.width, lm.height, 0, gl.RED, gl.UNSIGNED_BYTE, lm.data);
    this.lmRgb = !!lm.rgb;
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.lmTex = t;
    this.lmScale = lm.scale ?? 1;
  }
  get hasLightmap(): boolean { return !!this.lmTex; }
  /** Есть карты освещения рельефа (Source bump lightmaps). */
  get hasBumpLightmap(): boolean { return !!this.lmBTex; }

  private freeTargets(): void {
    const gl = this.gl, T = this.fxT;
    if (!T) return;
    for (const f of [T.fbA, T.fbB, T.fbR]) gl.deleteFramebuffer(f);
    for (const r of [T.rbColor, T.rbDepth, T.rbReflDepth]) gl.deleteRenderbuffer(r);
    for (const t of [T.texColor, T.texDepth, T.texRefl]) gl.deleteTexture(t);
    this.fxT = null;
  }
  /** Буферы под размер холста; false — не удалось (тогда вода рисуется полупрозрачным цветом). */
  private targets(w: number, h: number): FxTargets | null {
    if (this.fxFailed) return null;
    if (this.fxT && this.fxT.w === w && this.fxT.h === h) return this.fxT;
    this.freeTargets();
    const gl = this.gl;
    const tex = (iw: number, ih: number, fmt: number, f: number, type: number) => {
      const t = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE10);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt, iw, ih, 0, f, type, null);
      const filt = f === gl.DEPTH_COMPONENT ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return t;
    };
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    const rb = (fmt: number, iw: number, ih: number, ms: number) => {
      const r = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, r);
      if (ms > 0) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, ms, fmt, iw, ih); else gl.renderbufferStorage(gl.RENDERBUFFER, fmt, iw, ih);
      return r;
    };
    const rw = Math.max(1, w >> 1), rh = Math.max(1, h >> 1);
    const T: FxTargets = {
      w, h, rw, rh, fbA: gl.createFramebuffer()!, rbColor: rb(gl.RGBA8, w, h, samples), rbDepth: rb(gl.DEPTH_COMPONENT24, w, h, samples),
      fbB: gl.createFramebuffer()!, texColor: tex(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE), texDepth: tex(w, h, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT),
      fbR: gl.createFramebuffer()!, texRefl: tex(rw, rh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE), rbReflDepth: rb(gl.DEPTH_COMPONENT24, rw, rh, 0),
    };
    let ok = true;
    const check = () => { ok &&= gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE; };
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbA);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, T.rbColor);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, T.rbDepth);
    check();
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.texColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, T.texDepth, 0);
    check();
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbR);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.texRefl, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, T.rbReflDepth);
    check();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fxT = T;
    if (!ok) { this.freeTargets(); this.fxFailed = true; return null; }
    return T;
  }

  private uploadR8(img: { width: number; height: number; data: Uint8Array }): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, img.width, img.height, 0, gl.RED, gl.UNSIGNED_BYTE, img.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  /** Слои поверхности ландшафта: текстуры одного размера — в массив текстур, параметры — в uniform-массивы (до 32). */
  /** Массив текстур одного размера (слои ландшафта), с mip-уровнями и повтором. */
  private uploadArray(images: readonly DecodedImage[], unit: number): WebGLTexture | null {
    const gl = this.gl, n = Math.min(32, images.length);
    if (!n) return null;
    const W = images[0]!.width, H = images[0]!.height, t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA, W, H, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (let i = 0; i < n; i++) { const im = images[i]!; if (im.rgba && im.width === W && im.height === H) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, W, H, 1, gl.RGBA, gl.UNSIGNED_BYTE, im.rgba); }
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (this.aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return t;
  }
  /** Слои поверхности ландшафта: текстуры — в массивы, параметры — в uniform-массивы (до 32). */
  private setTerrainLayers(L: Model['terrainLayers'] | null): void {
    const gl = this.gl;
    for (const k of ['layTex', 'layNrm', 'layMid'] as const) { const t = this[k]; if (t) { gl.deleteTexture(t); this[k] = null; } }
    if (!L || !L.images.length) return;
    const n = Math.min(32, L.images.length);
    this.layTex = this.uploadArray(L.images, 6);
    if (L.normals?.length === L.images.length) this.layNrm = this.uploadArray(L.normals, 7);
    if (L.middle?.length === L.images.length) this.layMid = this.uploadArray(L.middle, 8);
    this.layPar.fill(0); this.layMean.fill(0.5); this.layMPar.fill(0); this.layMMean.fill(0.5);
    for (let i = 0; i < n; i++) {
      this.layPar[i * 2] = L.period[i]! > 0 ? L.period[i]! : 4; this.layPar[i * 2 + 1] = L.tint[i] ?? 0.5;
      const m = L.mean[i] ?? [0.5, 0.5, 0.5];
      this.layMean[i * 3] = m[0]; this.layMean[i * 3 + 1] = m[1]; this.layMean[i * 3 + 2] = m[2];
      this.layMPar[i * 2] = L.midPeriod?.[i] ?? 75; this.layMPar[i * 2 + 1] = L.midBlend?.[i] ?? 0;
      const mm = L.midMean?.[i] ?? [0.5, 0.5, 0.5];
      this.layMMean[i * 3] = mm[0]; this.layMMean[i * 3 + 1] = mm[1]; this.layMMean[i * 3 + 2] = mm[2];
    }
    this.layFade = L.fade > 0 ? L.fade : 150;
  }

  /** Покадровая вершинная анимация (MD2/MD3/MDL): перезалить позиции и нормали. */
  updateGeometry(): void {
    const gl = this.gl;
    gl.bindVertexArray(null);
    for (const m of this.meshes) {
      if (!m.data.dynamic) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, m.bPos);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, m.data.pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.bNor);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, m.data.nor);
    }
  }

  setZUp(v: boolean): void { this.zUp = v; this.buildGrid(); }
  /** Диапазон высот модели в координатах показа (Y вверх) — для среза сверху. */
  heightRange(): [number, number] {
    const { min, max } = this.rawBounds;
    return this.zUp ? [min[2]!, max[2]!] : [min[1]!, max[1]!];
  }
  setMeshVisible(i: number, v: boolean): void { const m = this.meshes[i]; if (m) m.visible = v; }
  isMeshVisible(i: number): boolean { return this.meshes[i]?.visible ?? false; }
  /** Индексы меша на GPU (со скрытыми экземплярами — вырожденные). */
  gpuIndices(i: number): Uint16Array | Uint32Array | null { return this.meshes[i]?.idx ?? null; }

  /** Скрыть или показать часть меша (экземпляр объекта): треугольники становятся вырожденными, смещения не меняются. */
  setRangeVisible(i: number, iStart: number, iCount: number, visible: boolean): void {
    const m = this.meshes[i];
    if (!m || iCount <= 0) return;
    const end = Math.min(iStart + iCount, m.idx.length);
    if (visible) for (let k = iStart; k < end; k++) m.idx[k] = m.data.indices[k]!;
    else { const v = m.data.indices[iStart]!; m.idx.fill(v, iStart, end); }
    this.uploadIndices(m, iStart, end);
  }
  /** Перенести изменённые индексы [from, to) в порядок клеток (выгрузка — перед следующим кадром). */
  private syncSorted(m: GpuMesh, from: number, to: number, grow: boolean): void {
    const L = m.cells, t0 = Math.floor(from / 3), t1 = Math.ceil(to / 3);
    if (grow && m.box) { // объект сдвинут: рамки меша и клеток растут
      const b = m.box, P = m.data.pos, I = m.data.indices;
      for (let k = t0 * 3; k < t1 * 3; k++) { const o = I[k]! * 3; for (let a = 0; a < 3; a++) { const x = P[o + a]!; if (x < b[a]!) b[a] = x; if (x > b[3 + a]!) b[3 + a] = x; } }
      if (L) growCells(L, P, I, t0, t1);
    }
    if (!L) return;
    for (let t = t0; t < t1; t++) { const s = L.slot[t]! * 3; L.sorted[s] = m.idx[t * 3]!; L.sorted[s + 1] = m.idx[t * 3 + 1]!; L.sorted[s + 2] = m.idx[t * 3 + 2]!; }
    m.sortDirty = true;
  }
  /** Перезалить вершины (позиции, нормали) и индексы части меша после изменения данных (поворот экземпляра). */
  updateRange(i: number, vStart: number, vCount: number, iStart: number, iCount: number, hidden = false): void {
    const gl = this.gl, m = this.meshes[i];
    if (!m) return;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.bPos);
    gl.bufferSubData(gl.ARRAY_BUFFER, vStart * 12, m.data.pos.subarray(vStart * 3, (vStart + vCount) * 3));
    gl.bindBuffer(gl.ARRAY_BUFFER, m.bNor);
    gl.bufferSubData(gl.ARRAY_BUFFER, vStart * 12, m.data.nor.subarray(vStart * 3, (vStart + vCount) * 3));
    if (!hidden) { for (let k = iStart; k < iStart + iCount; k++) m.idx[k] = m.data.indices[k]!; this.uploadIndices(m, iStart, iStart + iCount); }
    this.syncSorted(m, iStart, iStart + iCount, true);
  }
  private uploadIndices(m: GpuMesh, from: number, to: number): void {
    const gl = this.gl, bpe = m.idx.BYTES_PER_ELEMENT;
    gl.bindVertexArray(m.vao);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, from * bpe, m.idx.subarray(from, to));
    gl.bindVertexArray(null);
    this.syncSorted(m, from, to, false);
    // каркас пересобирается из idx при следующем показе
    if (m.vaoW) { gl.deleteVertexArray(m.vaoW); m.vaoW = undefined; }
    if (m.bLine) { gl.deleteBuffer(m.bLine); m.bLine = undefined; }
  }
  /** Подсветить части мешей (выбранный объект); пустой список — снять подсветку. */
  setHighlight(list: Array<{ mesh: number; iStart: number; iCount: number }>): void { this.highlight = list; }

  private computeBounds(): void {
    const { min, max } = this.rawBounds;
    let c = [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2];
    if (this.zUp) c = [c[0]!, c[2]!, -c[1]!];
    if (this.flipOn) c[2] = -c[2]!;
    this.bounds = { center: c, radius: Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / 2 || 1 };
  }
  private buildGrid(): void {
    const gl = this.gl, { min, max } = this.rawBounds;
    const lo = this.zUp ? [min[0]!, min[2]!, -max[1]!] : min, hi = this.zUp ? [max[0]!, max[2]!, -min[1]!] : max;
    const half = Math.max(hi[0]! - lo[0]!, hi[2]! - lo[2]!, (hi[1]! - lo[1]!) * 0.6) || 1, g: number[] = [];
    for (let i = -10; i <= 10; i++) { const v = (i * half) / 10; g.push(-half, lo[1]!, v, half, lo[1]!, v, v, lo[1]!, -half, v, lo[1]!, half); }
    gl.bindVertexArray(this.gridVao.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.gridVao.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(g), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.gridN = g.length / 3;
  }
  /** Поставить камеру так, чтобы модель целиком попадала в кадр. */
  fit(camera: OrbitCamera): void {
    this.computeBounds();
    const b = this.bounds;
    camera.reset();
    camera.yaw = this.yaw0;
    camera.target = [...b.center];
    camera.dist = b.radius * 2.6;
  }

  setTexture(i: number, img: DecodedImage | null): void {
    const gl = this.gl, m = this.meshes[i];
    if (!m) return;
    if (m.tex) { gl.deleteTexture(m.tex); m.tex = null; }
    if (img) m.tex = this.upload(img);
  }
  /** Карта нормалей меша (packing — как упакована нормаль, см. analyzeNormalMap). */
  setNormalMap(i: number, img: DecodedImage | null, packing: NormalPacking = 'rgb'): void {
    const gl = this.gl, m = this.meshes[i];
    if (!m) return;
    if (m.norm) { gl.deleteTexture(m.norm); m.norm = null; }
    m.normPack = packing;
    if (img) m.norm = this.upload(img);
  }
  /** Сведённая PBR-карта меша (R AO, G шероховатость, B металличность, A блик), см. composeSurface. */
  setSurface(i: number, img: DecodedImage | null): void {
    const gl = this.gl, m = this.meshes[i];
    if (!m) return;
    if (m.surf) { gl.deleteTexture(m.surf); m.surf = null; }
    if (img) m.surf = this.upload(img);
  }
  private upload(img: DecodedImage): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (img.rgba) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.rgba);
    else if (img.bitmap) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img.bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
    return t;
  }

  updatePose(skel: SkeletonRuntime | null): void {
    const gl = this.gl, n = skel ? skel.n : 0;
    if (!skel || !n) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, n, gl.RGBA, gl.FLOAT, skel.skin);
    const l: number[] = [];
    for (let i = 0; i < n; i++) {
      const p = skel.parent[i]!;
      if (p < 0) continue;
      const a = skel.worldV[p]!, b = skel.worldV[i]!;
      l.push(a[12]!, a[13]!, a[14]!, b[12]!, b[13]!, b[14]!);
    }
    gl.bindVertexArray(this.skelVao.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skelVao.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(l), gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
    this.skelN = l.length / 3;
  }

  draw(cam: OrbitCamera, o: DrawOptions): void {
    const gl = this.gl, c = this.canvas, dpr = globalThis.devicePixelRatio || 1, th = this.theme;
    const w = Math.max(1, Math.floor(c.clientWidth * dpr)), h = Math.max(1, Math.floor(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const r = this.bounds.radius;
    // полёт: глаз внутри сцены — ближняя плоскость маленькая, дальняя — по размеру сцены
    const near = cam.mode === 'fly' ? Math.max(0.01, Math.min(0.1, r * 0.001)) : Math.max(r * 0.01, cam.dist * 0.01), farP = cam.mode === 'fly' ? r * 4 + 100 : r * 100 + cam.dist * 2;
    const proj = perspective(cam.mode === 'fly' ? 1.0 : 0.8, w / h, near, farP);
    const model = this.zUp ? mulCol(this.flip, ZUP) : this.flip;
    const mvG = mulCol(cam.view(), this.flip), mv = this.zUp ? mulCol(mvG, ZUP) : mvG;
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.p);
    gl.uniformMatrix4fv(this.U.proj!, false, proj);
    gl.uniformMatrix4fv(this.U.model!, false, model);
    this.lastPVM = mulCol(proj, mv);
    const far = o.drawDistance && o.drawDistance > 0 ? o.drawDistance : Infinity;
    // отсечение: глаз в координатах модели — последний столбец обратной mv
    const eyeOf = (m: Float32Array) => { const inv = invert(m); return inv ? [inv[12]! / inv[15]!, inv[13]! / inv[15]!, inv[14]! / inv[15]!] : null; };
    const pvm = this.lastPVM, eye = eyeOf(mv);
    const stats = (this.drawStats = { tris: 0, calls: 0, cells: 0 }), ranges: number[] = [];
    gl.uniform1f(this.U.clipY!, o.clipY ?? 1e30);
    gl.uniform1i(this.U.bones!, 1);
    gl.uniform1i(this.U.tex!, 0);
    gl.uniform1i(this.U.norm!, 2);
    gl.uniform1i(this.U.surf!, 3);
    gl.uniform1f(this.U.normY!, this.normalY * (o.normalFlipY ? -1 : 1));
    gl.uniform1i(this.U.view!, typeof o.normalView === 'number' ? o.normalView : o.normalView ? 1 : 0);
    gl.uniform1f(this.U.ni!, o.normalStrength ?? 1);
    gl.uniform1i(this.U.skinned!, this.boneCount > 0 ? 1 : 0);
    gl.uniform1i(this.U.lm!, 4);
    gl.uniform1f(this.U.lmK!, this.lmScale * (o.lightmapScale ?? 1));
    gl.uniform1i(this.U.lmRgb!, this.lmRgb ? 1 : 0);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.lmTex);
    gl.uniform1i(this.U.lmB!, 9);
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.lmBTex);
    gl.uniform1i(this.U.tIdx!, 5);
    gl.uniform1i(this.U.tLay!, 6);
    gl.uniform2fv(this.U.tPar!, this.layPar);
    gl.uniform3fv(this.U.tMean!, this.layMean);
    gl.uniform1f(this.U.tFade!, this.layFade);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.layTex);
    gl.uniform1i(this.U.tNrm!, 7);
    gl.uniform1i(this.U.tMid!, 8);
    gl.uniform1i(this.U.tHasN!, this.layNrm && o.normals !== false ? 1 : 0);
    gl.uniform1i(this.U.tHasM!, this.layMid ? 1 : 0);
    gl.uniform2fv(this.U.tMPar!, this.layMPar);
    gl.uniform3fv(this.U.tMMean!, this.layMMean);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.layNrm);
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.layMid);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.uniform1i(this.U.refl!, 10);
    gl.uniform1i(this.U.refr!, 11);
    gl.uniform1i(this.U.depth!, 12);
    gl.uniform1i(this.U.fx!, 0);
    gl.uniform1i(this.U.clipOn!, 0);
    gl.uniform1i(this.U.flat!, 0);
    gl.uniform1f(this.U.flatAlpha!, 1);
    const drawMesh = (m: GpuMesh, pvmX: Float32Array, eyeX: number[] | null) => {
      gl.activeTexture(gl.TEXTURE0);
      const has = o.tex && m.tex;
      gl.bindTexture(gl.TEXTURE_2D, has ? m.tex : null);
      gl.uniform1i(this.U.hasTex!, has ? 1 : 0);
      gl.uniform3fv(this.U.base!, m.data.color ?? th.base);
      const nm = o.normals !== false && m.norm;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, nm ? m.norm : null);
      gl.uniform1i(this.U.hasNorm!, nm ? 1 : 0);
      gl.uniform1i(this.U.normPack!, m.normPack === 'rg' ? 1 : m.normPack === 'ag' ? 2 : 0);
      const sf = o.pbr !== false && m.surf;
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, sf ? m.surf : null);
      gl.uniform1i(this.U.hasSurf!, sf ? 1 : 0);
      gl.uniform1i(this.U.alpha!, o.alpha || m.data.alphaTest ? 1 : 0);
      const lmOn = !!(this.lmTex && m.data.uv2 && o.lightmap !== false);
      gl.uniform1i(this.U.hasLm!, lmOn ? 1 : 0);
      gl.uniform1i(this.U.hasLmB!, lmOn && this.lmBTex && o.bumpLightmap !== false ? 1 : 0);
      const terr = !!(has && m.tIdx && this.layTex && o.terrainLayers !== false);
      gl.uniform1i(this.U.terr!, terr ? 1 : 0);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, terr ? m.tIdx : null);
      if (m.cells && m.vaoS) {
        gl.bindVertexArray(m.vaoS);
        if (m.sortDirty) { gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, m.cells.sorted); m.sortDirty = false; }
        visibleRanges(m.cells, pvmX, eyeX, far, ranges);
        const bpe = m.idx.BYTES_PER_ELEMENT;
        for (let k = 0; k < ranges.length; k += 2) { gl.drawElements(gl.TRIANGLES, ranges[k + 1]!, m.itype, ranges[k]! * bpe); stats.tris += ranges[k + 1]! / 3; stats.calls++; }
        stats.cells += m.cells.start.length;
        return;
      }
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.count, m.itype, 0);
      stats.tris += m.count / 3; stats.calls++;
    };
    const seenBy = (m: GpuMesh, pvmX: Float32Array, eyeX: number[] | null) => m.visible && (!m.box || boxVisible(m.box, 0, pvmX, eyeX, far));
    const fxWanted = o.screenFx !== false;
    const fxList = this.meshes.filter((m) => m.fx && seenBy(m, pvm, eye));
    const T = fxWanted && fxList.length ? this.targets(w, h) : null;
    /** Сцена без воды и стекла: сначала непрозрачные, затем слои с прозрачностью по вершинам; fallback — вода цветом поверх. */
    const scene = (mvX: Float32Array, pvmX: Float32Array, eyeX: number[] | null, fallbackFx: boolean) => {
      gl.uniformMatrix4fv(this.U.mv!, false, mvX);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      for (const m of this.meshes) if (!m.bA && !m.fx && seenBy(m, pvmX, eyeX)) drawMesh(m, pvmX, eyeX);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      const over = this.meshes.filter((m) => (m.bA || (fallbackFx && m.fx)) && seenBy(m, pvmX, eyeX));
      if (!over.length) return;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      for (const m of over) {
        // без буферов кадра: вода и стекло — полупрозрачный цвет (постоянная прозрачность вершин)
        if (m.fx) gl.vertexAttrib4f(7, m.fx.fallback.opacity, 0, 0, 0);
        drawMesh(m, pvmX, eyeX);
        if (m.fx) gl.vertexAttrib4f(7, 1, 0, 0, 0);
      }
      gl.depthMask(true);
      gl.depthFunc(gl.LESS);
      gl.disable(gl.BLEND);
    };
    const bg = () => { gl.clearColor(th.background[0], th.background[1], th.background[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); };
    this.fxStats = { meshes: T ? fxList.length : 0, reflection: false };
    // ---------- отражение: сцена, отражённая плоскостью ближайшей видимой воды (в половинном разрешении) ----------
    let reflPlane: number[] | null = null;
    if (T && eye) {
      let best = Infinity;
      for (const m of fxList) {
        const pl = m.fx!.plane;
        if (m.fx!.kind !== 'water' || !pl) continue;
        const dist = Math.abs(pl[0] * eye[0]! + pl[1] * eye[1]! + pl[2] * eye[2]! - pl[3]);
        if (dist < best) { best = dist; reflPlane = pl; }
      }
    }
    if (T && reflPlane && eye) {
      const [nx, ny, nz, d] = reflPlane as [number, number, number, number];
      // отражение точки: p − 2(n·p − d)n (по столбцам)
      const R = new Float32Array([1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * nz, 0, -2 * ny * nx, 1 - 2 * ny * ny, -2 * ny * nz, 0, -2 * nz * nx, -2 * nz * ny, 1 - 2 * nz * nz, 0, 2 * d * nx, 2 * d * ny, 2 * d * nz, 1]);
      const mvR = mulCol(mv, R), pvmR = mulCol(proj, mvR), eyeR = eyeOf(mvR), side = nx * eye[0]! + ny * eye[1]! + nz * eye[2]! - d >= 0 ? 1 : -1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbR);
      gl.viewport(0, 0, T.rw, T.rh);
      bg();
      gl.uniform1i(this.U.clipOn!, 1);
      gl.uniform4f(this.U.clipPl!, nx * side, ny * side, nz * side, -d * side);
      gl.uniform1f(this.U.mirror!, this.flipOn ? 1 : -1);
      const saved = { ...stats };
      scene(mvR, pvmR, eyeR, false);
      Object.assign(stats, saved);
      gl.uniform1i(this.U.clipOn!, 0);
      this.fxStats.reflection = true;
    }
    gl.uniform1f(this.U.mirror!, this.flipOn ? -1 : 1);
    // ---------- основная сцена: в промежуточный буфер (MSAA), если на кадре есть вода или стекло ----------
    gl.bindFramebuffer(gl.FRAMEBUFFER, T ? T.fbA : null);
    gl.viewport(0, 0, w, h);
    bg();
    scene(mv, pvm, eye, !T);
    if (T) {
      // снимок сцены с глубиной — то, что видно сквозь воду и стекло
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.fbA);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.fbB);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbA);
      gl.activeTexture(gl.TEXTURE10);
      gl.bindTexture(gl.TEXTURE_2D, this.fxStats.reflection ? T.texRefl : null);
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D, T.texColor);
      gl.activeTexture(gl.TEXTURE12);
      gl.bindTexture(gl.TEXTURE_2D, T.texDepth);
      gl.uniform2f(this.U.screen!, w, h);
      gl.uniform2f(this.U.nf!, near, farP);
      gl.uniform1f(this.U.time!, (performance.now() / 1000) % 3600);
      gl.uniformMatrix4fv(this.U.mv!, false, mv);
      gl.depthFunc(gl.LEQUAL);
      for (const m of fxList) {
        const f = m.fx!, pl = f.plane;
        const same = !!(reflPlane && pl && pl.every((v, k) => Math.abs(v - reflPlane![k]!) < (k === 3 ? 1 : 0.01)));
        gl.uniform1i(this.U.fx!, f.kind === 'water' ? 1 : 2);
        gl.uniform1i(this.U.fxRefl!, same ? 1 : 0);
        gl.uniform3fv(this.U.fxRT!, f.refractTint);
        gl.uniform3fv(this.U.fxLT!, f.reflectTint ?? (f.kind === 'glass' ? [0, 0, 0] : [1, 1, 1]));
        gl.uniform4f(this.U.fxK!, f.refract, f.reflect ?? 0, f.fog?.start ?? 0, f.fog?.end ?? 1);
        gl.uniform1i(this.U.fxFog!, f.fog ? 1 : 0);
        gl.uniform3fv(this.U.fogC!, f.fog?.color ?? [0, 0, 0]);
        gl.uniform2fv(this.U.fxScroll!, f.scroll ?? [0, 0]);
        drawMesh(m, pvm, eye);
      }
      gl.uniform1i(this.U.fx!, 0);
      gl.depthFunc(gl.LESS);
      for (const u of [10, 11, 12]) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, null); }
    }
    if (o.wire) {
      gl.uniform1i(this.U.flat!, 1);
      gl.uniform3f(this.U.flatColor!, th.wire[0], th.wire[1], th.wire[2]);
      for (const m of this.meshes) {
        if (!m.visible) continue;
        if (!m.vaoW) {
          const d = m.idx, e = d instanceof Uint32Array ? new Uint32Array(d.length * 2) : new Uint16Array(d.length * 2);
          for (let t = 0; t + 2 < d.length; t += 3) e.set([d[t]!, d[t + 1]!, d[t + 1]!, d[t + 2]!, d[t + 2]!, d[t]!], t * 2);
          m.vaoW = gl.createVertexArray()!;
          gl.bindVertexArray(m.vaoW);
          this.attribs(m);
          m.bLine = this.buf(gl.ELEMENT_ARRAY_BUFFER, e);
          m.lineCount = e.length;
        }
        gl.bindVertexArray(m.vaoW);
        gl.drawElements(gl.LINES, m.lineCount!, m.itype, 0);
      }
    }
    if (this.highlight.length) {
      gl.uniform1i(this.U.flat!, 1);
      gl.uniform3f(this.U.flatColor!, 1.0, 0.62, 0.15);
      gl.uniform1f(this.U.flatAlpha!, 0.45);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthFunc(gl.LEQUAL);
      for (const h of this.highlight) {
        const m = this.meshes[h.mesh];
        if (!m?.visible) continue;
        gl.bindVertexArray(m.vao);
        gl.drawElements(gl.TRIANGLES, h.iCount, m.itype, h.iStart * m.idx.BYTES_PER_ELEMENT);
      }
      gl.depthFunc(gl.LESS);
      gl.disable(gl.BLEND);
    }
    gl.uniform1f(this.U.flatAlpha!, 1);
    gl.useProgram(this.lp);
    gl.uniformMatrix4fv(this.LU.proj!, false, proj);
    gl.uniformMatrix4fv(this.LU.mv!, false, mvG);
    if (o.grid && this.gridN) {
      gl.uniform4fv(this.LU.color!, th.grid);
      gl.bindVertexArray(this.gridVao.vao);
      gl.drawArrays(gl.LINES, 0, this.gridN);
    }
    if (o.skeleton && this.skelN) {
      gl.uniformMatrix4fv(this.LU.mv!, false, mv);
      gl.disable(gl.DEPTH_TEST);
      gl.uniform4fv(this.LU.color!, th.skeleton);
      gl.bindVertexArray(this.skelVao.vao);
      gl.drawArrays(gl.LINES, 0, this.skelN);
    }
    if (T) {
      // готовый кадр: сведение MSAA в текстуру и вывод на холст
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.fbA);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.fbB);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.qp);
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D, T.texColor);
      gl.uniform1i(gl.getUniformLocation(this.qp, 'uT'), 11);
      gl.bindVertexArray(this.qVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.enable(gl.DEPTH_TEST);
    }
    gl.bindVertexArray(null);
  }
}
