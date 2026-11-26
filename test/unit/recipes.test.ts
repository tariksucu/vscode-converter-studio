import * as assert from 'node:assert/strict';
import {
  engineFor,
  ffmpegArgs,
  gsArgs,
  localTargets,
  magickArgs,
  pandocArgs,
  planFor,
  sofficeArgs,
  type Capabilities,
  type Job,
} from '../../src/recipes';
import type { Tool, Toolbox } from '../../src/tools';

const ffmpeg = (encoders: string[]): Tool => ({
  id: 'ffmpeg',
  path: '/usr/bin/ffmpeg',
  version: '6.1',
  encoders: new Set(encoders),
});
const FULL_FFMPEG = ffmpeg([
  'libx264',
  'libvpx-vp9',
  'aac',
  'libopus',
  'libvorbis',
  'libmp3lame',
  'flac',
  'pcm_s16le',
  'gif',
  'mpeg4',
]);
const magick = (reads: string[], writes: string[], legacy = false): Tool => ({
  id: 'magick',
  path: legacy ? '/usr/bin/convert' : '/usr/bin/magick',
  version: '7.1',
  legacy,
  reads: new Set(reads),
  writes: new Set(writes),
});
const IMAGES = ['JPEG', 'PNG', 'WEBP', 'GIF', 'BMP', 'TIFF', 'AVIF', 'ICO', 'SVG'];
const all: Toolbox = {
  ffmpeg: FULL_FFMPEG,
  soffice: { id: 'soffice', path: '/usr/bin/soffice', version: '24.2' },
  pandoc: { id: 'pandoc', path: '/usr/bin/pandoc', version: '3.1' },
  magick: magick([...IMAGES, 'HEIC'], IMAGES),
  gs: { id: 'gs', path: '/usr/bin/gs', version: '10.02' },
  tesseract: {
    id: 'tesseract',
    path: '/usr/bin/tesseract',
    version: '5.3',
    languages: ['eng'],
    imageFormats: new Set(['png', 'jpg', 'tiff', 'bmp']),
  },
};
const caps = (tools: Toolbox, canvas = true): Capabilities => ({ tools, canvas });

const job = (fields: Partial<Job>): Job => ({
  input: '/work/in.png',
  from: 'png',
  to: 'webp',
  variant: null,
  work: '/tmp/cs-1',
  profile:
    '/home/ada/.config/Code/User/globalStorage/converterstudio.converter-studio/libreoffice-profile',
  languages: 'eng',
  title: 'in',
  ...fields,
});

