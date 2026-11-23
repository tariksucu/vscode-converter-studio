import * as assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  convertAll,
  type ConvertDeps,
  type ExistingChoice,
  type Outcome,
} from '../../src/convert';
import type { Target } from '../../src/formats';
import { SITE, apiError, client, fakeFetch, happyRoutes, json, memoryFiles, view } from './helpers';

const webp: Target = { to: 'webp', label: 'WebP', files: [0], suggested: true };

function deps(
  fetch: Parameters<typeof client>[0],
  files: ReturnType<typeof memoryFiles>,
  overrides: Partial<ConvertDeps<string>> = {},
): ConvertDeps<string> & { asked: string[] } {
  const asked: string[] = [];
  return {
    client: client(fetch),
    files: files.access,
    questions: {
      confirmCost: (name, credits) => {
        asked.push(`cost ${name} ${credits}`);
        return Promise.resolve(true);
      },
      existing: (name) => {
        asked.push(`exists ${name}`);
        return Promise.resolve('keepBoth' as ExistingChoice);
      },
    },
    settings: { ...DEFAULT_SETTINGS },
    newKey: () => 'idem-1',
    asked,
    ...overrides,
  };
}

const run = (d: ConvertDeps<string>, selection: string[], target = webp, signal?: AbortSignal) =>
  convertAll(d, selection, target, signal ?? new AbortController().signal);

