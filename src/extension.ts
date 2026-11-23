import { constants as fsConstants, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { canvasConverter } from './canvas';
import { ConverterStudioClient, DEFAULT_API_URL, type FormatInfo } from './client';
import {
  DEFAULT_SETTINGS,
  convertAll,
  type ConvertSettings,
  type ExistingChoice,
  type Outcome,
  type Questions,
  type Stage,
} from './convert';
import { DESKTOP_APP, DESKTOP_PAGE, desktopLimitProblem, desktopLinks } from './desktop';
import { ConverterStudioError, asConverterStudioError } from './errors';
import { vscodeFiles } from './files';
import { filesText, formatOfName, targetsFor, type Target } from './formats';
import { knownFormatOf } from './known';
import {
  DEFAULT_LOCAL_SETTINGS,
  convertAllHere,
  type LocalSettings,
  type LocalStage,
} from './local';
import { firstRow, pickerRows, type Choice, type Row } from './picker';
import {
  EVERYTHING,
  localTargets,
  targetLabel,
  type Capabilities,
  type LocalTarget,
  type Variant,
} from './recipes';
import { runTool, stopAll } from './run';
import { accountText, apiUrlProblem, creditsText, summary, type ConvertSummary } from './text';
import {
  TOOL_IDS,
  TOOL_NAMES,
  TOOL_PAGES,
  TOOL_USES,
  detectTools,
  shortPath,
  type Detection,
  type Host,
  type ToolId,
} from './tools';

/**
 * Converter Studio in VS Code: "Convert with Converter Studio…" on files in the Explorer, on an
 * editor tab and in the Command Palette. A file is converted on this computer first: by the
 * extension itself or by a tool installed here (FFmpeg, LibreOffice, Pandoc, ImageMagick,
 * Ghostscript, Tesseract). The desktop app and the cloud are choices of their own, never a silent
 * fallback. The API key is kept in VS Code's secret storage (the keychain), never in settings.
 */

const SECRET_KEY = 'converterStudio.apiKey';
const SITE = 'https://converter.studio';
const KEYS_PAGE = `${SITE}/account#api-keys`;
const PRICING_PAGE = `${SITE}/pricing`;
/** The formats are read again after this long. */
const FORMATS_TTL_MS = 60 * 60_000;
const FORMATS_STATE = 'converterStudio.formats';
const TRY_CLOUD = 'Try in the Cloud (uses credits)';
const CONVERT_CLOUD = 'Convert in the Cloud (uses credits)';

type Where = 'local' | 'desktop' | 'cloud';

/** What `converterStudio.convert` takes from a keybinding or another extension. */
interface ConvertArgs {
  /** Files as URIs (`file:///…`) or absolute paths; the active file when left out. */
  files?: string[];
  /** A target format id (`webp`, `pdf`…); the picker opens when left out. */
  to?: string;
  /** Conversion options, as the API takes them (`{ "ocr": true }`). */
  options?: Record<string, unknown>;
  /** Where to convert; `local` when left out. The cloud is used only when asked for. */
  where?: Where;
}

interface FormatsCache {
  apiUrl: string;
  at: number;
  formats: FormatInfo[];
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Converter Studio', { log: true });
  const version = String((context.extension.packageJSON as { version?: unknown }).version);
  let formatsCache: FormatsCache | null =
    context.globalState.get<FormatsCache>(FORMATS_STATE) ?? null;
  let detection: Promise<Detection> | null = null;

  const config = () => vscode.workspace.getConfiguration('converterStudio');

  const settings = (): ConvertSettings & { apiUrl: string } => {
    const maxCredits = config().get<number>('maxCredits', DEFAULT_SETTINGS.maxCredits);
    return {
      ...DEFAULT_SETTINGS,
      maxCredits: Number.isInteger(maxCredits) && maxCredits >= 0 ? maxCredits : 20,
      existingFiles: config().get<string>('existingFiles') === 'ask' ? 'ask' : 'keepBoth',
      apiUrl: config().get<string>('apiUrl')?.trim() || DEFAULT_API_URL,
    };
  };

  const localSettings = (): LocalSettings => {
    const minutes = config().get<number>('local.timeoutMinutes', 30);
    return {
      ...DEFAULT_LOCAL_SETTINGS,
      existingFiles: settings().existingFiles,
      timeoutMs: (Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 1440) : 30) * 60_000,
      languages: config().get<string>('local.ocrLanguages', 'eng').trim() || 'eng',
    };
  };

  const cloudOn = () => config().get<boolean>('cloud.enabled', true) !== false;
  const desktopOn = () => config().get<boolean>('desktopApp.enabled', false) === true;
  const remote = () => vscode.env.remoteName !== undefined;
  const here = () => (remote() ? 'on the remote machine' : 'on this computer');

  const client = (apiKey?: string) => {
    const { apiUrl } = settings();
    const problem = apiUrlProblem(apiUrl);
    if (problem) throw new ConverterStudioError('badApiUrl', problem);
    return new ConverterStudioClient({
      apiKey,
      apiUrl,
      version,
      host: `${vscode.env.appName.replace(/[^\w.-]+/g, '')}/${vscode.version}`,
    });
  };

  const apiKey = async () => (await context.secrets.get(SECRET_KEY))?.trim() || undefined;

  /** The cloud's formats (no key needed), kept for an hour; null when the cloud is turned off. */
  async function formats(): Promise<FormatInfo[]> {
    if (!cloudOn()) throw new ConverterStudioError('cloudOff');
    const { apiUrl } = settings();
    if (
      formatsCache &&
      formatsCache.apiUrl === apiUrl &&
      Date.now() - formatsCache.at < FORMATS_TTL_MS
    )
      return formatsCache.formats;
    const list = await client().formats();
    formatsCache = { apiUrl, at: Date.now(), formats: list };
    void context.globalState.update(FORMATS_STATE, formatsCache);
    return list;
  }

  // --- Tools on this computer ------------------------------------------------------------------

  const host = (): Host => ({ os: process.platform, env: process.env, home: homedir() });

  /** The tools found (looked for once, again after "Look Again" or a change of settings). */
  function tools(): Promise<Detection> {
    // In Restricted Mode nothing is run, not even a tool's --version.
    if (!vscode.workspace.isTrusted) return Promise.resolve({ tools: {}, problems: {} });
    detection ??= (async () => {
      const configured = config().get<Partial<Record<ToolId, string>>>('local.toolPaths') ?? {};
      const found = await detectTools(host(), {
        configured,
        workspaceFolders: (vscode.workspace.workspaceFolders ?? [])
          .filter((folder) => folder.uri.scheme === 'file')
          .map((folder) => folder.uri.fsPath),
        probe: {
          async isExecutable(path) {
            try {
              const stat = await fsp.stat(path);
              if (!stat.isFile()) return false;
              if (process.platform !== 'win32') await fsp.access(path, fsConstants.X_OK);
              return true;
            } catch {
              return false;
            }
          },
          list: (folder) => fsp.readdir(folder).catch(() => []),
        },
        ask: async (path, args) => {
          const result = await runTool(path, args, { timeoutMs: 20_000 });
          return `${result.stdout}\n${result.stderr}`;
        },
      });
      const names = TOOL_IDS.filter((id) => found.tools[id]).map((id) =>
        `${TOOL_NAMES[id]} ${found.tools[id]!.version ?? ''}`.trim(),
      );
      log.info(`Tools on this computer: ${names.join(', ') || 'none found'}.`);
      for (const [id, problem] of Object.entries(found.problems)) log.warn(`${id}: ${problem}`);
      return found;
    })();
    return detection;
  }

  async function capabilities(): Promise<Capabilities> {
    return { tools: (await tools()).tools, canvas: true };
  }

  const profileFolder = async () => {
    const folder = join(context.globalStorageUri.fsPath, 'libreoffice-profile');
    await fsp.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    return folder;
  };

  // --- API key -----------------------------------------------------------------------------------

  /** Asks for a key, checks it with the API and saves it. Returns whether one was saved. */
  async function setApiKey(given?: unknown): Promise<boolean> {
    // From another extension or a test: saved as given, without questions.
    if (typeof given === 'string') {
      if (!given.trim()) return false;
      await context.secrets.store(SECRET_KEY, given.trim());
      return true;
    }
    const key = (
      await vscode.window.showInputBox({
        title: 'Converter Studio API Key',
        prompt: 'Paste an API key from your Converter Studio account (converter.studio/account).',
        placeHolder: 'cvs_live_…',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) =>
          /\s/.test(value.trim()) ? 'An API key has no spaces in it.' : undefined,
      })
    )?.trim();
    if (!key) return false;
    try {
      const account = await client(key).account();
      await context.secrets.store(SECRET_KEY, key);
      void vscode.window.showInformationMessage(
        `Converter Studio API key saved. ${accountText(account)}`,
      );
      log.info(`API key saved (${account.plan} plan).`);
      return true;
    } catch (thrown) {
      const error = asConverterStudioError(thrown);
      if (error.code === 'invalidApiKey') {
        void vscode.window
          .showErrorMessage(
            `Converter Studio did not accept this API key: ${error.message} It was not saved.`,
            'Try Again',
            'Get a Key',
          )
          .then((choice) => {
            if (choice === 'Try Again') void setApiKey();
            if (choice === 'Get a Key') void vscode.env.openExternal(vscode.Uri.parse(KEYS_PAGE));
          });
        return false;
      }
      // Not checked (offline, busy): saved anyway, it is checked on the first conversion.
      await context.secrets.store(SECRET_KEY, key);
      void vscode.window.showWarningMessage(
        `Converter Studio API key saved, but it could not be checked now: ${error.message}`,
      );
      log.warn(`API key saved without a check [${error.code}].`);
      return true;
    }
  }

  async function removeApiKey(): Promise<void> {
    await context.secrets.delete(SECRET_KEY);
    log.info('API key removed.');
    void vscode.window.showInformationMessage(
      'The Converter Studio API key was removed from VS Code. The key itself works until you delete it in your account at converter.studio.',
    );
  }

  async function showAccount(): Promise<void> {
    const key = await apiKey();
    if (!key) {
      await askForKey();
      return;
    }
    try {
      const account = await client(key).account();
      const choice = await vscode.window.showInformationMessage(
        `Converter Studio: ${accountText(account)}`,
        'Buy Credits',
        'API Keys',
      );
      if (choice === 'Buy Credits') void vscode.env.openExternal(vscode.Uri.parse(PRICING_PAGE));
      if (choice === 'API Keys') void vscode.env.openExternal(vscode.Uri.parse(KEYS_PAGE));
    } catch (thrown) {
      showError(asConverterStudioError(thrown));
    }
  }

  /** No key yet: offer to set one. Returns the key once there is one. */
  async function askForKey(): Promise<string | undefined> {
    const choice = await vscode.window.showWarningMessage(
      'Converting in the cloud needs a Converter Studio API key. Make one in your Converter Studio account (a free account gets free daily credits), then set it here.',
      'Set API Key',
      'Get a Key',
    );
    if (choice === 'Get a Key') {
      void vscode.env.openExternal(vscode.Uri.parse(KEYS_PAGE));
      return undefined;
    }
    if (choice === 'Set API Key' && (await setApiKey())) return apiKey();
    return undefined;
  }

  // --- Messages --------------------------------------------------------------------------------

  /** An error with the buttons that help: a cloud retry is offered, never taken by itself. */
  function showError(
    error: ConverterStudioError,
    prefix = '',
    retry?: ConvertArgs,
    retryLabel = TRY_CLOUD,
  ) {
    const actions: string[] = [];
    if (error.code === 'invalidApiKey' || error.code === 'noApiKey') actions.push('Set API Key');
    if (['notEnoughCredits', 'dailyLimit', 'monthlyLimit'].includes(error.code))
      actions.push('Buy Credits');
    if (error.code === 'untrustedWorkspace') actions.push('Manage Workspace Trust');
    if (error.code === 'noLocalConversion' || error.code === 'toolMissing')
      actions.push('Show Tools');
    if (retry && cloudOn()) actions.push(retryLabel);
    actions.push('Show Log');
    void vscode.window.showErrorMessage(`${prefix}${error.message}`, ...actions).then((choice) => {
      if (choice === 'Set API Key') void setApiKey();
      if (choice === 'Buy Credits') void vscode.env.openExternal(vscode.Uri.parse(PRICING_PAGE));
      if (choice === 'Manage Workspace Trust')
        void vscode.commands.executeCommand('workbench.trust.manage');
      if (choice === 'Show Tools') void showTools();
      if (choice === retryLabel && retry) void convert({ ...retry, where: 'cloud' });
      if (choice === 'Show Log') log.show(true);
    });
  }

  // --- Converting ------------------------------------------------------------------------------

  /** The files a convert command was started for. */
  async function filesFor(first: unknown, second: unknown): Promise<vscode.Uri[]> {
    if (first instanceof vscode.Uri) {
      const many = Array.isArray(second) && second.every((item) => item instanceof vscode.Uri);
      return many && second.length > 0 ? second : [first];
    }
    const args = first as ConvertArgs | undefined;
    if (args && Array.isArray(args.files) && args.files.length > 0)
      return args.files.map((file) =>
        /^[a-z][\w+.-]*:\/\//i.test(file) ? vscode.Uri.parse(file) : vscode.Uri.file(file),
      );
    const active = activeFile();
    if (active) return [active];
    return (
      (await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Convert',
        title: 'Convert with Converter Studio',
      })) ?? []
    );
  }

  async function convert(first?: unknown, second?: unknown): Promise<ConvertSummary | undefined> {
    const args = first instanceof vscode.Uri ? undefined : (first as ConvertArgs | undefined);
    const picked = await filesFor(first, second);
    if (picked.length === 0) return undefined;

    // Files only: folders in the selection are left out.
    const selection: vscode.Uri[] = [];
    for (const uri of picked) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.File) selection.push(uri);
      } catch {
        log.warn(`${uri.toString(true)} could not be read; left out.`);
      }
    }
    if (selection.length === 0) {
      void vscode.window.showWarningMessage(
        'Converter Studio converts files; select one or more files.',
      );
      return undefined;
    }

    const names = selection.map((uri) => vscodeFiles.name(uri));
    const formatIds = names.map((name) => knownFormatOf(name));
    const onDisk = selection.map((uri) => uri.scheme === 'file');

    let choice: Choice | undefined;
    if (args?.to) {
      const where: Where =
        args.where === 'cloud' || args.where === 'desktop' ? args.where : 'local';
      if (where === 'cloud') return convertInCloud(selection, args);
      const to = String(args.to).toLowerCase();
      const variant: Variant | null =
        args.options?.ocr === true
          ? 'ocr'
          : formatIds.every((id) => id === to) && to === 'pdf'
            ? 'compress'
            : null;
      if (where === 'desktop') {
        const caps = { ...EVERYTHING, canvas: true };
        const targets = localTargets(formatIds, caps, onDisk);
        const files = targets.find((t) => t.to === to)?.files ?? selection.map((_, i) => i);
        choice = { where, to, label: targetLabel(to, null), variant: null, files };
      } else {
        const caps = await capabilities();
        const target = localTargets(formatIds, caps, onDisk).find(
          (t) => t.to === to && t.variant === variant,
        );
        choice = {
          where,
          to,
          label: target?.label ?? targetLabel(to, variant),
          variant,
          ...(args.options ? { options: args.options } : {}),
          files: target?.files ?? [],
        };
      }
    } else {
      choice = await pickTarget(names, formatIds, onDisk);
    }
    if (!choice) return undefined;
    if (choice.where === 'cloud')
      return convertInCloud(selection, {
        to: choice.to,
        ...(choice.options ? { options: choice.options } : {}),
      });
    if (choice.where === 'desktop') return handOff(selection, choice);
    return convertHere(selection, formatIds, choice);
  }

  /** Converts on this computer; a file it cannot do is reported, with the cloud offered. */
  async function convertHere(
    selection: vscode.Uri[],
    formatIds: Array<string | null>,
    choice: Choice,
  ): Promise<ConvertSummary> {
    const caps = await capabilities();
    const target: LocalTarget = {
      to: choice.to,
      variant: choice.variant,
      label: choice.label,
      engine: '',
      files: choice.files,
      ...(choice.options ? { options: choice.options } : {}),
    };
    const local = localSettings();
    const profile = await profileFolder();
    const canvas = canvasConverter();
    const names = selection.map((uri) => vscodeFiles.name(uri));
    let outcomes: Outcome<vscode.Uri>[];
    try {
      outcomes = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Converter Studio (${here()})`,
          cancellable: true,
        },
        async (progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          const total = target.files.length;
          let finished = 0;
          const report = (index: number, stage: LocalStage, fraction: number | null) => {
            const percent = fraction === null ? '' : ` ${Math.round(fraction * 100)}%`;
            const step = `${stage === 'converting' ? 'converting' : 'saving'}${percent}`;
            progress.report({
              message:
                total <= 1
                  ? `${names[index]} → ${target.label}: ${step}`
                  : `${finished} of ${total} done · ${names[index]}: ${step}`,
            });
          };
          return convertAllHere(
            {
              files: vscodeFiles,
              pathOf: (uri) => (uri.scheme === 'file' ? uri.fsPath : null),
              formats: formatIds,
              caps,
              trusted: vscode.workspace.isTrusted,
              questions: questions(total),
              settings: local,
              profile,
              canvas,
              run: (file, runArgs, options) => {
                log.trace(`run ${file} ${runArgs.map((a) => JSON.stringify(a)).join(' ')}`);
                return runTool(file, runArgs, options);
              },
              onStage: report,
              onDone: (index, outcome) => {
                logOutcome(outcome, target.to, 'local');
                if (!target.files.includes(index)) return;
                finished++;
                progress.report({ increment: total > 0 ? 100 / total : 100 });
              },
            },
            selection,
            target,
            controller.signal,
          );
        },
      );
    } finally {
      canvas.dispose();
    }
    const result = summary(
      outcomes.map((outcome) => described(outcome)),
      'local',
    );
    notify(outcomes, result, {
      to: choice.to,
      ...(choice.options ? { options: choice.options } : {}),
    });
    return result;
  }

  /** Hands the files to Converter Studio for desktop, which shows them; nothing runs by itself. */
  async function handOff(selection: vscode.Uri[], choice: Choice): Promise<ConvertSummary> {
    const base = { where: 'desktop' as const, converted: [], failed: [], skipped: [], credits: 0 };
    const refuse = (message: string) => {
      void vscode.window.showErrorMessage(message, 'Settings').then((button) => {
        if (button === 'Settings')
          void vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'converterStudio.desktopApp',
          );
      });
      return { ...base, message };
    };
    if (!desktopOn())
      return refuse(
        'The Converter Studio desktop app is not turned on: set "Use the Converter Studio desktop app when installed" (converterStudio.desktopApp.enabled).',
      );
    if (remote())
      return refuse(
        'The desktop app cannot open the files of a remote window (SSH, WSL, a container).',
      );
    const files = choice.files
      .map((index) => selection[index]!)
      .filter((uri) => uri.scheme === 'file');
    if (files.length === 0)
      return refuse('The desktop app opens files on disk; these are in a virtual file system.');
    let bytes = 0;
    for (const uri of files) bytes += await vscodeFiles.size(uri).catch(() => 0);
    const limit = desktopLimitProblem(files.length, bytes);
    if (limit) return refuse(limit);
    const links = desktopLinks(
      choice.to,
      files.map((uri) => uri.fsPath),
    );
    // Each link is already encoded: parsed strictly as it is, opened by the operating system
    // (never through a command line), and the app does not answer.
    let opened = true;
    for (const link of links) opened = (await openExactly(link)) && opened;
    log.info(
      `Handed ${filesText(files.length)} to the desktop app (${choice.to}, ${links.length} link${links.length === 1 ? '' : 's'})${opened ? '' : ': the system did not open it'}.`,
    );
    const message = opened
      ? `Sent ${filesText(files.length)} to Converter Studio for desktop: choose Continue there, then Convert to make ${choice.label}.`
      : `The system did not open Converter Studio for desktop. It needs ${DESKTOP_APP}.`;
    void vscode.window[opened ? 'showInformationMessage' : 'showWarningMessage'](
      `${message}${opened ? ` (Nothing there? It needs ${DESKTOP_APP}.)` : ''}`,
      'Get the Desktop App',
    ).then((button) => {
      if (button === 'Get the Desktop App')
        void vscode.env.openExternal(vscode.Uri.parse(DESKTOP_PAGE));
    });
    return { ...base, message, links };
  }

  /** Converts in the cloud: chosen by the user, with the upload and the credits said plainly. */
  async function convertInCloud(
    selection: vscode.Uri[],
    args: ConvertArgs,
  ): Promise<ConvertSummary | undefined> {
    if (!cloudOn()) {
      const error = new ConverterStudioError('cloudOff');
      showError(error);
      return {
        where: 'cloud',
        converted: [],
        failed: [],
        skipped: [],
        credits: 0,
        message: error.message,
      };
    }
    const key = await apiKey();
    if (!key) {
      // Not awaited: the command ends here and starts again with the same files once a key is set.
      const again: ConvertArgs = {
        ...args,
        where: 'cloud',
        files: selection.map((uri) => uri.toString()),
      };
      void askForKey().then((saved) => (saved ? convert(again) : undefined));
      return undefined;
    }
    let catalogue: FormatInfo[];
    try {
      catalogue = await formats();
    } catch (thrown) {
      showError(asConverterStudioError(thrown), 'Converter Studio: ');
      return undefined;
    }
    const names = selection.map((uri) => vscodeFiles.name(uri));
    const formatIds = names.map((name) => formatOfName(name, catalogue));
    const target = targetFromArgs(args, formatIds, catalogue);
    if (target.files.length === 0) {
      void vscode.window.showErrorMessage(
        `Converter Studio cannot convert ${selection.length === 1 ? names[0] : 'these files'} to ${target.label}.`,
      );
      return undefined;
    }

    const config = settings();
    let api: ConverterStudioClient;
    try {
      api = client(key);
    } catch (thrown) {
      showError(asConverterStudioError(thrown));
      return undefined;
    }
    const outcomes = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Converter Studio (in the cloud)',
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        const total = target.files.length;
        let finished = 0;
        const report = (index: number, stage: Stage, fraction: number | null) => {
          const percent = fraction === null ? '' : ` ${Math.round(fraction * 100)}%`;
          const step = `${STAGE_TEXT[stage]}${percent}`;
          progress.report({
            message:
              total === 1
                ? `${names[index]} → ${target.label}: ${step}`
                : `${finished} of ${total} done · ${names[index]}: ${step}`,
          });
        };
        return convertAll(
          {
            client: api,
            files: vscodeFiles,
            questions: questions(total),
            settings: config,
            onStage: report,
            onDone: (index, outcome) => {
              logOutcome(outcome, target.to, 'cloud');
              if (!target.files.includes(index)) return;
              finished++;
              progress.report({ increment: 100 / total });
            },
          },
          selection,
          target,
          controller.signal,
        );
      },
    );

    const result = summary(
      outcomes.map((outcome) => described(outcome)),
      'cloud',
    );
    notify(outcomes, result);
    return result;
  }

  function targetFromArgs(
    args: ConvertArgs,
    formatIds: ReadonlyArray<string | null>,
    catalogue: readonly FormatInfo[],
  ): Target {
    const to = String(args.to).toLowerCase();
    const byId = new Map(catalogue.map((format) => [format.id, format]));
    const files = formatIds.flatMap((id, index) =>
      id && byId.get(id)?.to.includes(to) ? [index] : [],
    );
    return {
      to,
      label: byId.get(to)?.name ?? to.toUpperCase(),
      ...(args.options && typeof args.options === 'object' ? { options: args.options } : {}),
      files,
      suggested: false,
    };
  }

  /**
   * The picker: the targets on this computer first (one of them is chosen when you press Enter),
   * then the desktop app's when it is turned on, then the cloud's, which load while you look.
   */
  async function pickTarget(
    names: string[],
    formatIds: Array<string | null>,
    onDisk: boolean[],
  ): Promise<Choice | undefined> {
    const all = names.length;
    const trusted = vscode.workspace.isTrusted;
    const caps = await capabilities();
    const local = localTargets(formatIds, caps, onDisk);
    const found = TOOL_IDS.filter((id) => caps.tools[id]).map((id) => TOOL_NAMES[id]);
    const desktopUsable = desktopOn() && !remote() && onDisk.some(Boolean);
    const staticDesktop = (): Target[] =>
      desktopOnly(
        localTargets(formatIds, EVERYTHING, onDisk)
          .filter((t) => t.variant === null)
          .map((t) => ({ to: t.to, label: t.label, files: t.files, suggested: false })),
        onDisk,
      );
    const fromCatalogue = (catalogue: readonly FormatInfo[]) =>
      targetsFor(
        names.map((name) => formatOfName(name, catalogue)),
        catalogue,
      );
    const cachedCatalogue =
      cloudOn() && formatsCache && formatsCache.apiUrl === settings().apiUrl
        ? formatsCache.formats
        : null;
    let cloud: Target[] | 'loading' | 'failed' | null = !cloudOn()
      ? null
      : cachedCatalogue
        ? fromCatalogue(cachedCatalogue)
        : 'loading';
    let desktop: Target[] | null = desktopUsable
      ? cachedCatalogue
        ? desktopOnly(fromCatalogue(cachedCatalogue), onDisk)
        : staticDesktop()
      : null;

    type Item = vscode.QuickPickItem & { row: Row };
    const quickPick = vscode.window.createQuickPick<Item>();
    quickPick.title = all === 1 ? `Convert ${names[0]}` : `Convert ${filesText(all)}`;
    quickPick.placeholder = `Convert to… (Enter converts ${here()})`;
    quickPick.matchOnDescription = true;
    const render = (keepActive: boolean) => {
      const previous = quickPick.activeItems[0]?.row.choice;
      const rows = pickerRows({
        total: all,
        local,
        desktop,
        cloud,
        trusted,
        remote: remote(),
        toolsFound: found,
      });
      const items: Item[] = rows.map((row) => ({
        label: row.label,
        ...(row.kind === 'separator' ? { kind: vscode.QuickPickItemKind.Separator } : {}),
        ...(row.description ? { description: row.description } : {}),
        row,
      }));
      quickPick.items = items;
      const same = previous
        ? items.find(
            (item) =>
              item.row.choice?.where === previous.where &&
              item.row.choice.to === previous.to &&
              item.row.choice.variant === previous.variant,
          )
        : undefined;
      const start = items[firstRow(rows)];
      const active = keepActive && same ? same : start;
      if (active) quickPick.activeItems = [active];
    };
    render(false);
    if (
      cloud === 'loading' ||
      (cachedCatalogue && Date.now() - formatsCache!.at >= FORMATS_TTL_MS)
    ) {
      quickPick.busy = cloud === 'loading';
      formats().then(
        (catalogue) => {
          cloud = fromCatalogue(catalogue);
          if (desktopUsable) desktop = desktopOnly(cloud, onDisk);
          quickPick.busy = false;
          render(true);
        },
        (thrown) => {
          log.warn(
            `The cloud's formats could not be read: ${asConverterStudioError(thrown).message}`,
          );
          if (cloud === 'loading') cloud = 'failed';
          quickPick.busy = false;
          render(true);
        },
      );
    }
    const picked = await new Promise<Item | undefined>((resolve) => {
      quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0] ?? quickPick.activeItems[0]));
      quickPick.onDidHide(() => resolve(undefined));
      quickPick.show();
    });
    quickPick.dispose();
    if (!picked) return undefined;
    if (picked.row.action === 'showTools') {
      void showTools();
      return undefined;
    }
    if (picked.row.action === 'manageTrust') {
      void vscode.commands.executeCommand('workbench.trust.manage');
      return undefined;
    }
    return picked.row.choice;
  }

  /**
   * Questions during a conversion, one at a time (several files convert at once). With more than
   * one file, an answer can stand for the rest of them.
   */
  function questions(files: number): Questions {
    let queue: Promise<unknown> = Promise.resolve();
    const oneAtATime = <T>(ask: () => Thenable<T>): Promise<T> => {
      const next = queue.then(ask, ask);
      queue = next.catch(() => undefined);
      return next;
    };
    const forAll = (choice: string) => (files > 1 ? [choice] : []);
    let alwaysPay = false;
    let always: ExistingChoice | null = null;
    return {
      confirmCost: (fileName, cost, limit) =>
        oneAtATime(async () => {
          if (alwaysPay) return true;
          const choice = await vscode.window.showWarningMessage(
            `Converting ${fileName} costs ${creditsText(cost)}, more than the ${creditsText(limit)} allowed without asking.`,
            { modal: true, detail: 'Nothing is charged unless you go ahead.' },
            'Convert',
            ...forAll('Convert All'),
          );
          if (choice === 'Convert All') alwaysPay = true;
          return choice === 'Convert' || choice === 'Convert All';
        }),
      existing: (name) =>
        oneAtATime(async () => {
          if (always) return always;
          const choice = await vscode.window.showWarningMessage(
            `${name} already exists next to the original.`,
            { modal: true, detail: 'Overwrite it, or save the result under a new name?' },
            'Overwrite',
            'Keep Both',
            ...forAll('Keep Both for All'),
          );
          if (choice === 'Keep Both for All') always = 'keepBoth';
          if (choice === 'Overwrite') return 'overwrite';
          return choice ? 'keepBoth' : 'skip';
        }),
    };
  }

  function described(outcome: Outcome<vscode.Uri>) {
    return outcome.status === 'converted'
      ? {
          status: outcome.status,
          source: outcome.file.toString(),
          result: outcome.result.toString(),
          credits: outcome.credits,
          ...(outcome.engine ? { engine: outcome.engine } : {}),
        }
      : {
          status: outcome.status,
          source: outcome.file.toString(),
          code: outcome.error.code,
          message: outcome.error.message,
        };
  }

  function logOutcome(outcome: Outcome<vscode.Uri>, to: string, where: 'local' | 'cloud') {
    const name = vscodeFiles.name(outcome.file);
    if (outcome.status === 'converted')
      log.info(
        `${name} → ${vscodeFiles.name(outcome.result)} (${to}, ${where === 'local' ? `${here()}, ${outcome.engine ?? ''}` : creditsText(outcome.credits)})`,
      );
    else if (outcome.status === 'failed')
      log.error(`${name} → ${to}: failed [${outcome.error.code}] ${outcome.error.message}`);
    else log.warn(`${name} → ${to}: skipped [${outcome.error.code}] ${outcome.error.message}`);
  }

  /** The end of a conversion: what was saved, what failed (with the cloud offered for those). */
  function notify(
    outcomes: Outcome<vscode.Uri>[],
    result: ConvertSummary,
    retry?: Pick<ConvertArgs, 'to' | 'options'>,
  ) {
    const converted = outcomes.filter(
      (o): o is Extract<Outcome<vscode.Uri>, { status: 'converted' }> => o.status === 'converted',
    );
    const failed = outcomes.filter((o) => o.status === 'failed');
    const notHere = outcomes.filter(
      (o) =>
        o.status === 'skipped' &&
        ['noLocalConversion', 'untrustedWorkspace', 'notOnDisk'].includes(o.error.code),
    );
    const canceled = outcomes.some((o) => o.status !== 'converted' && o.error.code === 'canceled');
    const again = (list: Outcome<vscode.Uri>[]): ConvertArgs | undefined =>
      retry ? { ...retry, files: list.map((o) => o.file.toString()) } : undefined;
    if (failed.length > 0 && !canceled) {
      const first = failed[0]!;
      if (first.status !== 'failed') return;
      const prefix =
        outcomes.length === 1
          ? `${vscodeFiles.name(first.file)} was not converted${retry ? ` ${here()}` : ''}: `
          : `${failed.length} of ${filesText(outcomes.length)} not converted (${vscodeFiles.name(first.file)}: `;
      const error = new ConverterStudioError(
        first.error.code,
        outcomes.length === 1 ? first.error.message : `${first.error.message})`,
      );
      showError(error, prefix, again(failed));
      if (converted.length === 0 && notHere.length === 0) return;
    }
    if (canceled) {
      void vscode.window.showInformationMessage(
        retry
          ? `Canceled. ${result.message}`
          : `Canceled. ${result.message} A conversion that had already started may still finish at Converter Studio and use its credits.`,
      );
      return;
    }
    if (notHere.length > 0) {
      const first = notHere[0]!;
      if (first.status !== 'skipped') return;
      const text =
        outcomes.length === 1
          ? `${vscodeFiles.name(first.file)}: ${first.error.message}`
          : `${filesText(notHere.length)} of ${filesText(outcomes.length)} could not be converted ${here()} (${vscodeFiles.name(first.file)}: ${first.error.message})`;
      showError(
        new ConverterStudioError(first.error.code, text),
        '',
        again(notHere),
        CONVERT_CLOUD,
      );
      if (converted.length === 0) return;
    }
    if (converted.length === 0) {
      // Only skipped files (declined price, existing names, not smaller).
      const first = outcomes[0];
      if (first && first.status === 'skipped')
        void vscode.window.showWarningMessage(
          `${vscodeFiles.name(first.file)}: ${first.error.message}`,
        );
      return;
    }
    const single = converted.length === 1 ? converted[0]! : null;
    const actions = single ? ['Open', 'Reveal in Explorer'] : ['Reveal in Explorer'];
    void vscode.window.showInformationMessage(result.message, ...actions).then((choice) => {
      const first = converted[0]!.result;
      if (choice === 'Open') void vscode.commands.executeCommand('vscode.open', first);
      if (choice === 'Reveal in Explorer')
        void vscode.commands.executeCommand('revealInExplorer', first);
    });
  }

  // --- The tools view --------------------------------------------------------------------------

  /**
   * Which tools were found and what they enable, the built-in conversions, and the desktop app and
   * cloud settings. Returns what it showed (for other extensions and the tests).
   */
  async function showTools(): Promise<{
    trusted: boolean;
    tools: Record<string, { path: string; version: string | null }>;
  }> {
    const trusted = vscode.workspace.isTrusted;
    const { tools: found } = await tools();
    type Item = vscode.QuickPickItem & { run?: () => void };
    const items: Item[] = [];
    if (!trusted)
      items.push({
        label: '$(shield) Restricted Mode: tools on this computer are not run in this workspace',
        detail:
          'Trust the workspace to use FFmpeg, LibreOffice, Pandoc, ImageMagick, Ghostscript and Tesseract.',
        run: () => void vscode.commands.executeCommand('workbench.trust.manage'),
      });
    items.push({ label: `Tools ${here()}`, kind: vscode.QuickPickItemKind.Separator });
    for (const id of TOOL_IDS) {
      const tool = found[id];
      if (tool)
        items.push({
          label: `$(check) ${TOOL_NAMES[id]}${tool.version ? ` ${tool.version}` : ''}`,
          description: shortPath(tool.path, homedir()),
          detail: toolDetail(id, tool),
        });
      else
        items.push({
          label: `$(circle-slash) ${TOOL_NAMES[id]}`,
          description: trusted ? 'not found: get it' : 'not looked for in Restricted Mode',
          detail: `For ${TOOL_USES[id]}.`,
          run: () => void vscode.env.openExternal(vscode.Uri.parse(TOOL_PAGES[id])),
        });
    }
    items.push({
      label: '$(check) Built in',
      description: 'no tool needed',
      detail:
        'JSON to CSV and YAML, CSV to JSON; PNG, JPG, WebP, GIF, BMP, AVIF, ICO and SVG to PNG, JPG or WebP.',
    });
    items.push({ label: 'Elsewhere', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: `$(link-external) Converter Studio for desktop: ${desktopOn() ? 'on' : 'off'}`,
      detail: `Hands files to the desktop app, where you press Convert (${DESKTOP_APP}).`,
      run: () =>
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'converterStudio.desktopApp',
        ),
    });
    items.push({
      label: `$(cloud-upload) The cloud: ${cloudOn() ? 'offered in the picker' : 'off'}`,
      detail: 'Uploads the file to converter.studio and uses credits; only when you choose it.',
      run: () =>
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'converterStudio.cloud',
        ),
    });
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: '$(refresh) Look Again',
      detail: 'After installing a tool.',
      run: () => {
        detection = null;
        void showTools();
      },
    });
    items.push({
      label: '$(gear) Set Tool Paths',
      detail: 'For a tool that is installed somewhere else (user settings only).',
      run: () =>
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'converterStudio.local.toolPaths',
        ),
    });
    void vscode.window
      .showQuickPick(items, {
        title: 'Converter Studio: Tools on This Computer',
        matchOnDetail: true,
      })
      .then((item) => item?.run?.());
    const list: Record<string, { path: string; version: string | null }> = {};
    for (const id of TOOL_IDS)
      if (found[id]) list[id] = { path: found[id].path, version: found[id].version };
    return { trusted, tools: list };
  }

  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('converterStudio.convert', convert),
    vscode.commands.registerCommand('converterStudio.showTools', showTools),
    vscode.commands.registerCommand('converterStudio.setApiKey', setApiKey),
    vscode.commands.registerCommand('converterStudio.removeApiKey', removeApiKey),
    vscode.commands.registerCommand('converterStudio.showAccount', showAccount),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('converterStudio.apiUrl')) formatsCache = null;
      if (event.affectsConfiguration('converterStudio.local.toolPaths')) detection = null;
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      detection = null;
    }),
  );
}