describe('engineFor: what converts on this computer', () => {
  it('uses ImageMagick for images when it is there, the editor’s own encoder otherwise', () => {
    assert.equal(engineFor('png', 'webp', null, caps(all)), 'magick');
    assert.equal(engineFor('png', 'webp', null, caps({})), 'canvas');
    assert.equal(engineFor('svg', 'png', null, caps({})), 'canvas');
    assert.equal(
      engineFor('png', 'avif', null, caps({})),
      null,
      'the canvas writes PNG, JPG and WebP only',
    );
  });

  it('converts HEIC only with an ImageMagick that reads it', () => {
    assert.equal(engineFor('heic', 'jpg', null, caps({})), null);
    assert.equal(engineFor('heic', 'jpg', null, caps({ magick: magick(IMAGES, IMAGES) })), null);
    assert.equal(engineFor('heic', 'jpg', null, caps(all)), 'magick');
  });

  it('picks LibreOffice for Office formats and PDF, Pandoc for Markdown, HTML and EPUB', () => {
    assert.equal(engineFor('docx', 'pdf', null, caps(all)), 'soffice');
    assert.equal(engineFor('docx', 'odt', null, caps(all)), 'soffice');
    assert.equal(engineFor('xlsx', 'csv', null, caps(all)), 'soffice');
    assert.equal(engineFor('pptx', 'pdf', null, caps(all)), 'soffice');
    assert.equal(engineFor('md', 'docx', null, caps(all)), 'pandoc');
    assert.equal(engineFor('docx', 'md', null, caps(all)), 'pandoc');
    assert.equal(engineFor('html', 'epub', null, caps(all)), 'pandoc');
    assert.equal(engineFor('docx', 'odt', null, caps({ pandoc: all.pandoc })), 'pandoc');
  });

  it('makes a PDF of Markdown with Pandoc and LibreOffice together (no LaTeX)', () => {
    assert.equal(engineFor('md', 'pdf', null, caps(all)), 'pandoc+soffice');
    assert.equal(engineFor('md', 'pdf', null, caps({ pandoc: all.pandoc })), null);
    assert.equal(engineFor('md', 'pdf', null, caps({ soffice: all.soffice })), null);
    const targets = localTargets(['md'], caps(all), [true]);
    assert.equal(targets.find((t) => t.to === 'pdf')?.engine, 'Pandoc + LibreOffice');
  });

  it('uses FFmpeg only with the encoder the target needs', () => {
    assert.equal(engineFor('mp4', 'mp3', null, caps(all)), 'ffmpeg');
    assert.equal(engineFor('mp4', 'mp3', null, caps({ ffmpeg: ffmpeg(['aac']) })), null);
    assert.equal(engineFor('wav', 'ogg', null, caps({ ffmpeg: ffmpeg(['aac']) })), null);
    assert.equal(
      engineFor('mov', 'mp4', null, caps({ ffmpeg: ffmpeg(['mpeg4', 'aac']) })),
      'ffmpeg',
    );
    assert.equal(engineFor('gif', 'mp4', null, caps({ ffmpeg: ffmpeg(['libx264']) })), 'ffmpeg');
    assert.equal(engineFor('mp3', 'mp4', null, caps(all)), null, 'no picture to make a video of');
  });

  it('does a smaller PDF and text recognition only with their tools', () => {
    assert.equal(engineFor('pdf', 'pdf', 'compress', caps(all)), 'gs');
    assert.equal(engineFor('pdf', 'pdf', 'compress', caps({})), null);
    assert.equal(engineFor('pdf', 'txt', null, caps(all)), 'gs');
    assert.equal(engineFor('pdf', 'txt', 'ocr', caps(all)), 'tesseract');
    assert.equal(
      engineFor('pdf', 'txt', 'ocr', caps({ tesseract: all.tesseract })),
      null,
      'needs Ghostscript',
    );
    assert.equal(engineFor('png', 'txt', 'ocr', caps(all)), 'tesseract');
    assert.equal(engineFor('webp', 'txt', 'ocr', caps(all)), null, 'this Tesseract has no WebP');
  });

  it('converts data itself', () => {
    assert.equal(engineFor('json', 'csv', null, caps({})), 'data');
    assert.equal(engineFor('json', 'yaml', null, caps({})), 'data');
    assert.equal(engineFor('csv', 'json', null, caps({})), 'data');
    assert.equal(engineFor('csv', 'xlsx', null, caps(all)), 'soffice');
    assert.equal(engineFor('yaml', 'json', null, caps(all)), null);
  });
});

describe('localTargets', () => {
  it('lists what fits every file first, and how many files the others fit', () => {
    const targets = localTargets(['png', 'heic'], caps({}), [true, true]);
    assert.ok(targets.length > 0);
    assert.ok(
      targets.every((t) => t.files.length === 1),
      'the canvas cannot read HEIC',
    );
    const both = localTargets(['png', 'heic'], caps(all), [true, true]);
    assert.equal(both[0]!.files.length, 2);
    assert.equal(both[0]!.to, 'webp');
    assert.equal(both[0]!.engine, 'ImageMagick');
  });

  it('names the engine, or how many when the files differ', () => {
    const targets = localTargets(['png', 'heic'], caps({ magick: magick(['HEIC'], ['WEBP']) }), [
      true,
      true,
    ]);
    const webp = targets.find((t) => t.to === 'webp')!;
    assert.deepEqual(webp.files, [0, 1]);
    assert.equal(webp.engine, '2 tools');
  });

  it('offers the smaller PDF and text recognition as their own choices', () => {
    const targets = localTargets(['pdf'], caps(all), [true]);
    const labels = targets.map((t) => t.label);
    assert.ok(labels.includes('PDF, smaller file'));
    assert.ok(labels.includes('Text, recognizing the words (OCR)'));
    assert.deepEqual(targets.find((t) => t.variant === 'ocr')!.options, { ocr: true });
  });

  it('gives a file that is not on disk only the built-in conversions', () => {
    const targets = localTargets(['png', 'docx'], caps(all), [false, false]);
    assert.ok(targets.every((t) => t.engine === 'built in'));
    assert.ok(targets.every((t) => t.files.length === 1 && t.files[0] === 0));
  });

  it('has nothing for unknown files', () => {
    assert.deepEqual(localTargets([null], caps(all), [true]), []);
  });
});

