// Запись сцены уровня X-Ray SDK 0.7 (ЗП): <уровень>.level и <уровень>/scene_object.part (ini, CRLF, Windows-1251).
// Остальные части (свет, секторы, порталы, спавн, AI-сетка) добавляются в LevelEditor.

export interface SceneObjectOut {
  /** Имя экземпляра в сцене. */
  name: string;
  /** Путь объекта в rawdata/objects без расширения, например «gmv\\metro\\tunnel_01». */
  reference: string;
  position: number[];
  /** Углы, как в part-файле (см. sceneRotation), либо матрица поворота 3×3 (строки-векторы). */
  rotation?: number[];
  matrix?: number[];
  scale?: number[];
}
export interface SceneOut { name: string; objects: SceneObjectOut[]; owner?: string; camera?: { pos: number[]; hpb: number[] } }

/** Углы part-файла по матрице поворота (обратное к sceneRotation). */
export function sceneEuler(R: ArrayLike<number>): number[] {
  // sceneRotation = transpose(setHPB(y, x, z)) -> m = transpose(R)
  const m = [R[0]!, R[3]!, R[6]!, R[1]!, R[4]!, R[7]!, R[2]!, R[5]!, R[8]!];
  const p = Math.asin(Math.max(-1, Math.min(1, m[5]!)));
  let h: number, b: number;
  if (Math.abs(m[5]!) < 0.99999) { h = Math.atan2(-m[2]!, m[8]!); b = Math.atan2(-m[3]!, m[4]!); }
  else { h = 0; b = Math.atan2(m[1]!, m[0]!); } // вырожденный случай (тангаж ±90°)
  return [p, h, b];
}

const f6 = (v: number) => (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6);
const vec = (a: number[]) => a.map(f6).join(', ');

/** ini в стиле SDK: секции по алфавиту, ключи по алфавиту, «ключ = значение» с выравниванием, пустая строка из пробела. */
export function writeIni(sections: Record<string, Record<string, string>>): string {
  let s = '';
  for (const name of Object.keys(sections).sort()) {
    s += `[${name}]\r\n`;
    const sec = sections[name]!;
    for (const k of Object.keys(sec).sort()) { const v = sec[k]!; s += `        ${k.padEnd(33)}=${v === '' ? '' : ' ' + v}\r\n`; }
    s += ' \r\n';
  }
  return s;
}

function encode1251(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i] = c < 128 ? c : c >= 0x410 && c <= 0x44f ? c - 0x350 : c === 0x401 ? 0xa8 : c === 0x451 ? 0xb8 : 0x3f; }
  return out;
}

const rnd64 = () => { let v = 0n; for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(Math.floor(Math.random() * 256)); return v.toString(); };

/** Файлы сцены: путь (относительно rawdata/levels) -> байты. */
export function writeScene(sc: SceneOut): Map<string, Uint8Array> {
  const g0 = rnd64(), g1 = rnd64(), now = Math.floor(Date.now() / 1000);
  const objects: Record<string, Record<string, string>> = {};
  sc.objects.forEach((o, i) => {
    const rot = o.rotation ?? (o.matrix ? sceneEuler(o.matrix) : [0, 0, 0]);
    objects[`object_${i}`] = {
      clsid: '2', co_flags: '0', flags: '0', name: o.name, position: vec(o.position), reference_name: o.reference,
      rotation: vec(rot), scale: vec(o.scale ?? [1, 1, 1]), version: '18',
    };
  });
  const part = writeIni({
    appendrandom: { AppendRandomMaxRotation: vec([0, 0, 0]), AppendRandomMaxScale: vec([1, 1, 1]), AppendRandomMinRotation: vec([0, 0, 0]), AppendRandomMinScale: vec([1, 1, 1]), AppendRandomObjects_size: '0' },
    guid: { guid_g0: g0, guid_g1: g1 },
    main: { flags: '0', objects_count: String(sc.objects.length), version: '0' },
    modif: { name: '', time: '0' },
    ...objects,
  });
  // камера: над центром сцены
  let cam = sc.camera;
  if (!cam) {
    const c = [0, 0, 0];
    for (const o of sc.objects) for (let k = 0; k < 3; k++) c[k] += o.position[k]! / Math.max(1, sc.objects.length);
    cam = { pos: [c[0]!, c[1]! + 20, c[2]! - 30], hpb: [0, -0.5, 0] };
  }
  const level = writeIni({
    build_params: {
      light_jitter_samples: '9', light_pixel_per_meter: f6(20), light_quality: '2', light_quality_reserved: '29795', light_rms: '4', light_rms_zero: '4',
      reserved_0: f6(0), reserved_1: f6(0), reserved_2: f6(0), reserved_3: f6(0), reserved_4: f6(0), reserved_5: f6(0), smooth_angle: f6(75), weld_distance: f6(0.005),
    },
    camera: { hpb: vec(cam.hpb), pos: vec(cam.pos) },
    guid: { guid_g0: g0, guid_g1: g1 },
    level_options: {
      bop: '""', game_type: '1', level_path: sc.name, level_prefix: sc.name, light_hemi_quality: '3', light_sun_quality: '0', map_version: '1.0', version: '12', version_bp: '9',
    },
    level_tag: { create_time: String(now), owner: sc.owner ?? 'gmv' },
    version: { value: '5' },
  });
  return new Map([[`${sc.name}.level`, encode1251(level)], [`${sc.name}/scene_object.part`, encode1251(part)]]);
}
