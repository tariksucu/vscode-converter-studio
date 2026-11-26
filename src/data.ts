import { ConverterStudioError } from './errors';

/**
 * The extension's own data conversions, in plain TypeScript: JSON to CSV and YAML, CSV to JSON.
 * They run in the editor itself, with no tool and no network.
 *
 * Nothing is dropped or changed on the way: every column gets a name of its own, numbers keep the
 * digits they were written with (9007199254740993 stays exact), and keys keep their order. The
 * Converter Studio plugins for JetBrains IDEs, Sublime Text and Neovim follow the same rules and
 * run the same cases (`test/unit/data-cases.json`), so a file gives the same result in each.
 */

const invalid = (message: string) => new ConverterStudioError('invalidData', message);

// --- CSV ---------------------------------------------------------------------------------------

export type CsvSeparator = ',' | ';' | '\t' | '|';

/**
 * The field separator of a CSV: comma, semicolon, tab or `|`, whichever its first line uses most
 * outside quotes (the earlier of them on a tie; a comma when there is none).
 */
export function csvSeparator(text: string): CsvSeparator {
  const counts: Record<CsvSeparator, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let quoted = false;
  for (const char of text.replace(/^\uFEFF/, '').replace(/^[\r\n]+/, '')) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char as CsvSeparator]++;
  }
  let best: CsvSeparator = ',';
  for (const separator of [';', '\t', '|'] as const)
    if (counts[separator] > counts[best]) best = separator;
  return best;
}

