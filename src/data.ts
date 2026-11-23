import { ConverterStudioError } from './errors';

/**
 * The extension's own data conversions, in plain TypeScript: JSON to CSV and YAML, CSV to JSON.
 * They run in the editor itself, with no tool and no network.
 */

const invalid = (message: string) => new ConverterStudioError('invalidData', message);

/** The field separator of a CSV: comma, semicolon or tab, whichever its first line uses most. */
export function csvSeparator(text: string): ',' | ';' | '\t' {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of text.replace(/^\uFEFF/, '')) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char as keyof typeof counts]++;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

/** The rows of a CSV (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes). */
export function parseCsv(text: string, separator = csvSeparator(text)): string[][] {
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

/** A CSV as JSON: an array of objects named by the header row, the values as text. */
export function csvToJson(text: string): string {
  const rows = parseCsv(text);
  const header = rows.shift();
  if (!header) throw invalid('The CSV is empty.');
  const names: string[] = [];
  header.forEach((raw, index) => {
    let name = raw.trim() || `column${index + 1}`;
    for (let n = 2; names.includes(name); n++) name = `${raw.trim() || 'column'}_${n}`;
    names.push(name);
  });
  const records = rows.map((row) => {
    const record: Record<string, string> = {};
    names.forEach((name, index) => (record[name] = row[index] ?? ''));
    // Fields beyond the header keep their place.
    for (let index = names.length; index < row.length; index++)
      record[`column${index + 1}`] = row[index]!;
    return record;
  });
  return `${JSON.stringify(records, null, 2)}\n`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch (error) {
    throw invalid(
      `The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function csvField(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * JSON as CSV: an array of objects becomes one row each, under the union of their keys (in the
 * order first seen); nested values are written as JSON. A single object is one row; an array of
 * plain values is one column named `value`.
 */
export function jsonToCsv(text: string): string {
  const data = parseJson(text);
  const rows: unknown[] = Array.isArray(data) ? data : [data];
  if (rows.length === 0) throw invalid('The JSON array is empty: there is nothing to write.');
  if (!rows.every(isRecord)) {
    if (rows.some(isRecord))
      throw invalid('CSV needs an array of objects (or of plain values), not a mix of both.');
    return `value\r\n${rows.map((value) => csvField(value)).join('\r\n')}\r\n`;
  }
  const columns: string[] = [];
  for (const row of rows)
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) lines.push(columns.map((column) => csvField(row[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Words YAML reads as something other than text. */
const YAML_WORDS = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
const YAML_NUMBER = /^[-+]?(?:\.?\d|\.(?:inf|nan))/i;

/** A string as YAML: plain when that reads back the same, else in double quotes (JSON escapes). */
function yamlString(value: string): string {
  const plain =
    value !== '' &&
    /^[\p{L}\p{N}_/][\p{L}\p{N}_ ./()@+-]*$/u.test(value) &&
    !/\s$/.test(value) &&
    !YAML_WORDS.test(value) &&
    !YAML_NUMBER.test(value);
  return plain ? value : JSON.stringify(value);
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return yamlString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function yamlLines(value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return ['[]'];
    return value.flatMap((item) => {
      const inner = yamlLines(item, `${indent}  `);
      if (isCollection(item)) return [`${indent}- ${inner[0]!.trimStart()}`, ...inner.slice(1)];
      return [`${indent}- ${inner[0]}`];
    });
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return ['{}'];
    return keys.flatMap((key) => {
      const item = value[key];
      if (isCollection(item))
        return [`${indent}${yamlString(key)}:`, ...yamlLines(item, `${indent}  `)];
      return [`${indent}${yamlString(key)}: ${yamlLines(item, `${indent}  `)[0]}`];
    });
  }
  return [yamlScalar(value)];
}

const isCollection = (value: unknown) =>
  (Array.isArray(value) && value.length > 0) || (isRecord(value) && Object.keys(value).length > 0);

/** JSON as YAML (block style; strings quoted only where YAML would read them differently). */
export function jsonToYaml(text: string): string {
  const data = parseJson(text);
  return `${yamlLines(data, '').join('\n')}\n`;
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
