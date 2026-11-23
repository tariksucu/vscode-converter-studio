import * as assert from 'node:assert/strict';
import type { Target } from '../../src/formats';
import { firstRow, pickerRows, type PickerInput } from '../../src/picker';
import type { LocalTarget } from '../../src/recipes';

const local: LocalTarget[] = [
  { to: 'webp', variant: null, label: 'WebP', engine: 'ImageMagick', files: [0, 1] },
  {
    to: 'txt',
    variant: 'ocr',
    label: 'Text, recognizing the words (OCR)',
    engine: 'Tesseract',
    files: [0],
    options: { ocr: true },
  },
];
const cloud: Target[] = [
  {
    to: 'webp',
    label: 'WebP',
    description: 'smaller images for the web',
    files: [0, 1],
    suggested: true,
  },
  { to: 'heic', label: 'HEIC', files: [1], suggested: false },
];
const input = (fields: Partial<PickerInput>): PickerInput => ({
  total: 2,
  local,
  desktop: null,
  cloud,
  trusted: true,
  remote: false,
  toolsFound: ['ImageMagick', 'Tesseract'],
  ...fields,
});

describe('pickerRows', () => {
  it('lists this computer first and starts there; each target says where it runs', () => {
    const rows = pickerRows(input({}));
    assert.equal(rows[0]!.label, 'On this computer: nothing is uploaded');
    const start = rows[firstRow(rows)]!;
    assert.equal(start.choice?.where, 'local');
    assert.equal(start.choice?.to, 'webp');
    assert.match(start.description ?? '', /on this computer · ImageMagick/);
    const ocr = rows.find((row) => row.choice?.variant === 'ocr')!;
    assert.match(ocr.description ?? '', /1 of 2 files/);
    for (const row of rows.filter((r) => r.choice?.where === 'cloud'))
      assert.match(row.description ?? '', /in the cloud: uploads, uses credits/);
    const cloudHeader = rows.find(
      (row) => row.kind === 'separator' && row.label.startsWith('In the cloud'),
    )!;
    assert.equal(cloudHeader.label, 'In the cloud: uploads to converter.studio, uses credits');
    assert.ok(rows.indexOf(cloudHeader) > rows.indexOf(ocr));
  });

  it('never starts on a cloud conversion, even with nothing on this computer', () => {
    const rows = pickerRows(input({ local: [] }));
    const start = rows[firstRow(rows)]!;
    assert.equal(start.kind, 'action');
    assert.equal(start.action, 'showTools');
    const untrusted = pickerRows(input({ local: [], trusted: false }));
    assert.equal(untrusted[firstRow(untrusted)]!.action, 'manageTrust');
    assert.match(untrusted[firstRow(untrusted)]!.label, /Restricted Mode/);
  });

  it('shows the desktop app only when it is turned on', () => {
    assert.ok(!pickerRows(input({})).some((row) => row.choice?.where === 'desktop'));
    const rows = pickerRows(
      input({ desktop: [{ to: 'jpg', label: 'JPG', files: [0, 1], suggested: false }] }),
    );
    const desktop = rows.find((row) => row.choice?.where === 'desktop')!;
    assert.match(desktop.description ?? '', /in the desktop app/);
    assert.ok(
      rows.some((row) => row.label === 'Converter Studio for desktop: you press Convert there'),
    );
  });

  it('says when the cloud is loading, failed or off', () => {
    assert.ok(
      pickerRows(input({ cloud: 'loading' })).some((row) => /Reading the formats/.test(row.label)),
    );
    assert.ok(
      pickerRows(input({ cloud: 'failed' })).some((row) => /could not be read/.test(row.label)),
    );
    const off = pickerRows(input({ cloud: null }));
    assert.ok(!off.some((row) => /cloud/i.test(row.label) || row.choice?.where === 'cloud'));
  });

  it('carries the cloud’s OCR suggestion as OCR', () => {
    const rows = pickerRows(
      input({
        cloud: [{ to: 'txt', label: 'Text', options: { ocr: true }, files: [0], suggested: true }],
      }),
    );
    const row = rows.find((r) => r.choice?.where === 'cloud')!;
    assert.equal(row.choice?.variant, 'ocr');
    assert.deepEqual(row.choice?.options, { ocr: true });
  });

  it('names the remote machine in a remote window', () => {
    const rows = pickerRows(input({ remote: true }));
    assert.equal(rows[0]!.label, 'On the remote machine: nothing is uploaded');
    assert.match(rows[firstRow(rows)]!.description ?? '', /on the remote machine/);
  });
});
