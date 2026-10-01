## toml-config-parser

A small, dependency-free TOML 1.0 subset parser that turns TOML text into typed
JavaScript objects (plain objects, arrays, numbers, strings, booleans, and
`Date` for datetimes).

### Usage

```js
import { parse } from './src/index.js';

const config = parse(`
[server]
host = "0.0.0.0"
port = 8080

[[users]]
name = "alice"
admin = true
`);

console.log(config.server.port);   // 8080
console.log(config.users[0].admin); // true
```

Exported names: `parse` (from `src/index.js`, re-exported from `src/core.js`).

### Why this exists

The problem: reading configuration in a sandboxed or offline environment where
`npm install` is unavailable. The trade-off: this library implements a
deliberate slice of TOML — bare/quoted/dotted keys, `[table]` and
`[[array-of-tables]]` headers, integers (decimal/hex/oct/bin with underscores),
floats, booleans, basic & literal strings (single- and multi-line), inline
tables, arrays with comments, and ISO 8601 datetimes. It does not implement
exotic TOML features such as local-time-only values as distinct types, custom
datetime precision control, or dotted-key expansion inside arrays of tables
beyond the common case.

### Awkward edge

Datetimes written without a timezone offset (e.g. `2020-01-01T00:00:00`) are
interpreted as **UTC**, not local time. This keeps output deterministic across
machines with different host timezones — if your config uses local times,
always include an offset.

Keys are case-sensitive, matching the TOML specification. `Server` and `server`
are distinct tables.