describe('command lines', () => {
  it('FFmpeg: arguments, local files only, never overwriting', () => {
    const args = ffmpegArgs('/w/a b;rm -rf.mp4', '/tmp/cs-1/result.mp3', 'mp4', 'mp3', FULL_FFMPEG);
    assert.ok(args.includes('file:/w/a b;rm -rf.mp4'), 'the whole path is one argument');
    assert.ok(args.indexOf('-protocol_whitelist') < args.indexOf('-i'));
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
    assert.deepEqual(args.slice(-2), ['-n', 'file:/tmp/cs-1/result.mp3']);
    assert.ok(args.includes('libmp3lame') && args.includes('-vn'));
  });

  it('FFmpeg: H.264 when there, MPEG-4 otherwise; a GIF has no sound', () => {
    const h264 = ffmpegArgs('/w/a.mov', '/t/r.mp4', 'mov', 'mp4', FULL_FFMPEG);
    assert.equal(h264[h264.indexOf('-c:v') + 1], 'libx264');
    assert.ok(h264.includes('+faststart') && h264.includes('yuv420p'));
    const mpeg4 = ffmpegArgs('/w/a.mov', '/t/r.mp4', 'mov', 'mp4', ffmpeg(['mpeg4', 'aac']));
    assert.equal(mpeg4[mpeg4.indexOf('-c:v') + 1], 'mpeg4');
    const gif = ffmpegArgs('/w/a.gif', '/t/r.mp4', 'gif', 'mp4', FULL_FFMPEG);
    assert.ok(gif.includes('-an') && !gif.includes('-c:a'));
    const toGif = ffmpegArgs('/w/a.mp4', '/t/r.gif', 'mp4', 'gif', FULL_FFMPEG);
    assert.ok(toGif.some((arg) => arg.includes('palettegen')));
    const webm = ffmpegArgs('/w/a.mp4', '/t/r.webm', 'mp4', 'webm', FULL_FFMPEG);
    assert.equal(webm[webm.indexOf('-c:a') + 1], 'libopus');
    const aac = ffmpegArgs('/w/a.wav', '/t/r.aac', 'wav', 'aac', FULL_FFMPEG);
    assert.equal(aac[aac.indexOf('-f') + 1], 'adts');
  });

  it('LibreOffice: its own profile, headless, the filter and the folder', () => {
    const args = sofficeArgs(
      job({ input: '/w/report.docx', from: 'docx', to: 'pdf' }),
      '/tmp/cs-1/out',
    );
    assert.equal(
      args[0],
      '-env:UserInstallation=file:///home/ada/.config/Code/User/globalStorage/converterstudio.converter-studio/libreoffice-profile',
    );
    assert.ok(args.includes('--headless') && args.includes('--norestore'));
    assert.deepEqual(args.slice(-5), [
      '--convert-to',
      'pdf',
      '--outdir',
      '/tmp/cs-1/out',
      '/w/report.docx',
    ]);
    const xlsx = sofficeArgs(
      job({ input: '/w/t.csv', from: 'csv', to: 'xlsx', csvSeparator: ';' }),
      '/o',
    );
    assert.ok(xlsx.includes('--infilter=CSV:59,34,76,1'));
    assert.ok(xlsx.includes('xlsx:Calc MS Excel 2007 XML'));
    assert.throws(() => sofficeArgs(job({ from: 'md', to: 'pdf' }), '/o'));
  });

  it('Pandoc: GitHub Markdown, a title for HTML', () => {
    assert.deepEqual(
      pandocArgs(job({ input: '/w/README.md', from: 'md', to: 'docx' }), '/t/r.docx'),
      ['--from', 'gfm', '--to', 'docx', '--output', '/t/r.docx', '/w/README.md'],
    );
    const html = pandocArgs(
      job({ input: '/w/a.md', from: 'md', to: 'html', title: 'Notes' }),
      '/t/r.html',
    );
    assert.ok(html.includes('--standalone'));
    assert.equal(html[html.indexOf('--metadata') + 1], 'pagetitle=Notes');
  });

  it('ImageMagick: each path carries its format; one frame unless both keep frames', () => {
    assert.deepEqual(magickArgs(job({ input: '/w/a.png', from: 'png', to: 'webp' }), '/t/r.webp'), [
      'PNG:/w/a.png',
      '-auto-orient',
      '-quality',
      '85',
      'WEBP:/t/r.webp',
    ]);
    const jpg = magickArgs(job({ input: '/w/a.gif', from: 'gif', to: 'jpg' }), '/t/r.jpg');
    assert.equal(jpg[0], 'GIF:/w/a.gif[0]');
    assert.ok(jpg.join(' ').includes('-background white -alpha remove'));
    const animated = magickArgs(job({ input: '/w/a.gif', from: 'gif', to: 'webp' }), '/t/r.webp');
    assert.equal(animated[0], 'GIF:/w/a.gif');
    const svg = magickArgs(job({ input: '/w/i.svg', from: 'svg', to: 'png' }), '/t/r.png');
    assert.deepEqual(svg.slice(0, 3), ['-background', 'none', 'SVG:/w/i.svg']);
    const heic = magickArgs(job({ input: '/w/IMG.HEIC', from: 'heic', to: 'jpg' }), '/t/r.jpg');
    assert.equal(heic[0], 'HEIC:/w/IMG.HEIC[0]');
  });

  it('Ghostscript: safe mode, and a % in a name is not a page number', () => {
    const args = gsArgs(
      job({ input: '/w/a.pdf', from: 'pdf', to: 'pdf', variant: 'compress' }),
      '/t/100%/r.pdf',
    );
    assert.ok(args.includes('-dSAFER') && args.includes('-sDEVICE=pdfwrite'));
    assert.ok(args.includes('-dPDFSETTINGS=/ebook'));
    assert.ok(args.includes('-sOutputFile=/t/100%%/r.pdf'));
    const text = gsArgs(job({ input: '/w/a.pdf', from: 'pdf', to: 'txt' }), '/t/r.txt');
    assert.ok(text.includes('-sDEVICE=txtwrite'));
  });

  it('a scanned PDF: pages as images, their list, then Tesseract reads them all', () => {
    const plan = planFor(
      'tesseract',
      job({ input: '/w/scan.pdf', from: 'pdf', to: 'txt', variant: 'ocr', languages: 'eng+deu' }),
      all,
    );
    assert.equal(plan.steps.length, 4);
    assert.deepEqual(plan.steps[0], { makeFolder: '/tmp/cs-1/pages' });
    const gs = plan.steps[1] as { tool: string; args: string[] };
    assert.equal(gs.tool, 'gs');
    assert.ok(gs.args.includes('-sOutputFile=/tmp/cs-1/pages/page-%04d.png'));
    assert.deepEqual(plan.steps[2], {
      listFiles: { folder: '/tmp/cs-1/pages', prefix: 'page-', into: '/tmp/cs-1/pages.txt' },
    });
    assert.deepEqual(plan.steps[3], {
      tool: 'tesseract',
      args: ['/tmp/cs-1/pages.txt', '/tmp/cs-1/result', '-l', 'eng+deu', 'txt'],
    });
    assert.deepEqual(plan.output, { file: '/tmp/cs-1/result.txt' });
  });

  it('LibreOffice names its result itself: the only file in its folder', () => {
    const plan = planFor('soffice', job({ input: '/w/a.docx', from: 'docx', to: 'pdf' }), all);
    assert.deepEqual(plan.output, { onlyFileIn: '/tmp/cs-1/out' });
    const pandoc = planFor('pandoc', job({ input: '/w/docs/a.md', from: 'md', to: 'docx' }), all);
    assert.equal((pandoc.steps[0] as { cwd?: string }).cwd, '/w/docs', 'relative images are found');
  });

  it('Markdown to PDF: Pandoc writes a Word file, LibreOffice makes the PDF of it', () => {
    const plan = planFor(
      'pandoc+soffice',
      job({ input: '/w/docs/README.md', from: 'md', to: 'pdf', title: 'README' }),
      all,
    );
    assert.deepEqual(plan.steps[0], { makeFolder: '/tmp/cs-1/docx' });
    assert.deepEqual(plan.steps[1], {
      tool: 'pandoc',
      args: [
        '--from',
        'gfm',
        '--to',
        'docx',
        '--output',
        '/tmp/cs-1/docx/README.docx',
        '/w/docs/README.md',
      ],
      cwd: '/w/docs',
    });
    const office = plan.steps[2] as { tool: string; args: string[] };
    assert.equal(office.tool, 'soffice');
    assert.deepEqual(office.args.slice(-5), [
      '--convert-to',
      'pdf',
      '--outdir',
      '/tmp/cs-1/out',
      '/tmp/cs-1/docx/README.docx',
    ]);
    assert.deepEqual(plan.output, { onlyFileIn: '/tmp/cs-1/out' });
  });
});
