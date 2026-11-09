// Готовый просмотрщик для страницы: холст + камера с мышью + цикл анимации. Без привязки к интерфейсу расширения.
import type { DecodedImage, Model, Motion } from '../core/types';
import { OrbitCamera, type CameraMode } from './camera';
import { DARK_THEME, Renderer, type DrawOptions, type RendererTheme } from './renderer';
import type { NormalPacking } from '../core/normals';
import { pickRay, type RayHit } from '../core/scene';
import { invert } from './mat4';

/** Инструмент мыши: camera — только камера; select — щелчок выбирает объект; rotate — щелчок выбирает, перетаскивание поворачивает выбранное. */
export type ViewerTool = 'camera' | 'select' | 'rotate' | 'move';

export interface PlaybackState {
  motion: Motion | null;
  time: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  /** Инвертировать знак кватернионов (X-Ray). */
  invert: boolean;
}

export interface ModelViewerOptions {
  /** Подписать холст на мышь/колесо (по умолчанию да). */
  controls?: boolean;
  theme?: RendererTheme;
  /** Вызывается каждый кадр анимации (для ползунка времени). */
  onFrame?(state: Readonly<PlaybackState>): void;
  /** Анимация закончилась (без зацикливания). */
  onEnded?(): void;
  /** Прицел изменён перетаскиванием с Alt (слой-сетка поз). */
  onAim?(grid: { x: number; y: number; cols: number; rows: number }): void;
  /** Щелчок по холсту в режимах select/rotate: попадание (или null — мимо). */
  onPick?(hit: RayHit | null, e: PointerEvent): void;
  /** Перетаскивание левой кнопкой в режимах rotate/move: true — обработано (камера не двигается). */
  onToolDrag?(dx: number, dy: number, e: PointerEvent): boolean;
}

export class ModelViewer {
  readonly renderer: Renderer;
  readonly camera = new OrbitCamera();
  readonly options: DrawOptions = { tex: true, wire: false, skeleton: false, grid: true, alpha: false, normals: true, normalFlipY: false, normalView: false, pbr: true };
  readonly state: PlaybackState = { motion: null, time: 0, playing: true, speed: 1, loop: true, invert: false };
  model: Model | null = null;
  tool: ViewerTool = 'camera';
  private raf = 0;
  private last = 0;
  private animKey = '';
  private animMotion: Motion | null = null;
  private readonly cleanup: Array<() => void> = [];
  /** Нажатые клавиши (для полёта). */
  private readonly keys = new Set<string>();

  constructor(readonly canvas: HTMLCanvasElement, private readonly opts: ModelViewerOptions = {}) {
    this.renderer = new Renderer(canvas);
    this.renderer.theme = opts.theme ?? DARK_THEME;
    if (opts.controls !== false) this.attachControls();
  }

  setTheme(theme: RendererTheme): void { this.renderer.theme = theme; }

  setModel(model: Model): void {
    this.model = model;
    this.state.motion = null;
    this.state.time = 0;
    this.state.invert = false;
    this.animKey = '';
    this.animMotion = null;
    this.renderer.setModel(model);
    this.renderer.setZUp(!!model.defaultZUp);
    this.fit();
    if (model.skeleton) { model.skeleton.pose(null, 0, false, false); this.renderer.updatePose(model.skeleton); }
  }

