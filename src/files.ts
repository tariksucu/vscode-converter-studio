import { randomBytes } from 'node:crypto';
import { createReadStream, promises as fsp } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';
import type { FileAccess } from './convert';

/**
 * Files through VS Code: local files (also on a remote machine, where the extension runs next to
 * them) are streamed with Node, so a large video never sits whole in memory; files of other file
 * systems go through `workspace.fs`.
 */

class ExistsError extends Error {
  readonly exists = true;
}

const isLocal = (uri: vscode.Uri) => uri.scheme === 'file';

export const vscodeFiles: FileAccess<vscode.Uri> = {
  name: (uri) => posix.basename(uri.path),

  sibling: (uri, name) => uri.with({ path: posix.join(posix.dirname(uri.path), name) }),

  async size(uri) {
    return (await vscode.workspace.fs.stat(uri)).size;
  },

  read(uri, signal) {
    if (isLocal(uri)) return createReadStream(uri.fsPath, { signal });
    return (async function* () {
      yield await vscode.workspace.fs.readFile(uri);
    })();
  },

  async exists(uri) {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  },

  async write(uri, body, { overwrite, signal }) {
    if (!isLocal(uri)) {
      if (!overwrite && (await vscodeFiles.exists(uri))) throw new ExistsError(uri.path);
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) {
        if (signal.aborted) throw new Error('aborted');
        chunks.push(chunk);
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.concat(chunks));
      return;
    }
    // A new file is created only if the name is free ('wx'), before the body is read; an
    // overwrite goes to a hidden file first and replaces the old one only once it is complete.
    const final = uri.fsPath;
    const path = overwrite
      ? join(dirname(final), `.${basename(final)}.${randomBytes(4).toString('hex')}.part`)
      : final;
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(path, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExistsError(final);
      throw error;
    }
    try {
      await pipeline(Readable.from(body), handle.createWriteStream(), { signal });
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fsp.rm(path, { force: true });
      throw error;
    }
    await handle.close().catch(() => undefined);
    if (overwrite) await fsp.rename(path, final);
  },
};
