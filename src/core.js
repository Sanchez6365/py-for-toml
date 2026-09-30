/**
 * TOML Config Parser core.
 *
 * Scope: a deliberately SMALL slice of TOML 1.0 sufficient for typical config
 * files. Supported: bare keys, dotted keys, table headers ([a.b.c]), arrays of
 * tables ([[a.b]]), integers (incl. underscores, hex/oct/bin), floats, booleans,
 * datetimes (basic ISO 8601, returned as JS Date), strings (basic + multi-line
 * literal/basic), inline tables, and arrays. Comments and blank lines are
 * honoured.
 *
 * WHY a hand-written recursive-descent parser instead of a full grammar table:
 * the brief forbids third-party deps and a from-scratch parser generator would
 * balloon the surface. Hand-rolling keeps the dep set to zero and lets us fail
 * fast with precise errors on the subset we actually support.
 *
 * Ambiguity resolved (stated plainly in README): keys are NOT case-insensitive
 * (TOML keys are case-sensitive by spec). Strings preserve their exact bytes.
 * Datetimes WITHOUT a timezone offset are interpreted as UTC (not local), so
 * output is deterministic across machines — a local interpretation would make
 * test results depend on the host TZ, which the brief explicitly forbids.
 */

/**
 * Parse a TOML string into a typed JavaScript object.
 * @param {string} src TOML source text.
 * @returns {object} Root object. Tables become plain objects; arrays of tables
 *   become arrays of objects; datetimes become `Date`.
 * @throws {Error} On the first syntax error encountered, with 1-based line.
 */
export function parse(src) {
  return new Parser(src).parse();
}