/** The rows of a CSV (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes). */
export function parseCsv(text: string, separator: string = csvSeparator(text)): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (char === '"' && field === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (char === separator) {
      row.push(field);
      field = '';
      wasQuoted = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      wasQuoted = false;
    } else field += char;
  }
  if (quoted) throw invalid('The CSV ends inside a quoted field.');
  if (field !== '' || wasQuoted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines are not records.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Spaces, tabs and line breaks around a header name are not part of it. */
const trimName = (name: string) => name.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

/**
 * A name for each of `width` columns, every one different, so that no value is lost:
 * - the first column with a header name keeps it;
 * - any other column (a repeated name, an empty header cell, a cell beyond the header) gets its
 *   header name, or `column<N>` (N counted from 1) when it has none, followed by `_2`, `_3`...:
 *   the first that no column has taken yet.
 * `id,id` gives `id`, `id_2`; a header `column2` with a row `A,B` gives `column2`, `column2_2`.
 */
export function columnNames(header: readonly string[], width: number): string[] {
  const names: Array<string | undefined> = new Array<string | undefined>(width);
  const taken = new Set<string>();
  header.forEach((raw, index) => {
    const name = trimName(raw);
    if (name !== '' && !taken.has(name)) {
      names[index] = name;
      taken.add(name);
    }
  });
  for (let index = 0; index < width; index++) {
    if (names[index] !== undefined) continue;
    const base = trimName(header[index] ?? '') || `column${index + 1}`;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    names[index] = name;
    taken.add(name);
  }
  return names as string[];
}

/**
 * A CSV as JSON: an array of objects named by the header row, the values as text. Every object
 * has every column, in the file's order; a cell a row does not have is empty.
 */
export function csvToJson(text: string): string {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw invalid('The CSV is empty.');
  if (rows.length === 0) return '[]\n';
  let width = header.length;
  for (const row of rows) width = Math.max(width, row.length);
  // Written by hand: a JavaScript object would put keys such as "1" first and drop "__proto__".
  const keys = columnNames(header, width).map((name) => JSON.stringify(name));
  const records = rows.map(
    (row) =>
      `  {\n${keys.map((key, index) => `    ${key}: ${JSON.stringify(row[index] ?? '')}`).join(',\n')}\n  }`,
  );
  return `[\n${records.join(',\n')}\n]\n`;
}

// --- JSON --------------------------------------------------------------------------------------

/** A JSON number as the file writes it: its text is kept, so no digit is lost or changed. */
export class JsonNumber {
  constructor(readonly text: string) {}
}

/** JSON as the data conversions read it: objects are Maps (keys in the file's order). */
export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonObject;
export type JsonObject = Map<string, JsonValue>;

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_DEPTH = 512;

/**
 * Reads JSON without JavaScript's number type, which rounds integers beyond 2^53
 * (9007199254740993 would become 9007199254740992) and long decimals.
 */
export function parseJson(text: string): JsonValue {
  const source = text.replace(/^\uFEFF/, '');
  let at = 0;

  const fail = (reason: string): never => {
    const before = source.slice(0, at);
    const line = before.split('\n').length;
    const column = at - before.lastIndexOf('\n');
    throw invalid(`The file is not valid JSON: ${reason} at line ${line}, column ${column}.`);
  };

  const space = () => {
    for (;;) {
      const c = source.charCodeAt(at);
      if (c === 32 || c === 9 || c === 10 || c === 13) at++;
      else return;
    }
  };

  const string = (): string => {
    const start = at;
    let escaped = false;
    at++;
    for (;;) {
      const c = source.charCodeAt(at);
      if (Number.isNaN(c)) {
        at = start;
        return fail('a string that does not end');
      }
      if (c === 34) break;
      if (c === 92) {
        escaped = true;
        at += 2;
      } else if (c < 32) return fail('a line break or control character inside a string');
      else at++;
    }
    at++;
    const raw = source.slice(start, at);
    if (!escaped) return raw.slice(1, -1);
    try {
      // JavaScript's own reader decodes the escapes (\n, \u00e9, surrogate pairs).
      return JSON.parse(raw) as string;
    } catch {
      at = start;
      return fail('a bad escape in a string');
    }
  };

  const value = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) fail('values nested too deeply');
    space();
    const c = source[at];
    if (c === '{') {
      at++;
      const object: JsonObject = new Map();
      space();
      if (source[at] === '}') {
        at++;
        return object;
      }
      for (;;) {
        space();
        if (source[at] !== '"') fail('a key in double quotes was expected');
        const key = string();
        space();
        if (source[at] !== ':') fail('":" was expected');
        at++;
        // A key written twice keeps its first place and its last value.
        object.set(key, value(depth + 1));
        space();
        if (source[at] === '}') {
          at++;
          return object;
        }
        if (source[at] !== ',') fail('"," or "}" was expected');
        at++;
      }
    }
    if (c === '[') {
      at++;
      const array: JsonValue[] = [];
      space();
      if (source[at] === ']') {
        at++;
        return array;
      }
      for (;;) {
        array.push(value(depth + 1));
        space();
        if (source[at] === ']') {
          at++;
          return array;
        }
        if (source[at] !== ',') fail('"," or "]" was expected');
        at++;
      }
    }
    if (c === '"') return string();
    for (const [word, literal] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const)
      if (source.startsWith(word, at)) {
        at += word.length;
        return literal;
      }
    JSON_NUMBER.lastIndex = at;
    const number = JSON_NUMBER.exec(source);
    if (number) {
      at += number[0].length;
      return new JsonNumber(number[0]);
    }
    return fail(c === undefined ? 'the file ends too soon' : `unexpected "${c}"`);
  };

  const result = value(0);
  space();
  if (at < source.length) fail('unexpected text after the value');
  return result;
}

const isObject = (value: JsonValue | undefined): value is JsonObject => value instanceof Map;

/** A value as compact JSON (a list or object in a CSV cell), numbers as written. */
function compactJson(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof JsonNumber) return value.text;
  if (Array.isArray(value)) return `[${value.map(compactJson).join(',')}]`;
  const members: string[] = [];
  for (const [key, item] of value) members.push(`${JSON.stringify(key)}:${compactJson(item)}`);
  return `{${members.join(',')}}`;
}

function cellText(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (value instanceof JsonNumber) return value.text;
  return compactJson(value);
}

