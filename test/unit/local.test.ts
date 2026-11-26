import * as assert from 'node:assert/strict';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FileAccess, Outcome } from '../../src/convert';
import { ConverterStudioError } from '../../src/errors';
import {
  DEFAULT_LOCAL_SETTINGS,
  checkLanguages,
  convertAllHere,
  type LocalDeps,
} from '../../src/local';
import { localTargets, type Capabilities, type LocalTarget } from '../../src/recipes';
import type { RunOptions, RunResult } from '../../src/run';
import type { Toolbox } from '../../src/tools';

/** Files on disk, as the extension reads and writes them (never over an existing file). */
const disk: FileAccess<string> = {
  name: (path) => basename(path),
  sibling: (path, name) => join(dirname(path), name),
  size: async (path) => (await fsp.stat(path)).size,
  read: (path, signal) => createReadStream(path, { signal }),
  exists: (path) => Promise.resolve(existsSync(path)),
  async write(path, body, { overwrite }) {
    const handle = await fsp
      .open(path, overwrite ? 'w' : 'wx')
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') throw Object.assign(new Error('exists'), { exists: true });
        throw error;
      });
    try {
      for await (const chunk of body) await handle.write(chunk);
    } finally {
      await handle.close();
    }
  },
};

const tools: Toolbox = {
  ffmpeg: {
    id: 'ffmpeg',
    path: '/usr/bin/ffmpeg',
    version: '6.1',
    encoders: new Set(['libx264', 'aac', 'libmp3lame']),
  },
  soffice: { id: 'soffice', path: '/usr/bin/soffice', version: '24.2' },
  pandoc: { id: 'pandoc', path: '/usr/bin/pandoc', version: '3.1' },
  gs: { id: 'gs', path: '/usr/bin/gs', version: '10.02' },
  tesseract: {
    id: 'tesseract',
    path: '/usr/bin/tesseract',
    version: '5.3',
    languages: ['eng'],
    imageFormats: new Set(['png']),
  },
};

const codeOf = (outcome?: Outcome<string>) =>
  outcome && outcome.status !== 'converted' ? outcome.error.code : undefined;
const messageOf = (outcome?: Outcome<string>) =>
  outcome && outcome.status !== 'converted' ? outcome.error.message : '';
const engineOf = (outcome?: Outcome<string>) =>
  outcome && outcome.status === 'converted' ? outcome.engine : undefined;

interface Call {
  file: string;
  args: readonly string[];
  options: RunOptions;
}

