import type { AccountView } from './client';
import { filesText } from './formats';

/** Words shown to the user, kept apart from VS Code so the unit tests can read them. */

/** "1 credit", "3 credits". */
export const creditsText = (n: number | null | undefined): string =>
  n === null || n === undefined
    ? 'an unknown number of credits'
    : `${n.toLocaleString('en-US')} credit${n === 1 ? '' : 's'}`;

const PLAN_NAMES: Record<string, string> = {
  free: 'Free plan',
  pro: 'Pro plan',
  premium: 'Premium plan',
};

/** "Pro plan: 1,234 credits left, renewing on 2026-12-01." */
export function accountText(account: AccountView): string {
  const plan = PLAN_NAMES[account.plan] ?? `${account.plan} plan`;
  const parts = [`${plan}: ${creditsText(account.credits)} left`];
  if (account.allowance)
    parts.push(
      `${account.allowance.used.toLocaleString('en-US')} of ${account.allowance.limit.toLocaleString('en-US')} ${account.allowance.per === 'day' ? 'daily' : 'monthly'} credits used`,
    );
  const renews = account.renewsAt ? account.renewsAt.slice(0, 10) : null;
  return `${parts.join(', ')}${renews ? `, renewing on ${renews}` : ''}.`;
}

/**
 * Why an API address cannot be used, or null. The key goes to it, so it must be https, except on
 * this computer (a local test server).
 */
export function apiUrlProblem(apiUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return `The setting converterStudio.apiUrl is not a web address: ${apiUrl}`;
  }
  if (url.username || url.password)
    return 'The setting converterStudio.apiUrl must not hold a user name or password.';
  if (url.protocol === 'https:') return null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && local) return null;
  return 'The setting converterStudio.apiUrl must start with https:// (plain http only for localhost).';
}

export interface DescribedOutcome {
  status: 'converted' | 'failed' | 'skipped';
  /** The original's URI. */
  source: string;
  /** The saved result's URI. */
  result?: string;
  credits?: number;
  code?: string;
  message?: string;
}

/** What `converterStudio.convert` returns: each file's outcome, the credits used and a sentence. */
export interface ConvertSummary {
  converted: DescribedOutcome[];
  failed: DescribedOutcome[];
  skipped: DescribedOutcome[];
  credits: number;
  message: string;
}

/** The last part of a URI's path. */
export function uriName(uri: string): string {
  const path = uri.split(/[?#]/)[0] ?? '';
  const last = path.split('/').pop() ?? path;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function summary(outcomes: DescribedOutcome[]): ConvertSummary {
  const converted = outcomes.filter((o) => o.status === 'converted');
  const failed = outcomes.filter((o) => o.status === 'failed');
  const skipped = outcomes.filter((o) => o.status === 'skipped');
  const credits = converted.reduce((sum, o) => sum + (o.credits ?? 0), 0);
  const parts: string[] = [];
  if (converted.length === 1 && outcomes.length === 1)
    parts.push(
      `Converted ${uriName(converted[0]!.source)} to ${uriName(converted[0]!.result ?? '')} (${creditsText(credits)}).`,
    );
  else if (converted.length > 0)
    parts.push(`Converted ${filesText(converted.length)} (${creditsText(credits)}).`);
  else parts.push('Nothing was converted.');
  if (failed.length > 0) parts.push(`${filesText(failed.length)} not converted.`);
  if (skipped.length > 0) parts.push(`${filesText(skipped.length)} skipped.`);
  return { converted, failed, skipped, credits, message: parts.join(' ') };
}
