import * as vscode from 'vscode';
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
import { ConverterStudioError, asConverterStudioError } from './errors';
import { vscodeFiles } from './files';
import { filesText, formatOfName, targetsFor, type Target } from './formats';
import { accountText, apiUrlProblem, creditsText, summary, type ConvertSummary } from './text';

/**
 * Converter Studio in VS Code: "Convert with Converter Studio…" on files in the Explorer, on an
 * editor tab and in the Command Palette. The API key is kept in VS Code's secret storage (the
 * operating system's keychain), never in settings.
 */

const SECRET_KEY = 'converterStudio.apiKey';
const SITE = 'https://converter.studio';
const KEYS_PAGE = `${SITE}/account#api-keys`;
const PRICING_PAGE = `${SITE}/pricing`;
/** The formats are read again after this long. */
const FORMATS_TTL_MS = 60 * 60_000;

/** What `converterStudio.convert` takes from a keybinding or another extension. */
interface ConvertArgs {
  /** Files as URIs (`file:///…`) or absolute paths; the active file when left out. */
  files?: string[];
  /** A target format id (`webp`, `pdf`…); the picker opens when left out. */
  to?: string;
  /** Conversion options, as the API takes them (`{ "ocr": true }`). */
  options?: Record<string, unknown>;
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Converter Studio', { log: true });
  const version = String((context.extension.packageJSON as { version?: unknown }).version);
  let formatsCache: { apiUrl: string; at: number; formats: FormatInfo[] } | null = null;

  const settings = (): ConvertSettings & { apiUrl: string } => {
    const config = vscode.workspace.getConfiguration('converterStudio');
    const maxCredits = config.get<number>('maxCredits', DEFAULT_SETTINGS.maxCredits);
    return {
      ...DEFAULT_SETTINGS,
      maxCredits: Number.isInteger(maxCredits) && maxCredits >= 0 ? maxCredits : 20,
      existingFiles: config.get<string>('existingFiles') === 'ask' ? 'ask' : 'keepBoth',
      apiUrl: config.get<string>('apiUrl')?.trim() || DEFAULT_API_URL,
    };
  };

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

  async function formats(): Promise<FormatInfo[]> {
    const { apiUrl } = settings();
    if (
      formatsCache &&
      formatsCache.apiUrl === apiUrl &&
      Date.now() - formatsCache.at < FORMATS_TTL_MS
    )
      return formatsCache.formats;
    const list = await client().formats();
    formatsCache = { apiUrl, at: Date.now(), formats: list };
    return list;
  }

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
      'Converter Studio needs an API key to convert files. Make one in your Converter Studio account (a free account gets free daily credits), then set it here.',
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

  function showError(error: ConverterStudioError, prefix = '') {
    const actions: string[] = [];
    if (error.code === 'invalidApiKey' || error.code === 'noApiKey') actions.push('Set API Key');
    if (['notEnoughCredits', 'dailyLimit', 'monthlyLimit'].includes(error.code))
      actions.push('Buy Credits');
    actions.push('Show Log');
    void vscode.window.showErrorMessage(`${prefix}${error.message}`, ...actions).then((choice) => {
      if (choice === 'Set API Key') void setApiKey();
      if (choice === 'Buy Credits') void vscode.env.openExternal(vscode.Uri.parse(PRICING_PAGE));
      if (choice === 'Show Log') log.show(true);
    });
  }

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