  setTexture(meshIndex: number, image: DecodedImage | null): void { this.renderer.setTexture(meshIndex, image); }
  setSurface(meshIndex: number, image: DecodedImage | null): void { this.renderer.setSurface(meshIndex, image); }
  setNormalMap(meshIndex: number, image: DecodedImage | null, packing: NormalPacking = 'rgb'): void { this.renderer.setNormalMap(meshIndex, image, packing); }
  setZUp(v: boolean): void { this.renderer.setZUp(v); this.fit(); }
  /**
   * Свободная камера: WASD — вперёд/влево/назад/вправо, E/Пробел — вверх, Q/C — вниз, Shift — быстрее, Alt — медленнее;
   * мышь — поворот головы, колесо — скорость. Включается из текущего положения глаза.
   */
  setCameraMode(mode: CameraMode): void {
    this.camera.setMode(mode, this.renderer.bounds.radius);
    this.keys.clear();
  }
  get cameraMode(): CameraMode { return this.camera.mode; }
  /** Луч из точки холста (координаты клиента) в координатах модели. */
  rayAt(clientX: number, clientY: number): { origin: number[]; dir: number[] } | null {
    const pvm = this.renderer.lastPVM, inv = pvm && invert(pvm);
    if (!inv) return null;
    const r = this.canvas.getBoundingClientRect(), x = ((clientX - r.left) / r.width) * 2 - 1, y = 1 - ((clientY - r.top) / r.height) * 2;
    const un = (z: number) => {
      const v = [0, 1, 2, 3].map((k) => inv[k]! * x + inv[4 + k]! * y + inv[8 + k]! * z + inv[12 + k]!);
      return [v[0]! / v[3]!, v[1]! / v[3]!, v[2]! / v[3]!];
    };
    const a = un(-1), b = un(1), d = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    return { origin: a, dir: d.map((v) => v / l) };
  }
  /** Треугольник модели под точкой холста (видимые меши, без скрытых экземпляров, с учётом среза). */
  pickAt(clientX: number, clientY: number): RayHit | null {
    const model = this.model, ray = this.rayAt(clientX, clientY);
    if (!model || !ray) return null;
    const clipY = this.options.clipY, zUp = this.renderer.zUpOn;
    return pickRay(model, ray.origin, ray.dir, {
      skip: (i) => !this.renderer.isMeshVisible(i),
      indices: (i) => this.renderer.gpuIndices(i) ?? model.meshes[i]!.indices,
      clip: clipY === undefined ? undefined : (_x, y, z) => (zUp ? z : y) > clipY,
    });
  }
  /** Навести камеру на рамку (в координатах модели); режим камеры сохраняется. */
  focusBox(min: ArrayLike<number>, max: ArrayLike<number>): void {
    const c = this.renderer.toView((min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2, (min[2]! + max[2]!) / 2);
    const r = Math.max(0.25, Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) / 2), cam = this.camera;
    if (cam.mode === 'orbit') { cam.target = c; cam.dist = r * 2.6; return; }
    // полёт: глаз на расстоянии от объекта, взгляд на него
    const e = cam.eye(), b = [e[0]! - cam.target[0]!, e[1]! - cam.target[1]!, e[2]! - cam.target[2]!], l = Math.hypot(b[0]!, b[1]!, b[2]!) || 1, k = r * 2.6 - cam.dist;
    cam.target = [c[0]! + (b[0]! / l) * k, c[1]! + (b[1]! / l) * k, c[2]! + (b[2]! / l) * k];
  }
  /** Диапазон высот модели (для ползунка среза). */
  heightRange(): [number, number] { return this.renderer.heightRange(); }
  /** Показать модель целиком; в режиме полёта глаз ставится туда же, режим сохраняется. */
  fit(): void {
    const mode = this.camera.mode;
    this.camera.mode = 'orbit';
    this.renderer.fit(this.camera);
    if (mode === 'fly') this.camera.setMode('fly', this.renderer.bounds.radius);
  }

  /** Сетка прицела текущей анимации (первый слой с grid) или null. */
  aimGrid(): { cols: number; rows: number; x: number; y: number } | null {
    const m = this.state.motion;
    return m && m.kind === 'node' ? m.blend ?? m.layers?.find((l) => l.grid)?.grid ?? null : null;
  }

