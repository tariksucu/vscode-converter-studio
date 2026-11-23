import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { ConverterStudioError } from './errors';
import type { ImageConverter } from './local';

/**
 * Common images converted with the editor's own image decoder and encoder (Chromium's, in a
 * webview): PNG, JPG, WebP, GIF, BMP, AVIF, ICO and SVG to PNG, JPG or WebP. The webview has no
 * network and no file access; the bytes go in and out as messages. It is open only while a batch
 * converts.
 */

const MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

/** Quality of the lossy encoders (0 to 1). */
const QUALITY: Readonly<Record<string, number>> = { jpg: 0.9, webp: 0.85 };

/** The bytes as an ArrayBuffer of exactly their length (a Node buffer is a view into a pool). */
const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** What came back from the webview: an ArrayBuffer (or a view of one). */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

interface Reply {
  id?: number;
  ready?: boolean;
  ok?: boolean;
  bytes?: unknown;
  message?: string;
}

function page(nonce: string): string {
  // The image is drawn as it is: an SVG is read as an image (no scripts, nothing loaded), a JPG
  // gets a white background where the original is transparent.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:1em}</style>
</head>
<body>
<p>Converter Studio is converting images on this computer. This tab closes by itself.</p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
async function decode(blob, svg) {
  if (!svg) return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
window.addEventListener('message', async (event) => {
  const { id, bytes, from, to, quality } = event.data;
  try {
    const source = await decode(new Blob([bytes], { type: from }), from === 'image/svg+xml');
    let width = source.naturalWidth || source.width;
    let height = source.naturalHeight || source.height;
    if (!width || !height) { width = 512; height = 512; }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (to === 'image/jpeg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); }
    context.drawImage(source, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, to, quality));
    if (!blob) throw new Error('the image could not be encoded');
    // A canvas that cannot write a format writes PNG instead: say so rather than mislabel it.
    if (blob.type !== to) throw new Error('this editor cannot write ' + to);
    vscode.postMessage({ id, ok: true, bytes: await blob.arrayBuffer() });
  } catch (error) {
    vscode.postMessage({ id, ok: false, message: String((error && error.message) || error) });
  }
});
vscode.postMessage({ ready: true });
</script>
</body>
</html>`;
}

/**
 * An image converter for one batch: the webview opens on the first image and closes with
 * `dispose()`.
 */
export function canvasConverter(): ImageConverter & { dispose(): void } {
  let panel: vscode.WebviewPanel | null = null;
  let ready: Promise<void> | null = null;
  let next = 0;
  const waiting = new Map<
    number,
    { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }
  >();
  let closed: Error | null = null;

  const open = () => {
    if (ready) return ready;
    ready = new Promise<void>((resolve, reject) => {
      panel = vscode.window.createWebviewPanel(
        'converterStudio.images',
        'Converter Studio: converting images',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
        { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true },
      );
      panel.webview.html = page(randomBytes(16).toString('base64'));
      const timer = setTimeout(
        () =>
          reject(
            new ConverterStudioError(
              'imageUnreadable',
              'The editor did not open its image converter.',
            ),
          ),
        30_000,
      );
      panel.webview.onDidReceiveMessage((reply: Reply) => {
        if (reply.ready) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const job = reply.id === undefined ? undefined : waiting.get(reply.id);
        if (!job) return;
        waiting.delete(reply.id!);
        const out = reply.ok ? asBytes(reply.bytes) : null;
        if (out) job.resolve(out);
        else
          job.reject(
            new ConverterStudioError(
              'imageUnreadable',
              `The image could not be converted: ${reply.message ?? 'unknown error'}.`,
            ),
          );
      });
      panel.onDidDispose(() => {
        clearTimeout(timer);
        closed = new ConverterStudioError('canceled', 'The image converter tab was closed.');
        for (const job of waiting.values()) job.reject(closed);
        waiting.clear();
        reject(closed);
      });
    });
    return ready;
  };

  const convert: ImageConverter = async (bytes, from, to, signal) => {
    const fromType = MIME[from];
    const toType = MIME[to];
    if (!fromType || !toType) throw new ConverterStudioError('noLocalConversion');
    if (closed) throw closed;
    await open();
    if (signal.aborted) throw new ConverterStudioError('canceled');
    const id = next++;
    return new Promise<Uint8Array>((resolve, reject) => {
      const onAbort = () => {
        waiting.delete(id);
        reject(new ConverterStudioError('canceled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.set(id, {
        resolve: (out) => {
          signal.removeEventListener('abort', onAbort);
          resolve(out);
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      void panel!.webview.postMessage({
        id,
        bytes: exactBuffer(bytes),
        from: fromType,
        to: toType,
        quality: QUALITY[to],
      });
    });
  };

  return Object.assign(convert, {
    dispose() {
      const current = panel;
      panel = null;
      current?.dispose();
    },
  });
}
