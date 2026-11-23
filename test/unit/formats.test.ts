import * as assert from 'node:assert/strict';
import { formatOfName, targetsFor } from '../../src/formats';
import { CATALOGUE } from './helpers';

describe('formatOfName', () => {
  it('finds formats by extension, any case, longest first', () => {
    assert.equal(formatOfName('IMG_0001.HEIC', CATALOGUE), 'heic');
    assert.equal(formatOfName('photo.heif', CATALOGUE), 'heic');
    assert.equal(formatOfName('cat.jpeg', CATALOGUE), 'jpg');
    assert.equal(formatOfName('backup.tar.gz', CATALOGUE), 'tgz');
    assert.equal(formatOfName('backup.tar', CATALOGUE), 'tar');
  });

  it('knows nothing of other files', () => {
    assert.equal(formatOfName('main.ts', CATALOGUE), null);
    assert.equal(formatOfName('Makefile', CATALOGUE), null);
    assert.equal(
      formatOfName('.png', CATALOGUE),
      null,
      'a hidden file named .png has no extension',
    );
  });
});

describe('targetsFor', () => {
  it('suggests JPG, PNG, WebP and AVIF for an iPhone photo, then every other target', () => {
    const targets = targetsFor(['heic'], CATALOGUE);
    const suggested = targets.filter((t) => t.suggested).map((t) => t.to);
    assert.deepEqual(suggested, ['jpg', 'png', 'webp', 'avif']);
    const rest = targets.filter((t) => !t.suggested).map((t) => t.to);
    assert.deepEqual(rest, ['pdf', 'docx', 'gif', 'txt', 'ico', 'tiff', 'bmp']);
    assert.ok(targets.every((t) => t.files.length === 1 && t.files[0] === 0));
  });

  it('suggests text with OCR for a PDF and keeps plain text in the list', () => {
    const targets = targetsFor(['pdf'], CATALOGUE);
    const ocr = targets.find((t) => t.suggested && t.to === 'txt');
    assert.deepEqual(ocr?.options, { ocr: true });
    assert.ok(targets.some((t) => !t.suggested && t.to === 'txt' && !t.options));
    const compress = targets.find((t) => t.to === 'pdf');
    assert.equal(compress?.description, 'smaller file (compress)');
  });

  it('suggests PDF for Word files', () => {
    const targets = targetsFor(['docx', 'docx'], CATALOGUE);
    assert.equal(targets[0]?.to, 'pdf');
    assert.ok(targets[0]?.suggested);
    assert.deepEqual(targets[0]?.files, [0, 1]);
  });

  it('suggests PNG for an SVG', () => {
    const suggested = targetsFor(['svg'], CATALOGUE).filter((t) => t.suggested);
    assert.deepEqual(
      suggested.map((t) => t.to),
      ['png'],
    );
  });

  it('suggests only what fits every file, and counts the files of each target', () => {
    const targets = targetsFor(['png', 'mp3', 'jpg'], CATALOGUE);
    assert.ok(
      targets.every((t) => !t.suggested),
      'no suggestion fits an MP3 and images',
    );
    const webp = targets.find((t) => t.to === 'webp');
    assert.deepEqual(webp?.files, [0, 2]);
    const wav = targets.find((t) => t.to === 'wav');
    assert.deepEqual(wav?.files, [1]);
  });

  it('lists targets that fit every file first', () => {
    const targets = targetsFor(['png', 'webp'], CATALOGUE);
    const counts = targets.filter((t) => !t.suggested).map((t) => t.files.length);
    const firstPartial = counts.indexOf(1);
    assert.ok(firstPartial > 0);
    assert.ok(counts.slice(firstPartial).every((n) => n === 1));
  });

  it('suggests nothing when a file is unknown, and offers nothing when all are', () => {
    const targets = targetsFor(['png', null], CATALOGUE);
    assert.ok(targets.length > 0 && targets.every((t) => !t.suggested));
    assert.deepEqual(targetsFor([null, null], CATALOGUE), []);
  });
});