    const key = await apiKey();
    if (!key) {
      // Not awaited: the command ends here and starts again with the same files once a key is set.
      const again: ConvertArgs = { ...args, files: selection.map((uri) => uri.toString()) };
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
    const choices = targetsFor(formatIds, catalogue);
    if (choices.length === 0) {
      void vscode.window.showErrorMessage(
        selection.length === 1
          ? `Converter Studio does not read ${names[0]} (files of this type cannot be converted).`
          : 'Converter Studio does not read any of these files.',
      );
      return undefined;
    }

    const target = args?.to
      ? targetFromArgs(args, formatIds, catalogue)
      : await pickTarget(choices, names);
    if (!target) return undefined;
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
        title: 'Converter Studio',
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
              logOutcome(outcome, target);
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

    const result = summary(outcomes.map((outcome) => described(outcome)));
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

  async function pickTarget(choices: Target[], names: string[]): Promise<Target | undefined> {
    type Item = vscode.QuickPickItem & { target?: Target };
    const all = names.length;
    const items: Item[] = [];
    const suggested = choices.filter((choice) => choice.suggested);
    if (suggested.length > 0)
      items.push({ label: 'Suggested', kind: vscode.QuickPickItemKind.Separator });
    for (const choice of suggested)
      items.push({ label: choice.label, description: choice.description, target: choice });
    items.push({ label: 'All formats', kind: vscode.QuickPickItemKind.Separator });
    for (const choice of choices.filter((c) => !c.suggested)) {
      const note = choice.files.length < all ? `${choice.files.length} of ${filesText(all)}` : '';
      items.push({
        label: choice.label,
        description: [choice.description, note].filter(Boolean).join(' · ') || undefined,
        target: choice,
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: all === 1 ? `Convert ${names[0]}` : `Convert ${filesText(all)}`,
      placeHolder: 'Convert to…',
      matchOnDescription: true,
    });
    return picked?.target;
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
        }
      : {
          status: outcome.status,
          source: outcome.file.toString(),
          code: outcome.error.code,
          message: outcome.error.message,
        };
  }

  function logOutcome(outcome: Outcome<vscode.Uri>, target: Target) {
    const name = vscodeFiles.name(outcome.file);
    if (outcome.status === 'converted')
      log.info(
        `${name} → ${vscodeFiles.name(outcome.result)} (${target.to}, ${creditsText(outcome.credits)})`,
      );
    else if (outcome.status === 'failed')
      log.error(`${name} → ${target.to}: failed [${outcome.error.code}] ${outcome.error.message}`);
    else
      log.warn(`${name} → ${target.to}: skipped [${outcome.error.code}] ${outcome.error.message}`);
  }

  function notify(outcomes: Outcome<vscode.Uri>[], result: ConvertSummary) {
    const converted = outcomes.filter(
      (o): o is Extract<Outcome<vscode.Uri>, { status: 'converted' }> => o.status === 'converted',
    );
    const failed = outcomes.filter((o) => o.status === 'failed');
    const canceled = outcomes.some((o) => o.status !== 'converted' && o.error.code === 'canceled');
    if (failed.length > 0 && !canceled) {
      const first = failed[0]!;
      if (first.status !== 'failed') return;
      const prefix =
        outcomes.length === 1
          ? `${vscodeFiles.name(first.file)} was not converted: `
          : `${failed.length} of ${filesText(outcomes.length)} not converted (${vscodeFiles.name(first.file)}: `;
      const error = new ConverterStudioError(
        first.error.code,
        outcomes.length === 1 ? first.error.message : `${first.error.message})`,
      );
      showError(error, prefix);
      if (converted.length === 0) return;
    }
    if (canceled) {
      void vscode.window.showInformationMessage(
        `Canceled. ${result.message} A conversion that had already started may still finish at Converter Studio and use its credits.`,
      );
      return;
    }
    if (converted.length === 0) {
      // Only skipped files (declined price, existing names, other formats).
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

  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('converterStudio.convert', convert),
    vscode.commands.registerCommand('converterStudio.setApiKey', setApiKey),
    vscode.commands.registerCommand('converterStudio.removeApiKey', removeApiKey),
    vscode.commands.registerCommand('converterStudio.showAccount', showAccount),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('converterStudio.apiUrl')) formatsCache = null;
    }),
  );
}

export function deactivate() {
  // Nothing to clean up: running conversions end with the extension host.
}

const STAGE_TEXT: Record<Stage, string> = {
  uploading: 'uploading',
  converting: 'converting',
  confirming: 'waiting for your answer',
  downloading: 'saving',
};

/** The file of the active editor tab (text, image preview or another custom editor). */
function activeFile(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri =
    input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
      ? input.uri
      : vscode.window.activeTextEditor?.document.uri;
  return uri && uri.scheme !== 'untitled' ? uri : undefined;
}
