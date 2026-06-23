// version.js -- single source of truth for the wizard version
// Reads from package.json so a version bump propagates everywhere.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;
