import * as assert from 'node:assert/strict';
import {
  DESKTOP_APP,
  DESKTOP_MAX_LINK,
  desktopLimitProblem,
  desktopLink,
  desktopLinks,
  readDesktopLink,
} from '../../src/desktop';

describe('the desktop app hand-off', () => {
  it('encodes every value, so any path arrives as it is', () => {
    const paths = [
      '/home/ada/My Photos/a+b #1 & 100%.png',
      'C:\\Users\\Ada\\Masaüstü\\çizim = son?.svg',
      '/tmp/日本語/ファイル.heic',
    ];
    const link = desktopLink('webp', paths);
    assert.ok(link.startsWith('converter-studio://convert?to=webp&from=vscode&file='));
    for (const pair of link.split('?')[1]!.split('&'))
      assert.match(
        pair,
        /^(to|from|file)=[\w.~!*'()%-]+$/,
        'no raw space, +, #, & or = in a value',
      );
    assert.ok(!/%(?![0-9A-F]{2})/.test(link), 'every % starts an escape');
    assert.ok(link.includes('a%2Bb%20%231%20%26%20100%25.png'));
    assert.deepEqual(readDesktopLink(link), { to: 'webp', from: 'vscode', files: paths });
  });

  it('splits a long list into links the app merges, each short enough for Windows', () => {
    const paths = Array.from(
      { length: 60 },
      (_, i) => `/home/ada/projects/website/public/images/photo-${i}.png`,
    );
    const links = desktopLinks('webp', paths);
    assert.ok(links.length > 1);
    for (const link of links) assert.ok(link.length <= DESKTOP_MAX_LINK);
    assert.deepEqual(
      links.flatMap((link) => readDesktopLink(link)!.files),
      paths,
    );
    assert.deepEqual(desktopLinks('pdf', ['/a.docx']), [
      'converter-studio://convert?to=pdf&from=vscode&file=%2Fa.docx',
    ]);
  });

  it('keeps to what the app takes at once', () => {
    assert.equal(desktopLimitProblem(200, 1e9), null);
    assert.match(desktopLimitProblem(201, 1) ?? '', /200 files/);
    assert.match(desktopLimitProblem(2, 51 * 1024 ** 3) ?? '', /50 GB/);
  });

  it('names the version it needs', () => {
    assert.equal(DESKTOP_APP, 'Converter Studio for desktop 0.1.11 or later');
  });
});
