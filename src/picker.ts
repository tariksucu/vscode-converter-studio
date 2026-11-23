import { filesText, type Target } from './formats';
import type { LocalTarget, Variant } from './recipes';

/**
 * The rows of the format picker, kept apart from VS Code so the unit tests can read them. Each
 * target says where it runs: on this computer first (the default), then the desktop app when it
 * is turned on, then the cloud, which says that it uploads the file and uses credits.
 */

export type Where = 'local' | 'desktop' | 'cloud';

export interface Choice {
  where: Where;
  to: string;
  label: string;
  variant: Variant | null;
  options?: Record<string, unknown>;
  /** The files it applies to (indexes into the selection). */
  files: number[];
}

export type Action = 'showTools' | 'manageTrust';

export interface Row {
  kind: 'separator' | 'choice' | 'action';
  label: string;
  description?: string;
  choice?: Choice;
  action?: Action;
}

export const WHERE_TEXT: Readonly<Record<Where, string>> = {
  local: '$(device-desktop) on this computer',
  desktop: '$(link-external) in the desktop app',
  cloud: '$(cloud-upload) in the cloud: uploads, uses credits',
};

export interface PickerInput {
  /** How many files are selected. */
  total: number;
  local: readonly LocalTarget[];
  /** The desktop app's targets; null when the desktop app is turned off or cannot be used. */
  desktop: readonly Target[] | null;
  /** The cloud's targets; `loading` while they are read; null when the cloud is turned off. */
  cloud: readonly Target[] | 'loading' | 'failed' | null;
  trusted: boolean;
  /** The files are on another machine (SSH, WSL, a container). */
  remote: boolean;
  /** The names of the tools found (`FFmpeg`, `Pandoc`). */
  toolsFound: readonly string[];
}

const partOf = (files: number, total: number) =>
  files < total ? `${files} of ${filesText(total)}` : '';
const joined = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(' · ');

export function pickerRows(input: PickerInput): Row[] {
  const rows: Row[] = [];
  const here = input.remote ? 'On the remote machine' : 'On this computer';
  rows.push({ kind: 'separator', label: `${here}: nothing is uploaded` });
  const localWhere = input.remote ? '$(remote) on the remote machine' : WHERE_TEXT.local;
  for (const target of input.local)
    rows.push({
      kind: 'choice',
      label: target.label,
      description: joined(localWhere, target.engine, partOf(target.files.length, input.total)),
      choice: {
        where: 'local',
        to: target.to,
        label: target.label,
        variant: target.variant,
        ...(target.options ? { options: target.options } : {}),
        files: target.files,
      },
    });
  if (input.local.length === 0) {
    if (!input.trusted)
      rows.push({
        kind: 'action',
        label: '$(shield) Tools on this computer are off in Restricted Mode',
        description: 'Manage Workspace Trust',
        action: 'manageTrust',
      });
    else
      rows.push({
        kind: 'action',
        label: `$(info) Nothing ${input.remote ? 'there' : 'here'} converts ${input.total === 1 ? 'this file' : 'these files'}`,
        description: 'See which tools would',
        action: 'showTools',
      });
  }

  if (input.desktop) {
    rows.push({
      kind: 'separator',
      label: 'Converter Studio for desktop: you press Convert there',
    });
    for (const target of input.desktop)
      rows.push({
        kind: 'choice',
        label: target.label,
        description: joined(WHERE_TEXT.desktop, partOf(target.files.length, input.total)),
        choice: {
          where: 'desktop',
          to: target.to,
          label: target.label,
          variant: null,
          files: target.files,
        },
      });
  }

  if (input.cloud) {
    rows.push({
      kind: 'separator',
      label: 'In the cloud: uploads to converter.studio, uses credits',
    });
    if (input.cloud === 'loading')
      rows.push({ kind: 'separator', label: 'Reading the formats Converter Studio offers…' });
    else if (input.cloud === 'failed')
      rows.push({ kind: 'separator', label: 'The cloud’s formats could not be read (offline?)' });
    else
      for (const target of input.cloud) {
        const variant: Variant | null = target.options?.ocr === true ? 'ocr' : null;
        rows.push({
          kind: 'choice',
          label: target.label,
          description: joined(
            WHERE_TEXT.cloud,
            target.description,
            partOf(target.files.length, input.total),
          ),
          choice: {
            where: 'cloud',
            to: target.to,
            label: target.label,
            variant,
            ...(target.options ? { options: target.options } : {}),
            files: target.files,
          },
        });
      }
  }

  rows.push({ kind: 'separator', label: '' });
  rows.push({
    kind: 'action',
    label: '$(tools) Tools on this computer…',
    description: input.trusted
      ? input.toolsFound.length > 0
        ? `found: ${input.toolsFound.join(', ')}`
        : 'none found'
      : 'off in Restricted Mode',
    action: 'showTools',
  });
  return rows;
}

/** The row the picker starts on: the first conversion on this computer, never a cloud one. */
export function firstRow(rows: readonly Row[]): number {
  const local = rows.findIndex((row) => row.choice?.where === 'local');
  if (local >= 0) return local;
  return rows.findIndex((row) => row.kind === 'action');
}
