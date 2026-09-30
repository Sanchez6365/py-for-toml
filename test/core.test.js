import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/core.js';

/**
 * Each test exercises a behaviour the implementation actually claims to support.
 * Datetimes are compared against fixed epoch ms (not host wall-clock) so runs
 * are deterministic regardless of the container's timezone.
 */

test('scalar integers and floats', () => {
  const out = parse('a = 1\nb = 2_500\nc = 3.14\nd = -5\n');
  assert.equal(out.a, 1);
  assert.equal(out.b, 2500);
  assert.equal(out.c, 3.14);
  assert.equal(out.d, -5);
});

test('booleans', () => {
  const out = parse('yes = true\nno = false\n');
  assert.equal(out.yes, true);
  assert.equal(out.no, false);
});

test('basic and literal strings', () => {
  const out = parse('basic = "hello\\nworld"\nliteral = \'C:\\disk\'\n');
  assert.equal(out.basic, 'hello\nworld');
  assert.equal(out.literal, 'C:\\disk');
});

test('multiline strings trim leading newline', () => {
  const src = 'm = """\nline1\nline2\n"""\n';
  const out = parse(src);
  assert.equal(out.m, 'line1\nline2\n');
});

test('multiline literal preserves internal quotes', () => {
  const src = "m = '''it's fine'''\n";
  const out = parse(src);
  assert.equal(out.m, "it's fine");
});

test('tables and dotted keys', () => {
  const out = parse('a.b.c = 1\n[a]\nx = 2\n');
  assert.deepEqual(out, { a: { b: { c: 1 }, x: 2 } });
});

test('array of tables', () => {
  const out = parse('[[items]]\nname = "x"\n[[items]]\nname = "y"\n');
  assert.deepEqual(out, { items: [{ name: 'x' }, { name: 'y' }] });
});

test('nested array of tables', () => {
  const out = parse('[[a.b]]\nv = 1\n[[a.b]]\nv = 2\n');
  assert.deepEqual(out, { a: { b: [{ v: 1 }, { v: 2 }] } });
});

test('inline table', () => {
  const out = parse('p = { x = 1, y = 2 }\n');
  assert.deepEqual(out, { p: { x: 1, y: 2 } });
});

test('array with mixed types and comments', () => {
  const src = 'arr = [\n  1, # one\n  "two",\n  true\n]\n';
  const out = parse(src);
  assert.deepEqual(out.arr, [1, 'two', true]);
});

test('hex, octal, and binary integers', () => {
  const out = parse('h = 0xff\no = 0o17\nb = 0b101\n');
  assert.equal(out.h, 255);
  assert.equal(out.o, 15);
  assert.equal(out.b, 5);
});

test('full datetime with offset yields fixed epoch ms', () => {
  const out = parse('t = 2020-01-01T00:00:00Z\n');
  assert.ok(out.t instanceof Date);
  assert.equal(out.t.getTime(), 1577836800000);
});

test('naive datetime is interpreted as UTC for determinism', () => {
  const out = parse('t = 2020-01-01T00:00:00\n');
  assert.equal(out.t.getTime(), 1577836800000);
});

test('date-only is midnight UTC', () => {
  const out = parse('d = 2020-01-01\n');
  assert.equal(out.d.getTime(), 1577836800000);
});

test('comments and blank lines are ignored', () => {
  const src = '# header\n\n  # indented comment\na = 1\n';
  const out = parse(src);
  assert.deepEqual(out, { a: 1 });
});

test('duplicate key throws', () => {
  assert.throws(() => parse('a = 1\na = 2\n'), /duplicate key/);
});

test('invalid escape throws with line context', () => {
  assert.throws(() => parse('a = "\\q"\n'), /invalid escape/);
});

test('unterminated basic string throws', () => {
  assert.throws(() => parse('a = "oops\n'), /unterminated basic string/);
});

test('trailing garbage after value throws', () => {
  assert.throws(() => parse('a = 1 b\n'), /expected end of line/);
});

test('quoted keys with spaces', () => {
  const out = parse('"my key" = 1\n');
  assert.equal(out['my key'], 1);
});

test('unicode escape', () => {
  const out = parse('s = "\\u00e9"\n');
  assert.equal(out.s, 'é');
});
