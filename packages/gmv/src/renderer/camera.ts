// Камера: «орбита» вокруг точки (по умолчанию) или «полёт» — свободная камера от первого лица (WASD + мышь) для уровней.
import { lookAt } from './mat4';

export type CameraMode = 'orbit' | 'fly';

export class OrbitCamera {
  yaw = Math.PI;
  pitch = 0.15;
  dist = 3;
  target: number[] = [0, 1, 0];
  mode: CameraMode = 'orbit';
  /** Скорость полёта, единиц сцены в секунду. */
  speed = 5;

  constructor() { this.reset(); }
  reset(): void { this.yaw = Math.PI; this.pitch = 0.15; this.dist = 3; this.target = [0, 1, 0]; }
  /** Направление от цели к глазу (единичное). */
  private back(): number[] { const cp = Math.cos(this.pitch); return [cp * Math.sin(this.yaw), Math.sin(this.pitch), cp * Math.cos(this.yaw)]; }
  eye(): number[] { const b = this.back(); return [this.target[0]! + this.dist * b[0]!, this.target[1]! + this.dist * b[1]!, this.target[2]! + this.dist * b[2]!]; }
  view(): Float32Array { return lookAt(this.eye(), this.target, [0, 1, 0]); }
  /** Орбита: поворот вокруг цели. Полёт: поворот головы на месте (глаз неподвижен). */
  rotate(dx: number, dy: number): void {
    if (this.mode === 'fly') {
      const e = this.eye();
      this.yaw -= dx * 0.005;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch + dy * 0.005)); // мышь вниз — взгляд вниз
      const b = this.back();
      this.target = [e[0]! - this.dist * b[0]!, e[1]! - this.dist * b[1]!, e[2]! - this.dist * b[2]!];
      return;
    }
    this.yaw -= dx * 0.01;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.01));
  }
  /** Орбита: приближение. Полёт: колесо меняет скорость. */
  zoom(f: number): void {
    if (this.mode === 'fly') { this.speed = Math.max(0.05, Math.min(1e4, this.speed / f)); return; }
    this.dist = Math.max(0.01, this.dist * f);
  }
  pan(dx: number, dy: number): void {
    const e = this.eye(), f = [this.target[0]! - e[0]!, this.target[1]! - e[1]!, this.target[2]! - e[2]!], l = Math.hypot(...f);
    for (let i = 0; i < 3; i++) f[i] /= l;
    // right = f × up(0,1,0)
    let r = [-f[2]!, 0, f[0]!];
    const rl = Math.hypot(...r) || 1;
    r = r.map((v) => v / rl);
    const u = [r[1]! * f[2]! - r[2]! * f[1]!, r[2]! * f[0]! - r[0]! * f[2]!, r[0]! * f[1]! - r[1]! * f[0]!];
    const k = this.mode === 'fly' ? this.speed * 0.004 : this.dist * 0.0015;
    for (let i = 0; i < 3; i++) this.target[i] += (-r[i]! * dx + u[i]! * dy) * k;
  }
  /**
   * Полёт: сдвиг на (вперёд, вправо, вверх) × скорость × dt. «Вперёд» — куда смотрит камера (с наклоном),
   * «вправо» — по горизонтали, «вверх» — по мировой оси Y.
   */
  move(fwd: number, right: number, up: number, dt: number): void {
    const b = this.back(), k = this.speed * dt;
    const f = [-b[0]!, -b[1]!, -b[2]!], r = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    for (let i = 0; i < 3; i++) this.target[i] += (f[i]! * fwd + r[i]! * right) * k;
    this.target[1] += up * k;
  }
  /** Переключить режим, не сдвигая глаз: в полёте цель — в полуметре перед глазом. */
  setMode(mode: CameraMode, sceneRadius = 10): void {
    if (mode === this.mode) return;
    const e = this.eye();
    if (mode === 'fly') {
      this.dist = 0.5;
      this.speed = Math.max(0.5, Math.min(50, sceneRadius / 20));
    } else this.dist = Math.max(1, sceneRadius * 0.5);
    const b = this.back();
    this.target = [e[0]! - this.dist * b[0]!, e[1]! - this.dist * b[1]!, e[2]! - this.dist * b[2]!];
    this.mode = mode;
  }
}
