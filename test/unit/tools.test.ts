import * as assert from 'node:assert/strict';
import {
  candidates,
  detectTools,
  executableNames,
  parseFfmpegEncoders,
  parseFfmpegVersion,
  parseGsVersion,
  parseMagickFormats,
  parseMagickVersion,
  parsePandocVersion,
  parseSofficeVersion,
  parseTesseractImageFormats,
  parseTesseractLanguages,
  parseTesseractVersion,
  pathFolders,
  type Host,
  type Probe,
} from '../../src/tools';

const linux = (path: string): Host => ({ os: 'linux', env: { PATH: path }, home: '/home/ada' });

/** A file system of executables (`files`) and folders (`folders`: name lists). */
function probe(
  files: string[],
  folders: Record<string, string[]> = {},
): Probe & { checked: string[] } {
  const checked: string[] = [];
  return {
    checked,
    isExecutable: (path) => {
      checked.push(path);
      return Promise.resolve(files.includes(path));
    },
    list: (folder) => Promise.resolve(folders[folder] ?? []),
  };
}

// Real output of the tools on Ubuntu 24.04 (2026-11-23), shortened.
const FFMPEG_ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V.S... mpeg4                MPEG-4 part 2
 V....D libvpx-vp9           libvpx VP9 (codec vp9)
 A....D aac                  AAC (Advanced Audio Coding)
 A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3) (codec mp3)
 A....D libopus              libopus Opus (codec opus)
`;
const MAGICK_FORMATS = `   Format  Module    Mode  Description
-------------------------------------------------------------------------------
      AVIF  HEIC      rw+   AV1 Image File Format (1.17.6)
       BMP* BMP       rw-   Microsoft Windows bitmap image
      HEIC  HEIC      r--   High Efficiency Image Format (1.17.6)
      JPEG* JPEG      rw-   Joint Photographic Experts Group JFIF format (libjpeg-turbo 2.1.5)
       PNG* PNG       rw-   Portable Network Graphics (libpng 1.6.43)
       SVG  SVG       rw+   Scalable Vector Graphics (RSVG 2.58.0)
      WEBP* WEBP      rw+   WebP Image Format (libwebp 1.3.2 [020F])
`;
const TESSERACT_VERSION = `tesseract 5.3.4
 leptonica-1.82.0
  libgif 5.2.1 : libjpeg 8d (libjpeg-turbo 2.1.5) : libpng 1.6.43 : libtiff 4.5.1 : zlib 1.3 : libwebp 1.3.2 : libopenjp2 2.5.0
 Found AVX2