  /** Выбрать анимацию (null — bind-поза) и начать проигрывание. */
  setMotion(motion: Motion | null): void {
    this.state.motion = motion;
    this.state.time = 0;
    this.state.playing = true;
    if (motion && this.model?.detectInvert) this.state.invert = this.model.detectInvert(motion);
  }
  seek(fraction: number): void {
    const m = this.state.motion;
    if (!m) return;
    this.state.time = Math.max(0, Math.min(1, fraction)) * m.duration;
    this.state.playing = false;
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => { this.frame(now); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }
  stop(): void { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  /** Один шаг: продвинуть время, обновить позу, нарисовать. */
  frame(now: number): void {
    const s = this.state, dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const m = s.motion, model = this.model, sk = model?.skeleton ?? null;
    if (m && s.playing) {
      s.time += dt * s.speed;
      if (s.loop) s.time = m.duration > 0 ? s.time % m.duration : 0;
      else if (s.time >= m.duration) { s.time = m.duration; s.playing = false; this.opts.onEnded?.(); }
    }
    if (model?.animate) {
      const key = s.time.toFixed(4);
      if (key !== this.animKey || m !== this.animMotion) { this.animKey = key; this.animMotion = m; model.animate(m, s.time, s.loop); this.renderer.updateGeometry(); }
    }
    if (sk) { sk.pose(m, s.time, s.loop, s.invert); this.renderer.updatePose(sk); }
    if (this.camera.mode === 'fly' && this.keys.size) {
      const k = (...c: string[]) => (c.some((x) => this.keys.has(x)) ? 1 : 0);
      const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : this.keys.has('AltLeft') || this.keys.has('AltRight') ? 0.25 : 1;
      this.camera.move(k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown'), k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'), k('KeyE', 'Space', 'PageUp') - k('KeyQ', 'KeyC', 'PageDown'), dt * boost);
    }
    this.opts.onFrame?.(s);
    this.renderer.draw(this.camera, this.options);
  }

  private attachControls(): void {
    const cv = this.canvas;
    let drag: { x: number; y: number } | null = null, start: { x: number; y: number; moved: boolean } | null = null;
    const on = <K extends keyof HTMLElementEventMap>(t: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      cv.addEventListener(t, fn as EventListener, o);
      this.cleanup.push(() => cv.removeEventListener(t, fn as EventListener, o));
    };
    on('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; start = { x: e.clientX, y: e.clientY, moved: false }; cv.setPointerCapture(e.pointerId); });
    on('pointerup', (e) => {
      // щелчок без сдвига в режимах выбора — выбор объекта
      if (start && !start.moved && e.button === 0 && this.tool !== 'camera') this.opts.onPick?.(this.pickAt(e.clientX, e.clientY), e);
      drag = null; start = null;
    });
    on('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) start.moved = true;
      if (!start?.moved) return;
      const left = (e.buttons & 1) !== 0 && !e.shiftKey;
      // Alt + перетаскивание — прицел (слой-сетка поз): вправо/влево — поворот корпуса, вверх/вниз — наклон
      const g = left && e.altKey ? this.aimGrid() : null;
      if (g) {
        g.x = Math.max(0, Math.min(g.cols - 1, g.x - dx * 0.008));
        g.y = Math.max(0, Math.min(g.rows - 1, g.y - dy * 0.008));
        this.opts.onAim?.(g);
        return;
      }
      if (left && (this.tool === 'rotate' || this.tool === 'move') && this.opts.onToolDrag?.(dx, dy, e)) return;
      if (e.buttons & 2 || e.shiftKey || e.buttons & 4) this.camera.pan(dx, dy); else this.camera.rotate(dx, dy);
    });
    on('wheel', (e) => { e.preventDefault(); this.camera.zoom(Math.exp(e.deltaY * 0.001)); }, { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    // клавиатура для полёта: по коду клавиши (работает в любой раскладке); не мешаем вводу в поля
    const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === 'INPUT' && !['checkbox', 'range', 'button'].includes((t as HTMLInputElement).type) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); };
    const down = (e: KeyboardEvent) => {
      if (this.camera.mode !== 'fly' || typing(e)) return;
      this.keys.add(e.code);
      if (/^(Key[WASDQEC]|Space|Arrow|Page)/.test(e.code)) e.preventDefault();
    };
    const up = (e: KeyboardEvent) => { this.keys.delete(e.code); };
    const blur = () => this.keys.clear();
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    addEventListener('blur', blur);
    this.cleanup.push(() => { removeEventListener('keydown', down); removeEventListener('keyup', up); removeEventListener('blur', blur); });
  }

  dispose(): void {
    this.stop();
    for (const f of this.cleanup.splice(0)) f();
    this.renderer.dispose();
  }
}
