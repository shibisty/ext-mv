// Все движки gmv. Подключайте нужные по отдельности (`gmv/engines/xray` и т. д.) или весь набор.
import type { EnginePlugin } from '../core/plugin';
import { coreEngine } from '../core/builtin';
import { xrayEngine } from './xray';
import { gamebryoEngine } from './gamebryo';
import { renderwareEngine } from './renderware';
import { hplEngine } from './hpl';
import { idtechEngine } from './idtech';
import { unrealEngine } from './unreal';
import { valveEngine } from './valve';
import { castEngine } from './cast';
import { eaEngine } from './ea';
import { cryengineEngine } from './cryengine';
import { beamngEngine } from './beamng';
import { armaEngine } from './arma';
import { rageEngine } from './rage';
import { spintiresEngine } from './spintires';
import { metroEngine } from './metro';
import { lithtechEngine } from './lithtech';
import { vostokEngine } from './vostok';
import { duniaEngine } from './dunia';
import { enfusionEngine } from './enfusion';
import { assimpEngine } from './assimp';

export { coreEngine, xrayEngine, gamebryoEngine, renderwareEngine, hplEngine, idtechEngine, unrealEngine, valveEngine, castEngine, eaEngine, cryengineEngine, beamngEngine, armaEngine, rageEngine, spintiresEngine, metroEngine, lithtechEngine, vostokEngine, duniaEngine, enfusionEngine, assimpEngine };

/** Порядок задаёт порядок пресетов в списке. */
export const allEngines: readonly EnginePlugin[] = [
  coreEngine, xrayEngine, gamebryoEngine, renderwareEngine, hplEngine, idtechEngine, unrealEngine, valveEngine, castEngine, eaEngine, cryengineEngine, beamngEngine, armaEngine, rageEngine, spintiresEngine, metroEngine, lithtechEngine, vostokEngine, duniaEngine, enfusionEngine, assimpEngine,
];