describe('convertAll', () => {
  it('uploads, converts and saves the result next to the original', async () => {
    const files = memoryFiles({ '/w/image.png': 'PNG!' });
    const { fetch, requests } = fakeFetch(happyRoutes());
    const stages: string[] = [];
    const outcomes = await run(deps(fetch, files, { onStage: (_i, stage) => stages.push(stage) }), [
      '/w/image.png',
    ]);
    assert.deepEqual(outcomes, [
      { status: 'converted', file: '/w/image.png', result: '/w/image.webp', credits: 1 },
    ]);
    assert.equal(files.text('/w/image.webp'), 'WEBP');
    assert.equal(files.text('/w/image.png'), 'PNG!', 'the original stays');
    const start = requests.find((r) => r.method === 'POST' && r.url.endsWith('/v1/conversions'))!;
    assert.equal(start.headers['idempotency-key'], 'idem-1');
    assert.deepEqual(JSON.parse(start.body as string), {
      uploadId: 'up_1',
      to: 'webp',
      maxCredits: 20,
    });
    const download = requests.find((r) => r.url.includes('/download'))!;
    assert.equal(
      download.headers.authorization,
      undefined,
      'the download link carries its own token',
    );
    assert.deepEqual([...new Set(stages)], ['uploading', 'converting', 'downloading']);
  });

  it('sends the options of a choice (text with OCR)', async () => {
    const files = memoryFiles({ '/w/scan.pdf': '%PDF' });
    const { fetch, requests } = fakeFetch(happyRoutes({ outputName: 'scan.txt', result: 'Hello' }));
    const ocr: Target = {
      to: 'txt',
      label: 'Text',
      options: { ocr: true },
      files: [0],
      suggested: true,
    };
    const [outcome] = await run(deps(fetch, files), ['/w/scan.pdf'], ocr);
    assert.equal(outcome?.status, 'converted');
    assert.equal(files.text('/w/scan.txt'), 'Hello');
    const start = requests.find((r) => r.method === 'POST' && r.url.endsWith('/v1/conversions'))!;
    assert.deepEqual((JSON.parse(start.body as string) as { options?: unknown }).options, {
      ocr: true,
    });
  });

  it('never overwrites: a taken name gets a number', async () => {
    const files = memoryFiles({
      '/w/image.png': 'PNG!',
      '/w/image.webp': 'OLD',
      '/w/image (1).webp': 'OLD',
    });
    const { fetch } = fakeFetch(happyRoutes());
    const d = deps(fetch, files);
    const [outcome] = await run(d, ['/w/image.png']);
    assert.equal(outcome?.status === 'converted' && outcome.result, '/w/image (2).webp');
    assert.equal(files.text('/w/image.webp'), 'OLD');
    assert.deepEqual(d.asked, []);
  });

  it('asks about a taken name when set to, and overwrites only when told', async () => {
    for (const [choice, expected] of [
      ['overwrite', 'WEBP'],
      ['skip', 'OLD'],
    ] as const) {
      const files = memoryFiles({ '/w/image.png': 'PNG!', '/w/image.webp': 'OLD' });
      const { fetch } = fakeFetch(happyRoutes());
      const d = deps(fetch, files, {
        settings: { ...DEFAULT_SETTINGS, existingFiles: 'ask' },
        questions: {
          confirmCost: () => Promise.resolve(true),
          existing: () => Promise.resolve(choice),
        },
      });
      const [outcome] = await run(d, ['/w/image.png']);
      assert.equal(files.text('/w/image.webp'), expected);
      assert.equal(outcome?.status, choice === 'skip' ? 'skipped' : 'converted');
    }
  });

  it('asks before a conversion that costs more than the limit, and confirms it', async () => {
    const files = memoryFiles({ '/w/clip.mov': 'MOV' });
    const routes = happyRoutes({ outputName: 'clip.mp4', credits: 30 });
    const { fetch, requests } = fakeFetch({
      ...routes,
      'GET /api/v1/conversions/job_1': [
        () => json(view({ status: 'quoted', credits: 30, maxCredits: 20 })),
        routes['GET /api/v1/conversions/job_1'],
      ],
      'POST /api/v1/conversions/job_1/confirm': () => json(view({ status: 'queued', credits: 30 })),
    });
    const d = deps(fetch, files);
    const [outcome] = await run(d, ['/w/clip.mov'], { ...webp, to: 'mp4', label: 'MP4' });
    assert.deepEqual(d.asked, ['cost clip.mov 30']);
    assert.equal(outcome?.status === 'converted' && outcome.credits, 30);
    assert.ok(requests.some((r) => r.url.endsWith('/v1/conversions/job_1/confirm')));
  });

  it('leaves a quoted conversion unconfirmed when the answer is no', async () => {
    const files = memoryFiles({ '/w/clip.mov': 'MOV' });
    const { fetch, requests } = fakeFetch({
      ...happyRoutes(),
      'GET /api/v1/conversions/job_1': () => json(view({ status: 'quoted', credits: 30 })),
    });
    const d = deps(fetch, files, {
      questions: {
        confirmCost: () => Promise.resolve(false),
        existing: () => Promise.resolve('skip'),
      },
    });
    const [outcome] = await run(d, ['/w/clip.mov']);
    assert.equal(outcome?.status, 'skipped');
    assert.equal(outcome.error.code, 'declined');
    assert.ok(!requests.some((r) => r.url.endsWith('/confirm')));
  });

  it("reports a failed conversion with the API's own message", async () => {
    const files = memoryFiles({ '/w/broken.png': 'nope' });
    const { fetch } = fakeFetch({
      ...happyRoutes(),
      'GET /api/v1/conversions/job_1': () =>
        json(
          view({
            status: 'failed',
            error: {
              code: 'conversionFailed',
              message: 'The file could not be converted. No credits were used.',
            },
          }),
        ),
    });
    const [outcome] = await run(deps(fetch, files), ['/w/broken.png']);
    assert.equal(outcome?.status, 'failed');
    if (outcome?.status !== 'failed') return;
    assert.equal(outcome.error.code, 'conversionFailed');
    assert.equal(outcome.error.message, 'The file could not be converted. No credits were used.');
    assert.deepEqual([...files.files.keys()], ['/w/broken.png'], 'nothing saved');
  });

  it('skips files the target does not apply to', async () => {
    const files = memoryFiles({ '/w/a.png': 'A', '/w/song.mp3': 'B' });
    const { fetch } = fakeFetch(happyRoutes({ outputName: 'a.webp' }));
    const outcomes = await run(deps(fetch, files), ['/w/a.png', '/w/song.mp3']);
    assert.equal(outcomes[0]?.status, 'converted');
    const song = outcomes[1];
    assert.equal(song?.status, 'skipped');
    assert.equal(song.error.code, 'unsupportedTarget');
  });

  it('does not send the other files after a wrong key', async () => {
    const files = memoryFiles({ '/w/1.png': '1', '/w/2.png': '2', '/w/3.png': '3' });
    const { fetch, requests } = fakeFetch({
      'POST /api/v1/uploads': () => apiError(401, 'invalidApiKey', 'This API key does not work.'),
    });
    const target: Target = { ...webp, files: [0, 1, 2] };
    const d = deps(fetch, files, { settings: { ...DEFAULT_SETTINGS, concurrency: 1 } });
    const outcomes = await run(d, ['/w/1.png', '/w/2.png', '/w/3.png'], target);
    assert.deepEqual(
      outcomes.map((o: Outcome<string>) => [
        o.status,
        o.status === 'converted' ? '' : o.error.code,
      ]),
      [
        ['failed', 'invalidApiKey'],
        ['skipped', 'invalidApiKey'],
        ['skipped', 'invalidApiKey'],
      ],
    );
    assert.equal(requests.length, 1);
  });

  it('converts several files at once, each to its own name', async () => {
    const files = memoryFiles({
      '/w/a.png': 'A',
      '/w/b.png': 'B',
      '/w/c.png': 'C',
      '/w/d.png': 'D',
    });
    let id = 0;
    let running = 0;
    let most = 0;
    const { fetch } = fakeFetch({
      'POST /api/v1/uploads': () => {
        id++;
        return json(
          {
            id: `up_${id}`,
            uploadUrl: `${SITE}/v1/uploads/up_${id}?token=t`,
            maxBytes: 9,
            partBytes: 9,
          },
          201,
        );
      },
      'PUT /api/v1/uploads/up_\\d': (r) => {
        running++;
        most = Math.max(most, running);
        return json({
          id: r.url.split('/').pop()!.split('?')[0],
          status: 'ready',
          file: { name: 'x', size: 1, format: 'png' },
        });
      },
      'POST /api/v1/conversions': (r) => {
        const upload = (JSON.parse(r.body as string) as { uploadId: string }).uploadId;
        return json(view({ id: upload.replace('up', 'job'), status: 'queued' }), 201);
      },
      'GET /api/v1/conversions/job_\\d': async (r) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        running--;
        const job = r.url.split('/').pop()!.split('?')[0]!;
        return json(
          view({ id: job, status: 'done', downloadUrl: `${SITE}/jobs/${job}/download?token=x` }),
        );
      },
      'GET /api/jobs/job_\\d/download': (r) => new Response(`converted ${r.url.split('/')[5]}`),
    });
    const target: Target = { ...webp, files: [0, 1, 2, 3] };
    const outcomes = await run(
      deps(fetch, files),
      ['/w/a.png', '/w/b.png', '/w/c.png', '/w/d.png'],
      target,
    );
    assert.ok(outcomes.every((o) => o.status === 'converted'));
    assert.deepEqual(
      outcomes.map((o) => (o.status === 'converted' ? o.result : '')),
      ['/w/a.webp', '/w/b.webp', '/w/c.webp', '/w/d.webp'],
    );
    assert.ok(most > 1 && most <= 3, `at most 3 at once (was ${most})`);
  });

  it('stops when canceled and saves nothing', async () => {
    const files = memoryFiles({ '/w/a.png': 'A' });
    const controller = new AbortController();
    const { fetch } = fakeFetch({
      ...happyRoutes(),
      'GET /api/v1/conversions/job_1': () => {
        controller.abort();
        return json(view({ status: 'processing' }));
      },
    });
    const [outcome] = await run(deps(fetch, files), ['/w/a.png'], webp, controller.signal);
    assert.equal(outcome?.status !== 'converted' && outcome?.error.code, 'canceled');
    assert.deepEqual([...files.files.keys()], ['/w/a.png']);
  });

  it('refuses an empty file without calling the API', async () => {
    const files = memoryFiles({ '/w/empty.png': '' });
    const { fetch, requests } = fakeFetch({});
    const [outcome] = await run(deps(fetch, files), ['/w/empty.png']);
    assert.equal(outcome?.status !== 'converted' && outcome?.error.code, 'sourceEmpty');
    assert.equal(requests.length, 0);
  });
});
