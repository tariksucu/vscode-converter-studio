import * as assert from 'node:assert/strict';
import { ConverterStudioClient, partsOf, uploadName } from '../../src/client';
import { ConverterStudioError } from '../../src/errors';
import { API, KEY, SITE, apiError, client, fakeFetch, json, view } from './helpers';

const bytes = (text: string) => new TextEncoder().encode(text);
async function* streamOf(...chunks: string[]) {
  for (const chunk of chunks) yield await Promise.resolve(bytes(chunk));
}

describe('client', () => {
  it('names itself and sends the key only to the API', async () => {
    const { fetch, requests } = fakeFetch({
      'POST /api/v1/uploads': () =>
        json(
          {
            id: 'up_1',
            uploadUrl: `${SITE}/v1/uploads/up_1?token=t`,
            maxBytes: 100,
            partBytes: 50,
          },
          201,
        ),
      'PUT /api/v1/uploads/up_1': () =>
        json({ id: 'up_1', status: 'ready', file: { name: 'a.png', size: 4, format: 'png' } }),
    });
    const id = await client(fetch).upload({ fileName: 'a.png', size: 4, stream: streamOf('abcd') });
    assert.equal(id, 'up_1');
    const [slot, put] = requests;
    assert.equal(slot!.url, `${API}/v1/uploads`);
    assert.equal(slot!.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(slot!.body as string), { fileName: 'a.png', size: 4 });
    assert.equal(put!.headers.authorization, undefined, 'the upload link carries its own token');
    assert.equal(put!.headers['upload-offset'], undefined, 'one request needs no offset');
    for (const request of requests) {
      assert.equal(request.headers['x-converter-studio-client'], 'vscode/1.0.0');
      assert.equal(request.headers['user-agent'], 'vscode-converter-studio/1.0.0 VSCode/1.147.0');
    }
  });

  it('uploads a large file in parts with Upload-Offset', async () => {
    const { fetch, requests } = fakeFetch({
      'POST /api/v1/uploads': () =>
        json(
          { id: 'up_2', uploadUrl: `${SITE}/v1/uploads/up_2?token=t`, maxBytes: 100, partBytes: 4 },
          201,
        ),
      'PUT /api/v1/uploads/up_2': [
        () => json({ id: 'up_2', status: 'partial', received: 4 }),
        () => json({ id: 'up_2', status: 'partial', received: 8 }),
        () =>
          json({ id: 'up_2', status: 'ready', file: { name: 'v.mov', size: 10, format: 'mov' } }),
      ],
    });
    const sent: number[] = [];
    await client(fetch).upload({
      fileName: 'v.mov',
      size: 10,
      stream: streamOf('abc', 'defghi', 'j'),
      onProgress: (n) => sent.push(n),
    });
    const puts = requests.filter((r) => r.method === 'PUT');
    assert.deepEqual(
      puts.map((r) => r.headers['upload-offset']),
      ['0', '4', '8'],
    );
    assert.deepEqual(
      puts.map((r) => new TextDecoder().decode(r.body as Uint8Array)),
      ['abcd', 'efgh', 'ij'],
    );
    assert.deepEqual(sent, [4, 8, 10]);
  });

  it('fails when the server received fewer bytes than the file has', async () => {
    const { fetch } = fakeFetch({
      'POST /api/v1/uploads': () =>
        json(
          { id: 'up_3', uploadUrl: `${SITE}/v1/uploads/up_3?token=t`, maxBytes: 100, partBytes: 4 },
          201,
        ),
      'PUT /api/v1/uploads/up_3': () => json({ id: 'up_3', status: 'partial', received: 2 }),
    });
    await assert.rejects(
      client(fetch).upload({ fileName: 'v.mov', size: 10, stream: streamOf('abcdefghij') }),
      (error: ConverterStudioError) => error.code === 'uploadIncomplete',
    );
  });

  it('sends the Idempotency-Key and maxCredits with a conversion, the same on a retry', async () => {
    const { fetch, requests } = fakeFetch({
      'POST /api/v1/conversions': [
        () => apiError(503, 'serverBusy', 'Busy.'),
        () => json(view({ status: 'queued' }), 201),
      ],
    });
    const started = await client(fetch).start({
      uploadId: 'up_1',
      to: 'txt',
      options: { ocr: true },
      maxCredits: 5,
      idempotencyKey: 'key-1',
    });
    assert.equal(started.status, 'queued');
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.headers['idempotency-key'], 'key-1');
      assert.deepEqual(JSON.parse(request.body as string), {
        uploadId: 'up_1',
        to: 'txt',
        options: { ocr: true },
        maxCredits: 5,
      });
    }
  });

  it('waits Retry-After seconds when rate limited', async () => {
    const waits: number[] = [];
    const { fetch } = fakeFetch({
      'GET /api/v1/account': [
        () => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }),
        () => json({ plan: 'pro', credits: 10, allowance: null, renewsAt: null, maxFileBytes: 1 }),
      ],
    });
    const api = new ConverterStudioClient({
      apiKey: KEY,
      apiUrl: API,
      version: '1.0.0',
      fetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    const account = await api.account();
    assert.equal(account.credits, 10);
    assert.deepEqual(waits, [7000]);
  });

  it("shows the API's message for a wrong key and does not retry it", async () => {
    const { fetch, requests } = fakeFetch({
      'GET /api/v1/account': () =>
        apiError(
          401,
          'invalidApiKey',
          'This API key does not work. Make a new one in your account.',
        ),
    });
    await assert.rejects(client(fetch).account(), (error: ConverterStudioError) => {
      assert.equal(error.code, 'invalidApiKey');
      assert.equal(error.message, 'This API key does not work. Make a new one in your account.');
      assert.ok(!error.message.includes(KEY));
      return true;
    });
    assert.equal(requests.length, 1);
  });

  it('names errors without a JSON body by their status', async () => {
    const { fetch } = fakeFetch({
      'GET /api/v1/account': () => new Response('<html>Bad gateway</html>', { status: 401 }),
    });
    await assert.rejects(client(fetch).account(), { code: 'invalidApiKey' });
  });

  it('reads the formats without a key', async () => {
    const { fetch, requests } = fakeFetch({
      'GET /api/v1/formats': () =>
        json({
          formats: [
            { id: 'png', name: 'PNG', category: 'image', extensions: ['png'], to: ['jpg'] },
          ],
        }),
    });
    const formats = await client(fetch, null).formats();
    assert.equal(formats[0]!.id, 'png');
    assert.equal(requests[0]!.headers.authorization, undefined);
  });

  it('asks for a key before any call that needs one', async () => {
    const { fetch, requests } = fakeFetch({});
    await assert.rejects(client(fetch, null).account(), { code: 'noApiKey' });
    assert.equal(requests.length, 0);
  });

  it('long-polls until the conversion settles', async () => {
    const updates: string[] = [];
    const { fetch, requests } = fakeFetch({
      'GET /api/v1/conversions/job_1': [
        () => json(view({ status: 'processing', progress: 0.5 })),
        () => json(view({ status: 'done', downloadUrl: `${SITE}/jobs/job_1/download?token=x` })),
      ],
    });
    const done = await client(fetch).settle(view({ status: 'queued' }), {
      timeoutMs: 120_000,
      onUpdate: (v) => updates.push(v.status),
    });
    assert.equal(done.status, 'done');
    assert.deepEqual(updates, ['processing', 'done']);
    assert.match(requests[0]!.url, /\?wait=50$/);
  });

  it('stops at a quote', async () => {
    const { fetch } = fakeFetch({
      'GET /api/v1/conversions/job_1': () => json(view({ status: 'quoted', credits: 30 })),
    });
    const quoted = await client(fetch).settle(view({ status: 'measuring' }), { timeoutMs: 60_000 });
    assert.equal(quoted.status, 'quoted');
  });

  it('turns a canceled signal into canceled, without retrying', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, requests } = fakeFetch({});
    await assert.rejects(client(fetch).account(controller.signal), { code: 'canceled' });
    assert.equal(requests.length, 0);
  });

  it('retries a lost connection, then reports it', async () => {
    let calls = 0;
    const api = client(() => {
      calls++;
      return Promise.reject(new TypeError('fetch failed'));
    });
    await assert.rejects(api.account(), { code: 'network' });
    assert.equal(calls, 4);
  });

  it('trims the API address', () => {
    const api = new ConverterStudioClient({ apiUrl: ' https://x.test/api/// ', version: '1' });
    assert.equal(api.apiUrl, 'https://x.test/api');
  });
});

describe('uploadName and partsOf', () => {
  it('keeps names short with their extension', () => {
    const long = `${'a'.repeat(300)}.heic`;
    const name = uploadName(long);
    assert.equal(name.length, 255);
    assert.ok(name.endsWith('.heic'));
    assert.equal(uploadName(' \u0007 '), 'file');
  });

  it('cuts a stream into parts', async () => {
    const parts: string[] = [];
    for await (const part of partsOf(streamOf('ab', 'cdefg', '', 'h'), 3))
      parts.push(new TextDecoder().decode(part));
    assert.deepEqual(parts, ['abc', 'def', 'gh']);
  });
});
