// Сборка «всё в одном» для подключения через <script>: глобальный объект GMV.
//   <script src="gmv.iife.js"></script>
//   const v = await GMV.mount(canvas); await v.session.addFiles(input.files);
import { createRegistry, ViewerSession } from './index';
import { allEngines } from './engines/index';
import { ModelViewer, type ModelViewerOptions } from './renderer/index';

export * from './index';
export * from './engines/index';
export * from './renderer/index';
export { configureAssimp } from './engines/assimp/index';

/** Просмотрщик + сессия со всеми движками, связанные между собой. */
export function mount(canvas: HTMLCanvasElement, opts: ModelViewerOptions & { preset?: string } = {}) {
  const viewer = new ModelViewer(canvas, opts);
  const session = new ViewerSession(createRegistry(allEngines), opts.preset);
  const applyTextures = async () => {
    const m = session.model;
    if (!m) return;
    await Promise.all(m.meshes.map(async (_, i) => { const r = await session.resolveTexture(i); if (r.image) viewer.setTexture(i, r.image); }));
  };
  session.on('model', ({ model }) => { viewer.setModel(model); void applyTextures(); });
  session.on('textures', () => void applyTextures());
  viewer.start();
  return { viewer, session, applyTextures };
}
