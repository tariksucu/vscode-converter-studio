import type { ConversionView, FetchLike, FormatInfo } from '../../src/client';
import { ConverterStudioClient } from '../../src/client';
import type { FileAccess } from '../../src/convert';

/** A fake Converter Studio API: routes by method and path, records every request. */

export const API = 'https://api.test/api';
export const SITE = 'https://site.test/api';
export const KEY = 'cvs_live_test_key_123';

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | string | null;
}

type Handler = (request: Recorded) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const apiError = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

export function fakeFetch(routes: Record<string, Handler | Handler[]>) {
  const requests: Recorded[] = [];
  const counters = new Map<string, number>();
  const fetch: FetchLike = async (input, init) => {
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers as Record<string, string>) ?? {}))
      headers[name.toLowerCase()] = value;
    const body = init?.body as Uint8Array | string | undefined;
    const request: Recorded = { method, url: input, headers, body: body ?? null };
    requests.push(request);
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const path = new URL(input).pathname;
    const key = `${method} ${path}`;
    const match = Object.entries(routes).find(([pattern]) => new RegExp(`^${pattern}$`).test(key));
    if (!match) return apiError(404, 'notFound', `No route for ${key}`);
    const handlers = Array.isArray(match[1]) ? match[1] : [match[1]];
    const n = counters.get(match[0]) ?? 0;
    counters.set(match[0], n + 1);
    return handlers[Math.min(n, handlers.length - 1)]!(request);
  };
  return { fetch, requests };
}

/** A client of the fake API; `null` for one without a key. */
export const client = (fetch: FetchLike, apiKey: string | null = KEY) =>
  new ConverterStudioClient({
    apiKey: apiKey ?? undefined,
    apiUrl: API,
    version: '1.0.0',
    host: 'VSCode/1.147.0',
    fetch,
    sleep: () => Promise.resolve(),
  });

export const view = (fields: Partial<ConversionView>): ConversionView => ({
  id: 'job_1',
  status: 'queued',
  from: 'png',
  to: 'webp',
  inputName: 'image.png',
  inputSize: 4,
  credits: 1,
  maxCredits: 20,
  progress: null,
  outputName: null,
  outputSize: null,
  downloadUrl: null,
  expiresAt: null,
  error: null,
  ...fields,
});

/** Routes for a conversion that goes well: upload, convert, done, download. */
export function happyRoutes(
  options: { outputName?: string; credits?: number; result?: string } = {},
) {
  const done = view({
    status: 'done',
    credits: options.credits ?? 1,
    outputName: options.outputName ?? 'image.webp',
    outputSize: (options.result ?? 'WEBP').length,
    downloadUrl: `${SITE}/jobs/job_1/download?token=dl`,
  });
  return {
    'POST /api/v1/uploads': () =>
      json(
        {
          id: 'up_1',
          uploadUrl: `${SITE}/v1/uploads/up_1?token=up`,
          maxBytes: 1e9,
          partBytes: 1e6,
        },
        201,
      ),
    'PUT /api/v1/uploads/up_1': (request: Recorded) =>
      json({
        id: 'up_1',
        status: 'ready',
        file: { name: 'image.png', size: (request.body as Uint8Array).byteLength, format: 'png' },
      }),
    'POST /api/v1/conversions': () => json(view({ status: 'processing' }), 201),
    'GET /api/v1/conversions/job_1': () => json(done),
    'GET /api/jobs/job_1/download': () =>
      new Response(options.result ?? 'WEBP', { headers: { 'content-length': '4' } }),
  };
}

/** A small in-memory file system over paths like `/work/image.png`. */
export function memoryFiles(initial: Record<string, string>) {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, text]) => [path, new TextEncoder().encode(text)]),
  );
  const access: FileAccess<string> = {
    name: (path) => path.slice(path.lastIndexOf('/') + 1),
    sibling: (path, name) => `${path.slice(0, path.lastIndexOf('/'))}/${name}`,
    size: (path) => {
      const bytes = files.get(path);
      return bytes ? Promise.resolve(bytes.byteLength) : Promise.reject(new Error('ENOENT'));
    },
    read: (path) =>
      (async function* () {
        yield await Promise.resolve(files.get(path)!);
      })(),
    exists: (path) => Promise.resolve(files.has(path)),
    async write(path, body, { overwrite }) {
      if (!overwrite && files.has(path)) throw Object.assign(new Error('exists'), { exists: true });
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      files.set(path, Buffer.concat(chunks));
    },
  };
  const text = (path: string) => {
    const bytes = files.get(path);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  };
  return { access, files, text };
}

/** A part of the real catalogue (`GET /v1/formats` on the local stack, 2026-11-23). */
export const CATALOGUE: FormatInfo[] = [
  { id: 'tar', name: 'TAR', category: 'archive', extensions: ['tar'], to: ['zip', 'tgz'] },
  {
    id: 'tgz',
    name: 'TAR.GZ',
    category: 'archive',
    extensions: ['tar.gz', 'tgz'],
    to: ['zip', 'tar'],
  },
  {
    id: 'docx',
    name: 'DOCX',
    category: 'document',
    extensions: ['docx'],
    to: ['pdf', 'epub', 'txt', 'doc', 'html', 'odt', 'md', 'rtf'],
  },
  {
    id: 'pdf',
    name: 'PDF',
    category: 'document',
    extensions: ['pdf'],
    to: ['jpg', 'pdf', 'docx', 'png', 'epub', 'webp', 'txt', 'tiff'],
  },
  {
    id: 'heic',
    name: 'HEIC',
    category: 'image',
    extensions: ['heic', 'heif'],
    to: ['jpg', 'pdf', 'png', 'docx', 'gif', 'webp', 'txt', 'ico', 'avif', 'tiff', 'bmp'],
  },
  {
    id: 'jpg',
    name: 'JPG',
    category: 'image',
    extensions: ['jpg', 'jpeg', 'jpe', 'jfif'],
    to: ['pdf', 'png', 'docx', 'gif', 'webp', 'txt', 'ico', 'avif', 'tiff', 'bmp'],
  },
  {
    id: 'png',
    name: 'PNG',
    category: 'image',
    extensions: ['png'],
    to: ['jpg', 'pdf', 'docx', 'gif', 'webp', 'txt', 'ico', 'avif', 'tiff', 'bmp'],
  },
  {
    id: 'webp',
    name: 'WebP',
    category: 'image',
    extensions: ['webp'],
    to: ['jpg', 'png', 'gif', 'avif'],
  },
  { id: 'avif', name: 'AVIF', category: 'image', extensions: ['avif'], to: ['jpg', 'png', 'webp'] },
  {
    id: 'svg',
    name: 'SVG',
    category: 'vector',
    extensions: ['svg'],
    to: ['jpg', 'pdf', 'png', 'webp', 'eps'],
  },
  { id: 'mp3', name: 'MP3', category: 'audio', extensions: ['mp3'], to: ['wav', 'm4a', 'ogg'] },
];