export function deactivate() {
  // A tool still converting is stopped with the editor (cloud conversions end with it anyway).
  stopAll();
}

const STAGE_TEXT: Record<Stage, string> = {
  uploading: 'uploading',
  converting: 'converting',
  confirming: 'waiting for your answer',
  downloading: 'saving',
};

/**
 * The desktop app's targets: one per format (no options travel in the link), for the files on
 * disk only (the app reads them from the disk).
 */
function desktopOnly(targets: readonly Target[], onDisk: readonly boolean[]): Target[] {
  const seen = new Set<string>();
  return targets
    .filter((target) => !target.options && !seen.has(target.to) && seen.add(target.to))
    .map((target) => ({
      ...target,
      files: target.files.filter((index) => onDisk[index]),
      suggested: false,
    }))
    .filter((target) => target.files.length > 0);
}

function toolDetail(
  id: ToolId,
  tool: {
    encoders?: ReadonlySet<string>;
    reads?: ReadonlySet<string>;
    languages?: readonly string[];
  },
): string {
  const parts = [`For ${TOOL_USES[id]}.`];
  if (id === 'magick')
    parts.push(
      tool.reads?.has('HEIC')
        ? 'Reads HEIC.'
        : 'Built without HEIC (libheif): HEIC photos go elsewhere.',
    );
  if (id === 'tesseract' && tool.languages?.length)
    parts.push(
      `Languages: ${tool.languages.slice(0, 12).join(', ')}${tool.languages.length > 12 ? '…' : ''}.`,
    );
  if (id === 'ffmpeg' && tool.encoders) {
    const missing = ['libx264', 'libvpx-vp9', 'libmp3lame', 'libopus', 'libvorbis'].filter(
      (e) => !tool.encoders!.has(e),
    );
    if (missing.length) parts.push(`Without ${missing.join(', ')}.`);
  }
  return parts.join(' ');
}

/**
 * Opens an already-encoded link with the operating system exactly as it is written. A Uri is
 * decoded and encoded again on its way (VS Code opens `encodeURI(uri.toString(true))`), which
 * turns a `+`, `&`, `=`, `#` or `%` in a file name into something else; a link given as text
 * is passed on unchanged (VS Code keeps the text when it parses to the same Uri, since 1.90 at
 * least). It goes to the system's handler, never through a command line.
 */
const openExactly = (link: string): Thenable<boolean> =>
  vscode.env.openExternal(link as unknown as vscode.Uri);

/** The file of the active editor tab (text, image preview or another custom editor). */
function activeFile(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri =
    input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
      ? input.uri
      : vscode.window.activeTextEditor?.document.uri;
  return uri && uri.scheme !== 'untitled' ? uri : undefined;
}
