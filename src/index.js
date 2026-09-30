/**
 * TOML Config Parser — ESM entrypoint.
 *
 * Re-exports the parser implementation from ./core.js so that consumers can
 * import a single, stable surface (`import { parse } from 'toml-config-parser'`).
 * Keeping the entry thin makes it trivial to swap implementations behind the
 * same public API during refactors.
 */
export { parse } from './core.js';
