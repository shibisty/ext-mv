import { describe, expect, it } from 'vitest';
import { OrbitCamera } from '../src/renderer/camera';

const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 5));

describe('камера: орбита и свободный полёт', () => {
  it('переключение в полёт не сдвигает глаз; скорость — по размеру сцены', () => {
    const c = new OrbitCamera();
    c.target = [1, 2, 3]; c.dist = 10; c.yaw = 0.7; c.pitch = 0.3;
    const e = c.eye();
    c.setMode('fly', 400);
    near(c.eye(), e);
    expect(c.dist).toBe(0.5);
    expect(c.speed).toBe(20);
    c.setMode('orbit', 400);
    near(c.eye(), e);
  });

  it('полёт: W — туда, куда смотрим; D — вправо по горизонтали; E — вверх по Y; поворот головы на месте', () => {
    const c = new OrbitCamera();
    c.setMode('fly', 100);
    c.yaw = Math.PI; c.pitch = 0; c.target = [0, 0, 0]; c.speed = 2;
    const e0 = c.eye(); // yaw = π: глаз на −Z от цели, взгляд вдоль +Z
    c.move(1, 0, 0, 0.5);
    near(c.eye(), [e0[0]!, e0[1]!, e0[2]! + 1]);
    c.move(0, 1, 0, 0.5);
    near(c.eye(), [e0[0]! - 1, e0[1]!, e0[2]! + 1]); // вправо при взгляде вдоль +Z (Y вверх, правая система GL) — это −X
    c.move(0, 0, 1, 1);
    expect(c.eye()[1]).toBeCloseTo(e0[1]! + 2);
    const e1 = c.eye();
    c.rotate(120, -40);
    near(c.eye(), e1);
    c.zoom(0.5); // колесо от себя — быстрее
    expect(c.speed).toBe(4);
  });
});