describe('convertAllHere', () => {
  let root: string;
  let work: string;
  let folders: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cs-local-test-'));
    work = join(root, 'project');
    mkdirSync(work);
    folders = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const file = (name: string, content = 'original') => {
    const path = join(work, name);
    writeFileSync(path, content);
    return path;
  };

  /** A runner that plays the tool: writes `output` where the arguments say, or fails. */
  function runner(behave: (call: Call) => Partial<RunResult> & { write?: [string, string] }) {
    const calls: Call[] = [];
    const run = (
      path: string,
      args: readonly string[],
      options: RunOptions,
    ): Promise<RunResult> => {
      const call = { file: path, args, options };
      calls.push(call);
      const result = behave(call);
      if (result.write) {
        mkdirSync(dirname(result.write[0]), { recursive: true });
        writeFileSync(result.write[0], result.write[1]);
      }
      return Promise.resolve({
        code: result.code ?? 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      });
    };
    return { run, calls };
  }

  function deps(
    selection: string[],
    overrides: Partial<LocalDeps<string>> = {},
    caps: Capabilities = { tools, canvas: false },
  ): LocalDeps<string> {
    return {
      files: disk,
      pathOf: (path) => path,
      formats: selection.map((name) => {
        const ext = name.split('.').pop()!;
        return ext === 'jpeg' ? 'jpg' : ext;
      }),
      caps,
      trusted: true,
      questions: { existing: () => Promise.resolve('keepBoth') },
      settings: { ...DEFAULT_LOCAL_SETTINGS, timeoutMs: 60_000 },
      profile: join(root, 'profile'),
      workFolder: async () => {
        const folder = await fsp.mkdtemp(join(root, 'work-'));
        folders.push(folder);
        return folder;
      },
      ...overrides,
    };
  }

  const target = (d: LocalDeps<string>, to: string, variant: LocalTarget['variant'] = null) =>
    localTargets(
      d.formats,
      d.caps,
      d.formats.map(() => true),
    ).find((t) => t.to === to && t.variant === variant) ?? {
      to,
      variant,
      label: to,
      engine: '',
      files: [],
    };

  const go = (
    d: LocalDeps<string>,
    selection: string[],
    t: LocalTarget,
    signal = new AbortController().signal,
  ) => convertAllHere(d, selection, t, signal);

  it('runs the tool with an argument array and saves the result next to the original', async () => {
    const video = file('clip one.mp4');
    const { run, calls } = runner((call) => ({
      write: [call.args.at(-1)!.replace(/^file:/, ''), 'MP3'],
    }));
    const d = deps([video], { run });
    const [outcome] = await go(d, [video], target(d, 'mp3'));
    assert.equal(outcome!.status, 'converted', JSON.stringify(outcome));
    assert.equal(engineOf(outcome), 'FFmpeg');
    assert.equal(readFileSync(join(work, 'clip one.mp3'), 'utf8'), 'MP3');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.file, '/usr/bin/ffmpeg');
    assert.ok(calls[0]!.args.includes(`file:${video}`));
    assert.ok(calls[0]!.options.timeoutMs > 0 && calls[0]!.options.signal);
    assert.ok(
      folders.every((folder) => !existsSync(folder)),
      'the work folder is removed',
    );
    assert.equal(readFileSync(video, 'utf8'), 'original');
  });

  it('never overwrites: a taken name gets a number', async () => {
    const video = file('clip.mp4');
    file('clip.mp3', 'mine');
    const { run } = runner((call) => ({ write: [call.args.at(-1)!.replace(/^file:/, ''), 'NEW'] }));
    const d = deps([video], { run });
    await go(d, [video], target(d, 'mp3'));
    assert.equal(readFileSync(join(work, 'clip.mp3'), 'utf8'), 'mine');
    assert.equal(readFileSync(join(work, 'clip (1).mp3'), 'utf8'), 'NEW');
  });

  it('reports a failed tool with its own message, and saves nothing', async () => {
    const video = file('broken.mp4');
    const { run } = runner(() => ({
      code: 1,
      stderr: 'ffmpeg version 6.1\nfile:/w/broken.mp4: Invalid data found when processing input\n',
    }));
    const d = deps([video], { run });
    const [outcome] = await go(d, [video], target(d, 'mp3'));
    assert.equal(outcome!.status, 'failed');
    assert.equal(codeOf(outcome), 'toolFailed');
    assert.match(messageOf(outcome), /FFmpeg could not convert broken\.mp4: .*Invalid data/);
    assert.deepEqual(readdirSync(work), ['broken.mp4']);
    assert.ok(folders.every((folder) => !existsSync(folder)));
  });

  it('takes LibreOffice’s only result from its folder, and notices when there is none', async () => {
    const doc = file('report.docx');
    const outdir = (call: Call) => call.args[call.args.indexOf('--outdir') + 1]!;
    const good = runner((call) => ({ write: [join(outdir(call), 'report.pdf'), '%PDF-'] }));
    let d = deps([doc], { run: good.run });
    const [ok] = await go(d, [doc], target(d, 'pdf'));
    assert.equal(ok!.status, 'converted');
    assert.equal(readFileSync(join(work, 'report.pdf'), 'utf8'), '%PDF-');
    assert.ok(good.calls[0]!.args[0]!.startsWith('-env:UserInstallation=file://'));
    // LibreOffice ends with 0 even when it could not load the file.
    const bad = runner(() => ({ stdout: 'Error: source file could not be loaded\n' }));
    d = deps([doc], { run: bad.run });
    const [failed] = await go(d, [doc], target(d, 'pdf'));
    assert.equal(failed!.status, 'failed');
    assert.match(messageOf(failed), /made no result.*could not be loaded/);
  });

  it('makes a PDF of Markdown: Pandoc writes a Word file, LibreOffice prints it', async () => {
    const md = file('notes.md', '# Notes');
    const { run, calls } = runner((call) => {
      if (call.file === '/usr/bin/pandoc')
        return { write: [call.args[call.args.indexOf('--output') + 1]!, 'DOCX'] };
      const docx = call.args.at(-1)!;
      assert.equal(readFileSync(docx, 'utf8'), 'DOCX', 'LibreOffice gets what Pandoc wrote');
      const outdir = call.args[call.args.indexOf('--outdir') + 1]!;
      return { write: [join(outdir, 'notes.pdf'), '%PDF-'] };
    });
    const d = deps([md], { run });
    const t = target(d, 'pdf');
    assert.equal(t.engine, 'Pandoc + LibreOffice');
    const [outcome] = await go(d, [md], t);
    assert.equal(outcome!.status, 'converted', JSON.stringify(outcome));
    assert.equal(engineOf(outcome), 'Pandoc + LibreOffice');
    assert.deepEqual(
      calls.map((call) => call.file),
      ['/usr/bin/pandoc', '/usr/bin/soffice'],
    );
    assert.equal(calls[0]!.options.cwd, work, 'Pandoc finds the relative images');
    assert.equal(readFileSync(join(work, 'notes.pdf'), 'utf8'), '%PDF-');
    assert.deepEqual(readdirSync(work).sort(), ['notes.md', 'notes.pdf']);
    assert.ok(folders.every((folder) => !existsSync(folder)));
  });

  it('says which tools would make a PDF of Markdown when one of them is missing', async () => {
    const md = file('notes.md', '# Notes');
    const d = deps([md], {}, { tools: { pandoc: tools.pandoc! }, canvas: false });
    const [outcome] = await go(d, [md], {
      to: 'pdf',
      variant: null,
      label: 'PDF',
      engine: '',
      files: [0],
    });
    assert.equal(codeOf(outcome), 'noLocalConversion');
    assert.match(messageOf(outcome), /Pandoc and LibreOffice together would/);
  });

  it('keeps a smaller PDF only when it is smaller', async () => {
    const pdf = file('scan.pdf', 'x'.repeat(100));
    const output = (call: Call) => call.args.find((a) => a.startsWith('-sOutputFile='))!.slice(13);
    const small = runner((call) => ({ write: [output(call), 'small'] }));
    let d = deps([pdf], { run: small.run });
    const [ok] = await go(d, [pdf], target(d, 'pdf', 'compress'));
    assert.equal(ok!.status, 'converted');
    assert.ok(existsSync(join(work, 'scan-compressed.pdf')));
    const big = runner((call) => ({ write: [output(call), 'y'.repeat(200)] }));
    d = deps([pdf], { run: big.run });
    const [skipped] = await go(d, [pdf], target(d, 'pdf', 'compress'));
    assert.equal(skipped!.status, 'skipped');
    assert.equal(codeOf(skipped), 'notSmaller');
    assert.ok(!existsSync(join(work, 'scan-compressed (1).pdf')));
  });

  it('reads a scanned PDF: Ghostscript pages, their list, then Tesseract', async () => {
    const pdf = file('scan.pdf');
    const { run, calls } = runner((call) => {
      if (call.file.endsWith('gs')) {
        const pattern = call.args.find((a) => a.startsWith('-sOutputFile='))!.slice(13);
        writeFileSync(pattern.replace('%04d', '0002'), 'P2');
        return { write: [pattern.replace('%04d', '0001'), 'P1'] };
      }
      const list = readFileSync(call.args[0]!, 'utf8').trim().split('\n');
      assert.deepEqual(
        list.map((p) => basename(p)),
        ['page-0001.png', 'page-0002.png'],
      );
      return { write: [`${call.args[1]}.txt`, 'Converter 2026'] };
    });
    const d = deps([pdf], { run });
    const [outcome] = await go(d, [pdf], target(d, 'txt', 'ocr'));
    assert.equal(outcome!.status, 'converted', JSON.stringify(outcome));
    assert.deepEqual(
      calls.map((c) => basename(c.file)),
      ['gs', 'tesseract'],
    );
    assert.equal(readFileSync(join(work, 'scan.txt'), 'utf8'), 'Converter 2026');
  });

  it('runs nothing in Restricted Mode, and says why', async () => {
    const doc = file('report.docx');
    const { run, calls } = runner(() => ({}));
    const d = deps([doc], { run, trusted: false });
    const [outcome] = await go(d, [doc], {
      to: 'pdf',
      variant: null,
      label: 'PDF',
      engine: '',
      files: [0],
    });
    assert.equal(outcome!.status, 'skipped');
    assert.equal(codeOf(outcome), 'untrustedWorkspace');
    assert.equal(calls.length, 0);
  });

  it('skips the files the target does not apply to, saying what would convert them', async () => {
    const photo = file('IMG_1.heic');
    const json = file('data.json', '[{"a":1}]');
    const { run, calls } = runner(() => ({}));
    const d = deps([photo, json], { run });
    const outcomes = await go(d, [photo, json], target(d, 'csv'));
    assert.equal(outcomes[0]!.status, 'skipped');
    assert.equal(codeOf(outcomes[0]), 'noLocalConversion');
    assert.equal(outcomes[1]!.status, 'converted');
    assert.equal(readFileSync(join(work, 'data.csv'), 'utf8'), 'a\r\n1\r\n');
    assert.equal(calls.length, 0, 'the data conversion runs no tool');
    const jpg = await go(d, [photo, json], {
      to: 'jpg',
      variant: null,
      label: 'JPG',
      engine: '',
      files: [],
    });
    assert.match(messageOf(jpg[0]), /ImageMagick built with HEIC support/);
  });

  it('gives a file that is not on disk only the built-in conversions', async () => {
    const doc = file('report.docx');
    const d = deps([doc], { pathOf: () => null });
    const [outcome] = await go(d, [doc], {
      to: 'pdf',
      variant: null,
      label: 'PDF',
      engine: '',
      files: [0],
    });
    assert.equal(codeOf(outcome), 'notOnDisk');
  });

  it('converts images with the editor’s encoder when no tool does', async () => {
    const png = file('logo.png', 'PNG');
    const seen: string[] = [];
    const d = deps(
      [png],
      {
        canvas: (bytes, from, to) => {
          seen.push(`${Buffer.from(bytes).toString()} ${from}>${to}`);
          return Promise.resolve(new TextEncoder().encode('WEBP'));
        },
      },
      { tools: {}, canvas: true },
    );
    const [outcome] = await go(d, [png], target(d, 'webp'));
    assert.equal(engineOf(outcome), 'built in');
    assert.deepEqual(seen, ['PNG png>webp']);
    assert.equal(readFileSync(join(work, 'logo.webp'), 'utf8'), 'WEBP');
  });

  it('refuses data that is not UTF-8 instead of changing its characters', async () => {
    const csv = join(work, 'latin1.csv');
    writeFileSync(
      csv,
      Buffer.from([0x63, 0x69, 0x74, 0x79, 0x0a, 0x4d, 0xfc, 0x6e, 0x63, 0x68, 0x0a]),
    );
    const d = deps([csv]);
    const [outcome] = await go(d, [csv], target(d, 'json'));
    assert.equal(codeOf(outcome), 'invalidData');
    assert.match(messageOf(outcome), /latin1\.csv is not UTF-8 text/);
    assert.deepEqual(readdirSync(work), ['latin1.csv']);
  });

  it('reports data that cannot be read', async () => {
    const json = file('bad.json', '{nope');
    const d = deps([json]);
    const [outcome] = await go(d, [json], target(d, 'yaml'));
    assert.equal(codeOf(outcome), 'invalidData');
    assert.deepEqual(readdirSync(work), ['bad.json']);
  });

  it('stops when canceled: the tool sees the signal, nothing is saved', async () => {
    const video = file('clip.mp4');
    const controller = new AbortController();
    const run = (_path: string, _args: readonly string[], options: RunOptions) =>
      new Promise<RunResult>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () =>
          reject(new ConverterStudioError('canceled')),
        );
        setTimeout(() => controller.abort(), 10);
      });
    const d = deps([video], { run });
    const [outcome] = await go(d, [video], target(d, 'mp3'), controller.signal);
    assert.equal(codeOf(outcome), 'canceled');
    assert.deepEqual(readdirSync(work), ['clip.mp4']);
  });

  it('runs several files at once, each to its own name', async () => {
    const names = ['a.mp4', 'b.mp4', 'c.mp4'].map((name) => file(name));
    let running = 0;
    let most = 0;
    const run = async (_path: string, args: readonly string[]) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(args.at(-1)!.replace(/^file:/, ''), 'MP3');
      running--;
      return { code: 0, stdout: '', stderr: '' };
    };
    const d = deps(names, { run });
    const outcomes = await go(d, names, target(d, 'mp3'));
    assert.deepEqual(
      outcomes.map((o) => o.status),
      ['converted', 'converted', 'converted'],
    );
    assert.equal(most, 2);
    assert.deepEqual(readdirSync(work).sort(), [
      'a.mp3',
      'a.mp4',
      'b.mp3',
      'b.mp4',
      'c.mp3',
      'c.mp4',
    ]);
  });
});

describe('checkLanguages', () => {
  it('takes installed languages joined by +, and names what is missing', () => {
    checkLanguages('eng', ['eng', 'deu']);
    checkLanguages('eng+deu', ['eng', 'deu']);
    checkLanguages('fra', undefined);
    assert.throws(() => checkLanguages('eng;rm', ['eng']), /language codes/);
    assert.throws(() => checkLanguages('eng+fra', ['eng', 'deu']), /no language data for fra/);
  });
});
