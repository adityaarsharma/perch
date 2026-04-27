/**
 * specialists/index.ts — Side-effect import to register all specialists
 * with the orchestrator. Importing this module installs all six.
 */

import './performance.js';
import './security.js';
import './cleanup.js';
import './operations.js';
import './diagnostics.js';
import './plugins.js';

export { performanceSpecialist } from './performance.js';
export { securitySpecialist } from './security.js';
export { cleanupSpecialist } from './cleanup.js';
export { operationsSpecialist } from './operations.js';
export { diagnosticsSpecialist } from './diagnostics.js';
export { pluginsSpecialist } from './plugins.js';
