// gmv — ядро просмотрщика игровых моделей: типы, реестр плагинов, автоопределение, архивы, кодеки, сессия.
// Движки подключаются отдельно: `import { allEngines } from 'gmv/engines'` или `import { xrayEngine } from 'gmv/engines/xray'`.
export * from './core/types';
export * from './core/plugin';
export { setLocale, getLocale, tr, presetText, engineTitle, exporterText, type Locale } from './core/i18n';
export { Registry, type Detection } from './core/registry';
export { ViewerSession, loadSameDirMotions, errMsg, type SessionEvents, type TextureResult, type NormalResult, type SurfaceResult, type ArchiveItem } from './core/session';
export { analyzeNormalMap, computeTangents, normalCandidates, type NormalPacking } from './core/normals';
export { composeSurface, surfaceCandidates, surfaceMaps } from './core/surface';
export { TextureLibrary, type TextureSource, type ImageDecoder } from './core/textures';
export { buildDiagnostics, hexDump, type DiagnosticsInput } from './core/diagnostics';
export { NodeSkeleton, type SkeletonNode } from './core/skeleton';
export { sceneTree, sceneLeaves, applyPlacement, rotatePlacement, translatePlacement, visibleIndices, instanceAt, pickRay, type SceneNode, type RayHit } from './core/scene';
export { coreEngine } from './core/builtin';
export { createArchive, readRange, TEXTURE_RE, type ArchiveSpec } from './core/archives/common';
export { openFolder } from './core/archives/folder';
export { openZip } from './core/archives/zip';
export { inflateZlib, inflateRaw } from './core/codecs/zlib';
export { lz4Block, lz4Frame } from './core/codecs/lz4';
export { decodeDDS, decodeDXT, type DxtKind } from './core/images/dds';
export { encodeDdsRgba } from './core/writers/dds';
export { writeZip, crc32 } from './core/writers/zip';
export { decodeTGA } from './core/images/tga';
export { decodePCX } from './core/images/pcx';
export * as math from './core/math';
export * as geometry from './core/geometry';
export * as binary from './core/binary';

import { Registry } from './core/registry';
import { coreEngine } from './core/builtin';
import type { EnginePlugin } from './core/plugin';

/** Реестр с встроенным ядром и переданными движками. */
export function createRegistry(engines: readonly EnginePlugin[] = []): Registry {
  return new Registry([coreEngine, ...engines.filter((e) => e.id !== 'core')]);
}