/** A CSV field, in double quotes when it holds a comma, a quote or a line break, or starts or ends with a space or tab. */
function csvField(text: string): string {
  return /[",\r\n]|^[ \t]|[ \t]$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * JSON as CSV: an array of objects becomes one row each, under the union of their keys (in the
 * order first seen); nested values are written as JSON. A single object is one row; an array of
 * plain values is one column named `value`. Numbers keep their digits.
 */
export function jsonToCsv(text: string): string {
  const data = parseJson(text);
  const rows: JsonValue[] = Array.isArray(data) ? data : [data];
  if (rows.length === 0) throw invalid('The JSON array is empty: there is nothing to write.');
  if (!rows.every(isObject)) {
    if (rows.some(isObject))
      throw invalid('CSV needs an array of objects (or of plain values), not a mix of both.');
    return `value\r\n${rows.map((value) => csvField(cellText(value))).join('\r\n')}\r\n`;
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows)
    for (const key of row.keys())
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows)
    lines.push(columns.map((column) => csvField(cellText(row.get(column)))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

// --- YAML --------------------------------------------------------------------------------------

/** Words YAML reads as something other than text. */
const YAML_WORDS = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
/**
 * What a YAML file must not hold as is: control characters, DEL and the C1 controls, the line
 * and paragraph separators, the byte order mark, U+FFFE and U+FFFF, and lone surrogates.
 */
const YAML_UNPRINTABLE =
  // eslint-disable-next-line no-control-regex -- control characters are what it looks for
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const YAML_QUOTED_ESCAPES = new RegExp(`[\\\\"]|${YAML_UNPRINTABLE.source}`, 'g');
/**
 * Text YAML reads back as the same text without quotes: it starts with a letter, `_`, `/` or a
 * character beyond ASCII, and goes on with letters, digits, spaces and `_ . / + ( ) @ -`.
 */
const YAML_PLAIN = /^[A-Za-z_/\u{a0}-\u{10ffff}][A-Za-z0-9 _./+()@\u{a0}-\u{10ffff}-]*$/u;
const YAML_NAMED: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** A string as YAML: plain when that reads back the same, else in double quotes. */
export function yamlString(value: string): string {
  const plain =
    YAML_PLAIN.test(value) &&
    !value.endsWith(' ') &&
    !YAML_WORDS.test(value) &&
    !YAML_UNPRINTABLE.test(value);
  if (plain) return value;
  const escaped = value.replace(
    YAML_QUOTED_ESCAPES,
    (c) => YAML_NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `"${escaped}"`;
}

function yamlScalar(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return yamlString(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof JsonNumber) return value.text;
  return Array.isArray(value) ? '[]' : '{}';
}

const isCollection = (value: JsonValue) =>
  (Array.isArray(value) && value.length > 0) || (isObject(value) && value.size > 0);

function yamlLines(value: JsonValue, indent: string): string[] {
  if (Array.isArray(value) && value.length > 0)
    return value.flatMap((item) => {
      if (!isCollection(item)) return [`${indent}- ${yamlScalar(item)}`];
      // The first line of the nested block goes after the dash (its indent cut off, nothing more).
      const inner = yamlLines(item, `${indent}  `);
      return [`${indent}- ${inner[0]!.slice(indent.length + 2)}`, ...inner.slice(1)];
    });
  if (isObject(value) && value.size > 0)
    return [...value].flatMap(([key, item]) => {
      if (isCollection(item))
        return [`${indent}${yamlString(key)}:`, ...yamlLines(item, `${indent}  `)];
      return [`${indent}${yamlString(key)}: ${yamlScalar(item)}`];
    });
  return [`${indent}${yamlScalar(value)}`];
}

/** JSON as YAML (block style; strings quoted only where YAML would read them differently). */
export function jsonToYaml(text: string): string {
  return `${yamlLines(parseJson(text), '').join('\n')}\n`;
}

/** Runs one of the data conversions. */
export function convertData(from: string, to: string, text: string): string {
  const pair = `${from}>${to}`;
  if (pair === 'json>csv') return jsonToCsv(text);
  if (pair === 'json>yaml') return jsonToYaml(text);
  if (pair === 'csv>json') return csvToJson(text);
  throw new ConverterStudioError(
    'noLocalConversion',
    `The extension does not convert ${from} to ${to} itself.`,
  );
}
