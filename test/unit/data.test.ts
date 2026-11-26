import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  JsonNumber,
  columnNames,
  convertData,
  csvSeparator,
  csvToJson,
  jsonToCsv,
  jsonToYaml,
  parseCsv,
  parseJson,
} from '../../src/data';
import { ConverterStudioError } from '../../src/errors';

interface DataCase {
  name: string;
  from: string;
  to: string;
  input: string;
  output?: string;
  error?: true;
}

/** The cases every editor plugin runs (the same file in the JetBrains, Sublime and Neovim ones). */
const shared = JSON.parse(
  readFileSync(join(__dirname, '../../../test/unit/data-cases.json'), 'utf8'),
) as { cases: DataCase[] };

describe('The data cases shared by the four editor plugins', () => {
  const pairs = new Set(['csv>json', 'json>csv', 'json>yaml']);
  for (const c of shared.cases.filter((c) => pairs.has(`${c.from}>${c.to}`)))
    it(`${c.from} to ${c.to}: ${c.name}`, () => {
      if (c.error)
        assert.throws(
          () => convertData(c.from, c.to, c.input),
          (error: ConverterStudioError) => error.code === 'invalidData',
        );
      else assert.equal(convertData(c.from, c.to, c.input), c.output);
    });
});

describe('CSV', () => {
  it('reads quoted fields, doubled quotes and line breaks inside quotes', () => {
    const rows = parseCsv(
      '\uFEFFname,note\r\nAda,"says ""hi"", twice"\r\nAlan,"two\nlines"\r\n\r\n',
    );
    assert.deepEqual(rows, [
      ['name', 'note'],
      ['Ada', 'says "hi", twice'],
      ['Alan', 'two\nlines'],
    ]);
  });

  it('finds the separator from the first line', () => {
    assert.equal(csvSeparator('a;b;c\n1,5;2;3'), ';');
    assert.equal(csvSeparator('a\tb\n'), '\t');
    assert.equal(csvSeparator('"a;b",c\n'), ',');
    assert.equal(csvSeparator('a|b|c\n1,5|2|3'), '|');
    assert.equal(csvSeparator('a,b;c\n'), ',', 'a tie goes to the comma');
    assert.equal(csvSeparator('\r\n\na;b\n'), ';', 'blank lines before the header are skipped');
  });

  it('gives every column a name of its own, generated names checked against all others', () => {
    assert.deepEqual(columnNames(['column2'], 2), ['column2', 'column2_2']);
    assert.deepEqual(columnNames(['id', 'id'], 2), ['id', 'id_2']);
    assert.deepEqual(columnNames(['id', 'id', 'id_2'], 3), ['id', 'id_3', 'id_2']);
    assert.deepEqual(columnNames(['', 'column1'], 2), ['column1_2', 'column1']);
    assert.deepEqual(columnNames([' a ', '\t'], 3), ['a', 'column2', 'column3']);
  });

  it('becomes JSON objects named by the header (duplicate and empty names kept apart)', () => {
    const json = JSON.parse(csvToJson('id;name;name;\n1;Ada;Lovelace;x\n2;Alan\n')) as unknown;
    assert.deepEqual(json, [
      { id: '1', name: 'Ada', name_2: 'Lovelace', column4: 'x' },
      { id: '2', name: 'Alan', name_2: '', column4: '' },
    ]);
  });

  it('refuses a quote that never ends', () => {
    assert.throws(
      () => parseCsv('a,"b\n1,2'),
      (error: ConverterStudioError) => error.code === 'invalidData',
    );
  });
});

describe('JSON to CSV', () => {
  it('writes the union of the keys, nested values as JSON, and quotes where needed', () => {
    const csv = jsonToCsv(
      JSON.stringify([
        { name: 'Ada', tags: ['math'], note: 'a, b' },
        { name: 'Alan', age: 41, note: 'say "hi"' },
      ]),
    );
    assert.equal(
      csv,
      'name,tags,note,age\r\nAda,"[""math""]","a, b",\r\nAlan,,"say ""hi""",41\r\n',
    );
  });

  it('writes one object as one row, plain values as one column', () => {
    assert.equal(jsonToCsv('{"a":1,"b":true}'), 'a,b\r\n1,true\r\n');
    assert.equal(jsonToCsv('[1,"two",null]'), 'value\r\n1\r\ntwo\r\n\r\n');
  });

  it('explains what it cannot write', () => {
    assert.throws(() => jsonToCsv('[]'), /empty/);
    assert.throws(() => jsonToCsv('[{"a":1}, 2]'), /not a mix/);
    assert.throws(
      () => jsonToCsv('{nope'),
      (error: ConverterStudioError) => error.code === 'invalidData',
    );
  });
});

describe('JSON', () => {
  it('keeps the text of numbers, the order of keys and keys such as __proto__', () => {
    const value = parseJson('{"n": 9007199254740993, "2": -0.10e+2, "__proto__": [1.0]}');
    assert.ok(value instanceof Map);
    assert.deepEqual([...value.keys()], ['n', '2', '__proto__']);
    assert.deepEqual(value.get('n'), new JsonNumber('9007199254740993'));
    assert.deepEqual(value.get('2'), new JsonNumber('-0.10e+2'));
    assert.deepEqual(value.get('__proto__'), [new JsonNumber('1.0')]);
  });

  it('reads escapes, and says where the JSON is broken', () => {
    assert.equal(parseJson('"\\u00e9\\ud83d\\ude00\\n\\"x"'), '\u00e9\ud83d\ude00\n"x');
    for (const [text, where] of [
      ['{\n  "a": tru\n}', 'line 2, column 8'],
      ['[1,]', 'line 1, column 4'],
      ['01', 'line 1, column 2'],
      ['"a\\x"', 'line 1, column 1'],
      ['"open', 'line 1, column 1'],
      ['[1] 2', 'line 1, column 5'],
    ])
      assert.throws(
        () => parseJson(text!),
        (error: ConverterStudioError) =>
          error.code === 'invalidData' && error.message.includes(where!),
        text,
      );
  });
});

describe('JSON to YAML', () => {
  it('writes block YAML, quoting only what YAML would read differently', () => {
    const yaml = jsonToYaml(
      JSON.stringify({
        name: 'converter',
        version: '1.0',
        enabled: true,
        word: 'yes',
        empty: '',
        colon: 'a: b',
        list: ['mp4', { to: 'mp3', bitrate: 192 }],
        nested: { deep: { value: null } },
        none: [],
        nothing: {},
        'key with: colon': 1,
        multi: 'two\nlines',
      }),
    );
    assert.equal(
      yaml,
      [
        'name: converter',
        'version: "1.0"',
        'enabled: true',
        'word: "yes"',
        'empty: ""',
        'colon: "a: b"',
        'list:',
        '  - mp4',
        '  - to: mp3',
        '    bitrate: 192',
        'nested:',
        '  deep:',
        '    value: null',
        'none: []',
        'nothing: {}',
        '"key with: colon": 1',
        'multi: "two\\nlines"',
        '',
      ].join('\n'),
    );
  });

  it('writes a top-level list and nested lists', () => {
    assert.equal(jsonToYaml('[[1,2],"a"]'), '- - 1\n  - 2\n- a\n');
  });
});

describe('convertData', () => {
  it('converts the three pairs and refuses others', () => {
    assert.equal(convertData('csv', 'json', 'a\n1\n'), '[\n  {\n    "a": "1"\n  }\n]\n');
    assert.throws(
      () => convertData('yaml', 'json', 'a: 1'),
      (error: ConverterStudioError) => error.code === 'noLocalConversion',
    );
  });
});