class Parser {
  /**
   * @param {string} src
   */
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.root = {};
    /** Current "pointer" into root for table/array-of-table insertion. */
    this.current = this.root;
    /** Stack of headers processed, to validate [a.b] after [a] when [a] is an AoT. */
    this.currentTablePath = [];
  }

  parse() {
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === '\n') { this.consumeNewline(); continue; }
      if (ch === ' ' || ch === '\t' || ch === '\r') { this.advance(); continue; }
      if (ch === '#') { this.skipComment(); continue; }
      if (ch === '[') {
        this.parseHeader();
        continue;
      }
      this.parseKeyValue();
    }
    return this.root;
  }

  // ---------- low-level helpers ----------

  atEnd() { return this.pos >= this.src.length; }

  peek(offset = 0) {
    const p = this.pos + offset;
    return p < this.src.length ? this.src[p] : '';
  }

  advance() {
    const ch = this.src[this.pos];
    if (ch === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    this.pos++;
    return ch;
  }

  consumeNewline() {
    if (this.peek() === '\r') this.advance();
    if (this.peek() === '\n') this.advance();
  }

  /**
   * Error with line/col context. Centralised so every throw looks the same.
   */
  fail(msg) {
    throw new Error(`TOML parse error at line ${this.line}, column ${this.col}: ${msg}`);
  }

  // ---------- whitespace / comments ----------

  skipInlineWhitespace() {
    while (this.peek() === ' ' || this.peek() === '\t' || this.peek() === '\r') this.advance();
  }

  skipComment() {
    while (!this.atEnd() && this.peek() !== '\n') this.advance();
  }

  /**
   * Expect rest-of-line to be empty (whitespace/comment) then consume the newline.
   * After a key/value and after a header we enforce that the line ends cleanly,
   * so `a = 1 b` is rejected rather than silently producing `a = 1`.
   */
  expectLineEndOrEnd() {
    this.skipInlineWhitespace();
    if (this.peek() === '#') this.skipComment();
    if (this.atEnd()) return;
    if (this.peek() === '\n') { this.consumeNewline(); return; }
    this.fail(`expected end of line, got ${JSON.stringify(this.peek())}`);
  }

  // ---------- headers ----------

  parseHeader() {
    const isAot = this.peek(1) === '[';
    // consume opening brackets
    this.advance();
    if (isAot) this.advance();
    this.skipInlineWhitespace();
    const parts = this.parseKeyPath();
    this.skipInlineWhitespace();
    if (this.peek() !== ']') this.fail(`expected ]`);
    this.advance();
    if (isAot) {
      if (this.peek() !== ']') this.fail(`expected ]] for array of tables`);
      this.advance();
    }
    this.currentTablePath = parts.slice();
    this.current = this.descendToTable(this.root, parts, isAot);
    this.expectLineEndOrEnd();
  }

  /**
   * Walk `parts` from `root`, creating intermediate tables as needed. If `isAot`,
   * the final part is treated as an array-of-tables and we append a fresh table.
   */
  descendToTable(root, parts, isAot) {
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      const existing = node[part];
      if (last && isAot) {
        if (!Array.isArray(existing)) {
          if (existing !== undefined) this.fail(`key ${JSON.stringify(part)} is not an array of tables`);
          node[part] = [];
        }
        const tbl = {};
        node[part].push(tbl);
        return tbl;
      }
      if (existing === undefined) {
        node[part] = {};
        node = node[part];
      } else if (Array.isArray(existing)) {
        // AoT intermediate: continue from the last appended table.
        node = existing[existing.length - 1];
      } else if (typeof existing === 'object' && existing !== null) {
        node = existing;
      } else {
        this.fail(`cannot redefine key ${JSON.stringify(part)} as a table`);
      }
    }
    return node;
  }

  /**
   * Parse a dotted key path: `a.b.c` or `"quoted".bare`. Returns string[].
   * Keys may be quoted to contain spaces/symbols.
   */
  parseKeyPath() {
    const parts = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      parts.push(this.parseKeyPart());
      this.skipInlineWhitespace();
      if (this.peek() === '.') {
        this.advance();
        this.skipInlineWhitespace();
        continue;
      }
      break;
    }
    return parts;
  }

  parseKeyPart() {
    const ch = this.peek();
    if (ch === '"') return this.parseBasicString();
    if (ch === "'") return this.parseLiteralString();
    // bare key: [A-Za-z0-9_-]+
    let key = '';
    while (true) {
      const c = this.peek();
      if (c === '' || !/[A-Za-z0-9_-]/.test(c)) break;
      key += c;
      this.advance();
    }
    if (key === '') this.fail('expected a key');
    return key;
  }

  // ---------- key/value ----------

  parseKeyValue() {
    const keyParts = this.parseKeyPath();
    this.skipInlineWhitespace();
    if (this.peek() !== '=') this.fail(`expected = after key`);
    this.advance();
    this.skipInlineWhitespace();
    const value = this.parseValue();
    this.assignDotted(this.current, keyParts, value);
    this.expectLineEndOrEnd();
  }

  /**
   * Assign `value` at `obj[a][b]...` creating intermediate plain objects.
   * Intermediate keys that already hold an AoT continue into its last element,
   * matching how dotted-key assignment interacts with [[arrays]].
   */
  assignDotted(obj, parts, value) {
    let node = obj;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        if (node[part] !== undefined) this.fail(`duplicate key ${JSON.stringify(part)}`);
        node[part] = value;
        return;
      }
      const existing = node[part];
      if (existing === undefined) {
        node[part] = {};
        node = node[part];
      } else if (Array.isArray(existing)) {
        node = existing[existing.length - 1];
      } else if (typeof existing === 'object' && existing !== null) {
        node = existing;
      } else {
        this.fail(`cannot redefine key ${JSON.stringify(part)}`);
      }
    }
  }

  // ---------- values ----------

  parseValue() {
    const ch = this.peek();
    if (ch === '"') return this.parseBasicString();
    if (ch === "'") return this.parseLiteralString();
    if (ch === '[') return this.parseArray();
    if (ch === '{') return this.parseInlineTable();
    if (ch === 't' || ch === 'f') return this.parseBoolean();
    // datetimes and numbers both start with a digit, '+', or '-'.
    return this.parseNumberOrDate();
  }

  parseBoolean() {
    if (this.src.startsWith('true', this.pos)) {
      this.advanceN(4);
      return true;
    }
    if (this.src.startsWith('false', this.pos)) {
      this.advanceN(5);
      return false;
    }
    this.fail('expected true or false');
  }

  advanceN(n) { for (let i = 0; i < n; i++) this.advance(); }

  /**
   * Numbers vs datetimes are disambiguated structurally: a valid TOML datetime
   * contains a date separator `-` in the YYYY-MM-DD position (4 digits, dash, 2
   * digits) or contains `:` (time). Anything else is numeric.
   * This is faster and more predictable than regex backtracking across both.
   */
  parseNumberOrDate() {
    const token = this.readBareToken();
    if (token.includes(':') || /^\d{4}-\d{2}-\d{2}/.test(token)) {
      return this.parseDateTime(token);
    }
    return this.parseNumber(token);
  }

  /**
   * Read the contiguous run of characters that could form a number or datetime:
   * digits, signs, dots, underscores, exponent markers, hex/oct/bin prefixes,
   * colons, dashes, 'T', 'Z', '+'/'-'. Stops at whitespace, newline, brackets,
   * braces, commas, and '#'.
   */
  readBareToken() {
    let start = this.pos;
    const stop = new Set([' ', '\t', '\r', '\n', ',', ']', '}', '#', '"', "'"]);
    while (!this.atEnd()) {
      const c = this.peek();
      if (stop.has(c)) break;
      this.advance();
    }
    return this.src.slice(start, this.pos);
  }

  parseNumber(token) {
    if (/^[+-]?0x[0-9A-Fa-f_]+$/.test(token)) return parseInt(token.replace(/_/g, ''), 16);
    if (/^[+-]?0o[0-7_]+$/.test(token)) return parseInt(token.replace(/_/g, '').replace('0o', '0'), 8);
    if (/^[+-]?0b[01_]+$/.test(token)) return parseInt(token.replace(/_/g, '').replace('0b', '0'), 2);
    // float if it has a '.', 'e', or 'E' (after stripping sign).
    if (/^[+-]?[0-9_]+(\.[0-9_]+)?([eE][+-]?[0-9_]+)?$/.test(token)) {
      if (token.includes('.') || /[eE]/.test(token)) {
        return parseFloat(token.replace(/_/g, ''));
      }
      return parseInt(token.replace(/_/g, ''), 10);
    }
    if (/^[+-]?inf$/.test(token)) return token.startsWith('-') ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(token)) return NaN;
    this.fail(`invalid number ${JSON.stringify(token)}`);
  }

  /**
   * Parse an ISO 8601 datetime token. Naive datetimes (no offset) are forced to
   * UTC via `Z` so the returned Date is deterministic across host timezones —
   * interpreting them as local would make behaviour host-dependent.
   * @param {string} token
   * @returns {Date}
   */
  parseDateTime(token) {
    let normalised = token.replace(' ', 'T');
    // Date-only: add a zero time so Date parses it as midnight UTC.
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalised)) normalised += 'T00:00:00Z';
    // Time-only: prepend epoch date.
    if (/^\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(normalised)) normalised = '1970-01-01T' + normalised + 'Z';
    // Full datetime without offset: assume UTC.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(normalised)) normalised += 'Z';
    const d = new Date(normalised);
    if (isNaN(d.getTime())) this.fail(`invalid datetime ${JSON.stringify(token)}`);
    return d;
  }

  // ---------- strings ----------

  /**
   * Basic string: "..." with backslash escapes. Multi-line if opened with """.
   */
  parseBasicString() {
    if (this.src.startsWith('"""', this.pos)) return this.parseMultilineBasicString();
    this.advance(); // opening quote
    let out = '';
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === '"') { this.advance(); return out; }
      if (ch === '\n') this.fail('unterminated basic string');
      if (ch === '\\') { out += this.parseEscape(); continue; }
      out += ch;
      this.advance();
    }
    this.fail('unterminated basic string');
  }

  parseMultilineBasicString() {
    this.advanceN(3);
    // Trim immediate newline after opening quotes (TOML rule).
    if (this.peek() === '\r') this.advance();
    if (this.peek() === '\n') this.advance();
    let out = '';
    while (!this.atEnd()) {
      if (this.src.startsWith('"""', this.pos)) {
        // allow up to two trailing quotes before the closing triple.
        let extra = 0;
        while (this.peek(3 + extra) === '"' && extra < 2) extra++;
        out += '"'.repeat(extra);
        this.advanceN(3 + extra);
        return out;
      }
      const ch = this.peek();
      if (ch === '\\') {
        // Line-ending backslash trims following whitespace/newlines.
        const next = this.peek(1);
        if (next === '\n' || next === '\r' || next === ' ' || next === '\t') {
          this.advance();
          while (this.peek() === ' ' || this.peek() === '\t' || this.peek() === '\r' || this.peek() === '\n') this.advance();
          continue;
        }
        out += this.parseEscape();
        continue;
      }
      out += ch;
      this.advance();
    }
    this.fail('unterminated multiline basic string');
  }

  /**
   * Literal string: '...' verbatim, no escapes. Multi-line if opened with '''.
   */
  parseLiteralString() {
    if (this.src.startsWith("'''", this.pos)) return this.parseMultilineLiteralString();
    this.advance();
    let out = '';
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === "'") { this.advance(); return out; }
      if (ch === '\n') this.fail('unterminated literal string');
      out += ch;
      this.advance();
    }
    this.fail('unterminated literal string');
  }

  parseMultilineLiteralString() {
    this.advanceN(3);
    if (this.peek() === '\r') this.advance();
    if (this.peek() === '\n') this.advance();
    let out = '';
    while (!this.atEnd()) {
      if (this.src.startsWith("'''", this.pos)) {
        let extra = 0;
        while (this.peek(3 + extra) === "'" && extra < 2) extra++;
        out += "'".repeat(extra);
        this.advanceN(3 + extra);
        return out;
      }
      out += this.peek();
      this.advance();
    }
    this.fail('unterminated multiline literal string');
  }

  /**
   * Process a single backslash escape sequence starting at the current position
   * (which must point at '\'). Returns the decoded string.
   */
  parseEscape() {
    this.advance(); // backslash
    const ch = this.peek();
    if (ch === 'u') return this.parseUnicodeEscape(4);
    if (ch === 'U') return this.parseUnicodeEscape(8);
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
    if (Object.prototype.hasOwnProperty.call(simple, ch)) {
      this.advance();
      return simple[ch];
    }
    this.fail(`invalid escape \\${ch}`);
  }

  parseUnicodeEscape(len) {
    this.advance(); // 'u' or 'U'
    let hex = '';
    for (let i = 0; i < len; i++) {
      const c = this.peek();
      if (!/[0-9A-Fa-f]/.test(c)) this.fail('invalid unicode escape');
      hex += c;
      this.advance();
    }
    return String.fromCodePoint(parseInt(hex, 16));
  }

  // ---------- arrays ----------

  /**
   * Arrays may span multiple lines, contain comments, and hold mixed types.
   */
  parseArray() {
    this.advance(); // [
    const arr = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.skipArrayWhitespace();
      if (this.peek() === ']') { this.advance(); return arr; }
      if (this.atEnd()) this.fail('unterminated array');
      arr.push(this.parseValue());
      this.skipArrayWhitespace();
      const ch = this.peek();
      if (ch === ',') { this.advance(); continue; }
      if (ch === ']') { this.advance(); return arr; }
      this.fail(`expected , or ] in array, got ${JSON.stringify(ch)}`);
    }
  }

  /**
   * Whitespace inside arrays includes newlines and full-line comments, which is
   * the only place TOML permits comments to span content.
   */
  skipArrayWhitespace() {
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { this.advance(); continue; }
      if (ch === '#') { this.skipComment(); continue; }
      break;
    }
  }

  // ---------- inline tables ----------

  /**
   * Inline table: `{ a = 1, b = 2 }`. Single line per spec; no trailing commas.
   */
  parseInlineTable() {
    this.advance(); // {
    const obj = {};
    this.skipInlineWhitespace();
    if (this.peek() === '}') { this.advance(); return obj; }
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.skipInlineWhitespace();
      const keyParts = this.parseKeyPath();
      this.skipInlineWhitespace();
      if (this.peek() !== '=') this.fail('expected = in inline table');
      this.advance();
      this.skipInlineWhitespace();
      const value = this.parseValue();
      this.assignDotted(obj, keyParts, value);
      this.skipInlineWhitespace();
      const ch = this.peek();
      if (ch === ',') { this.advance(); continue; }
      if (ch === '}') { this.advance(); return obj; }
      this.fail(`expected , or } in inline table, got ${JSON.stringify(ch)}`);
    }
  }
}
