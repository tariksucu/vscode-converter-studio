import * as assert from 'node:assert/strict';
import { extensionOf, freeName, numberedName, resultName, safeName } from '../../src/naming';

describe('naming', () => {
  it("uses the server's name for the result", () => {
    assert.equal(resultName('IMG_1.HEIC', 'IMG_1.jpg', 'jpg'), 'IMG_1.jpg');
    assert.equal(resultName('report.pdf', 'report-compressed.pdf', 'pdf'), 'report-compressed.pdf');
    assert.equal(resultName('scan.pdf', 'scan.zip', 'jpg'), 'scan.zip');
  });

  it('falls back to the original stem and the target', () => {
    assert.equal(resultName('photo.heic', null, 'webp'), 'photo.webp');
    assert.equal(resultName('backup.tar.gz', null, 'zip'), 'backup.zip');
    assert.equal(resultName('folder.zip', null, 'tgz'), 'folder.tar.gz');
    assert.equal(resultName('photo.heic', '../../etc/passwd', 'jpg'), 'photo.jpg');
  });

  it('never takes a folder from a name', () => {
    assert.equal(safeName('../x/../y.png'), 'y.png');
    assert.equal(safeName('a\\b\\c.txt'), 'c.txt');
    assert.equal(safeName('..'), '');
    assert.equal(safeName('bad:name?.png'), 'bad_name_.png');
  });

  it('numbers a taken name before its extension', () => {
    assert.equal(numberedName('photo.webp', 1), 'photo (1).webp');
    assert.equal(numberedName('backup.tar.gz', 2), 'backup (2).tar.gz');
    assert.equal(numberedName('README', 3), 'README (3)');
    assert.equal(extensionOf('.gitignore'), '');
  });

  it('finds the first free name', async () => {
    const taken = new Set(['photo.webp', 'photo (1).webp']);
    assert.equal(
      await freeName('photo.webp', (n) => Promise.resolve(taken.has(n))),
      'photo (2).webp',
    );
    assert.equal(await freeName('new.webp', (n) => Promise.resolve(taken.has(n))), 'new.webp');
  });
});