`;

describe('tools: names and folders', () => {
  it('never takes Windows’ own convert.exe for ImageMagick', () => {
    assert.deepEqual(executableNames('magick', 'win32'), ['magick.exe']);
    assert.deepEqual(executableNames('magick', 'linux'), ['magick', 'convert']);
    assert.deepEqual(executableNames('gs', 'win32'), ['gswin64c.exe', 'gswin32c.exe']);
  });

  it('uses only absolute PATH folders outside the workspace', () => {
    const host = linux('/usr/bin:.:node_modules/.bin::/work/project/bin:/opt/tools/bin:/usr/bin');
    assert.deepEqual(pathFolders(host, ['/work/project']), ['/usr/bin', '/opt/tools/bin']);
  });

  it('reads Windows’ Path whatever its case, without quotes', () => {
    const host: Host = {
      os: 'win32',
      env: { Path: 'C:\\Windows\\system32;"C:\\Tools\\bin";bin;C:\\Users\\ada\\repo\\bin' },
      home: 'C:\\Users\\ada',
    };
    assert.deepEqual(pathFolders(host, ['c:\\users\\ada\\repo']), [
      'C:\\Windows\\system32',
      'C:\\Tools\\bin',
    ]);
  });

  it('tries the configured path, then PATH, then the usual folders', async () => {
    const list = await candidates('ffmpeg', linux('/opt/a'), {
      configured: '/custom/ffmpeg',
      workspaceFolders: [],
      probe: probe([]),
    });
    assert.equal(list[0], '/custom/ffmpeg');
    assert.equal(list[1], '/opt/a/ffmpeg');
    assert.ok(list.includes('/usr/bin/ffmpeg'));
    assert.ok(list.includes('/home/ada/.local/bin/ffmpeg'));
  });

  it('ignores a relative configured path (it would depend on the folder)', async () => {
    const list = await candidates('pandoc', linux(''), {
      configured: 'bin/pandoc',
      workspaceFolders: [],
      probe: probe([]),
    });
    assert.ok(!list.includes('bin/pandoc'));
  });

  it('looks for magick everywhere before convert', async () => {
    const list = await candidates('magick', linux('/a:/b'), {
      workspaceFolders: [],
      probe: probe([]),
    });
    const firstConvert = list.findIndex((file) => file.endsWith('/convert'));
    const lastMagick = list.map((file) => file.endsWith('/magick')).lastIndexOf(true);
    assert.ok(lastMagick < firstConvert);
  });

  it('finds versioned install folders on Windows, the newest first', async () => {
    const host: Host = {
      os: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', Path: '' },
      home: 'C:\\Users\\ada',
    };
    const files = probe([], {
      'C:\\Program Files': ['ImageMagick-7.1.0-Q16', 'ImageMagick-7.1.10-Q16-HDRI', 'Other'],
    });
    const list = await candidates('magick', host, { workspaceFolders: [], probe: files });
    const found = list.filter((file) => file.includes('ImageMagick'));
    assert.deepEqual(found.slice(0, 2), [
      'C:\\Program Files\\ImageMagick-7.1.10-Q16-HDRI\\magick.exe',
      'C:\\Program Files\\ImageMagick-7.1.0-Q16\\magick.exe',
    ]);
    const soffice = await candidates('soffice', host, { workspaceFolders: [], probe: files });
    assert.ok(soffice.includes('C:\\Program Files\\LibreOffice\\program\\soffice.exe'));
  });

  it('looks in the LibreOffice app on macOS', async () => {
    const host: Host = { os: 'darwin', env: { PATH: '/usr/bin' }, home: '/Users/ada' };
    const list = await candidates('soffice', host, { workspaceFolders: [], probe: probe([]) });
    assert.ok(list.includes('/Applications/LibreOffice.app/Contents/MacOS/soffice'));
    const brew = await candidates('ffmpeg', host, { workspaceFolders: [], probe: probe([]) });
    assert.ok(brew.includes('/opt/homebrew/bin/ffmpeg'));
  });
});

describe('tools: what they say about themselves', () => {
  it('reads FFmpeg’s version and encoders', () => {
    assert.equal(
      parseFfmpegVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023'),
      '6.1.1-3ubuntu5',
    );
    const encoders = parseFfmpegEncoders(FFMPEG_ENCODERS);
    assert.ok(encoders.has('libx264') && encoders.has('libmp3lame') && encoders.has('aac'));
    assert.ok(!encoders.has('='));
    assert.ok(!encoders.has('libvorbis'));
  });

  it('reads which formats ImageMagick reads and writes (HEIC only when built in)', () => {
    assert.equal(parseMagickVersion('Version: ImageMagick 7.1.1-21 Q16-HDRI x86_64'), '7.1.1-21');
    assert.equal(parseMagickVersion('convert: invalid drive specification'), null);
    const { reads, writes } = parseMagickFormats(MAGICK_FORMATS);
    assert.ok(reads.has('HEIC') && !writes.has('HEIC'));
    assert.ok(reads.has('JPEG') && writes.has('JPEG'), 'a format with * still counts');
    assert.ok(writes.has('AVIF') && writes.has('WEBP'));
  });

  it('reads the versions of the others', () => {
    assert.equal(parsePandocVersion('pandoc 3.1.3\nFeatures: +server'), '3.1.3');
    assert.equal(parsePandocVersion('pandoc.exe 3.5\n'), '3.5');
    assert.equal(parseGsVersion('10.02.1\n'), '10.02.1');
    assert.equal(parseSofficeVersion('LibreOffice 24.2.7.2 420(Build:2)'), '24.2.7.2');
    assert.equal(parseTesseractVersion(TESSERACT_VERSION), '5.3.4');
  });

  it('reads Tesseract’s image formats and languages', () => {
    assert.deepEqual([...parseTesseractImageFormats(TESSERACT_VERSION)].sort(), [
      'bmp',
      'gif',
      'jpg',
      'png',
      'tiff',
      'webp',
    ]);
    assert.deepEqual([...parseTesseractImageFormats('tesseract 5\n libpng 1.6')].sort(), [
      'bmp',
      'png',
    ]);
    const languages = parseTesseractLanguages(
      'List of available languages in "/usr/share/tesseract-ocr/5/tessdata/" (4):\neng\nosd\nscript/Latin\ndeu\n',
    );
    assert.deepEqual(languages, ['eng', 'script/Latin', 'deu']);
  });
});

describe('detectTools', () => {
  it('finds each tool, skips a convert that is not ImageMagick, and asks what it can do', async () => {
    const files = probe([
      '/usr/bin/ffmpeg',
      '/usr/bin/convert',
      '/opt/im/bin/convert',
      '/usr/bin/tesseract',
    ]);
    const asked: string[] = [];
    const answers: Record<string, string> = {
      '/usr/bin/ffmpeg -hide_banner -version': 'ffmpeg version 7.1 Copyright',
      '/usr/bin/ffmpeg -hide_banner -encoders': FFMPEG_ENCODERS,
      '/usr/bin/convert -version': 'convert: not ImageMagick',
      '/opt/im/bin/convert -version': 'Version: ImageMagick 6.9.12-98 Q16 x86_64',
      '/opt/im/bin/convert -list format': MAGICK_FORMATS,
      '/usr/bin/tesseract --version': TESSERACT_VERSION,
      '/usr/bin/tesseract --list-langs': 'List of available languages (2):\neng\nosd\n',
    };
    const { tools, problems } = await detectTools(linux('/usr/bin:/opt/im/bin'), {
      configured: {},
      workspaceFolders: [],
      probe: files,
      ask: (path, args) => {
        const key = `${path} ${args.join(' ')}`;
        asked.push(key);
        return key in answers
          ? Promise.resolve(answers[key]!)
          : Promise.reject(new Error(`no answer for ${key}`));
      },
    });
    assert.equal(tools.ffmpeg?.version, '7.1');
    assert.ok(tools.ffmpeg?.encoders?.has('libx264'));
    assert.equal(tools.magick?.path, '/opt/im/bin/convert');
    assert.equal(tools.magick?.legacy, true);
    assert.ok(tools.magick?.reads?.has('HEIC'));
    assert.deepEqual(tools.tesseract?.languages, ['eng']);
    assert.equal(tools.soffice, undefined);
    assert.equal(tools.pandoc, undefined);
    assert.deepEqual(problems, {});
    // Every question is an array of arguments to a found executable.
    for (const key of asked)
      assert.ok(key.startsWith('/usr/bin/') || key.startsWith('/opt/im/bin/'));
  });

  it('does not start LibreOffice on Windows only to ask its version', async () => {
    const host: Host = {
      os: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', Path: '' },
      home: 'C:\\Users\\ada',
    };
    const asked: string[] = [];
    const { tools } = await detectTools(host, {
      configured: {},
      workspaceFolders: [],
      probe: probe(['C:\\Program Files\\LibreOffice\\program\\soffice.exe']),
      ask: (path) => {
        asked.push(path);
        return Promise.resolve('');
      },
    });
    assert.equal(tools.soffice?.path, 'C:\\Program Files\\LibreOffice\\program\\soffice.exe');
    assert.equal(tools.soffice?.version, null);
    assert.deepEqual(asked, []);
  });

  it('records a tool that does not answer and goes on to the next one', async () => {
    const files = probe(['/a/gs', '/usr/bin/gs']);
    const { tools, problems } = await detectTools(linux('/a:/usr/bin'), {
      configured: {},
      workspaceFolders: [],
      probe: files,
      ask: (path) =>
        path === '/a/gs' ? Promise.reject(new Error('timed out')) : Promise.resolve('10.0.0'),
    });
    assert.equal(tools.gs?.path, '/usr/bin/gs');
    assert.match(problems.gs ?? '', /timed out/);
  });
});
