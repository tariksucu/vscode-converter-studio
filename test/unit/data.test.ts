import * as assert from 'node:assert/strict';
import {
  convertData,
  csvSeparator,
  csvToJson,
  jsonToCsv,
  jsonToYaml,
  parseCsv,
} from '../../src/data';
import { ConverterStudioError } from '../../src/errors';

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
