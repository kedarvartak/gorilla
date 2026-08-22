/**
 * Reading GitHub issues onto the board (T50).
 *
 * Work already tracked somewhere else should not have to be retyped. The
 * import is deliberately one-way and on demand: the board is not a mirror of
 * an issue tracker, and something that polled would eventually reopen a card
 * the operator deleted on purpose.
 */

export const TOKEN_ENV = 'GORILLA_GITHUB_TOKEN';

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly labels: readonly string[];
}

interface RawIssue {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly html_url?: unknown;
  readonly labels?: unknown;
  /** Present on a pull request. The issues endpoint returns those too. */
  readonly pull_request?: unknown;
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((label) =>
      typeof label === 'string'
        ? label
        : typeof label === 'object' &&
            label !== null &&
            typeof (label as { name?: unknown }).name === 'string'
          ? (label as { name: string }).name
          : null,
    )
    .filter((label): label is string => label !== null);
}

/**
 * Reads the response, dropping anything that is not an issue.
 *
 * Pull requests come back from the issues endpoint. Importing them would put a
 * card on the board for every open review, which is the fastest way to make an
 * operator stop using the import.
 */
export function parseIssues(body: unknown): Issue[] {
  if (!Array.isArray(body)) return [];

  const issues: Issue[] = [];

  for (const raw of body as RawIssue[]) {
    if (raw.pull_request !== undefined) continue;
    if (typeof raw.number !== 'number' || typeof raw.title !== 'string') continue;

    issues.push({
      number: raw.number,
      title: raw.title,
      body: typeof raw.body === 'string' ? raw.body : '',
      url: typeof raw.html_url === 'string' ? raw.html_url : '',
      labels: labelsOf(raw.labels),
    });
  }

  return issues;
}

export interface ImportCard {
  readonly title: string;
  readonly body: string;
}

/**
 * What the card says.
 *
 * The issue number is in the title, and the link is in the body. A card that
 * only paraphrases an issue leaves the operator unable to find the discussion
 * it came from, which is usually where the actual requirement is.
 */
export function cardFor(issue: Issue): ImportCard {
  const lines = [`Imported from ${issue.url === '' ? 'GitHub' : issue.url}.`];

  if (issue.labels.length > 0) lines.push(`Labels: ${issue.labels.join(', ')}.`);
  if (issue.body.trim() !== '') lines.push('', issue.body.trim());

  return { title: `#${String(issue.number)} ${issue.title}`, body: lines.join('\n') };
}

export interface FetchIssuesInput {
  readonly repo: string;
  readonly token: string;
  readonly state?: 'open' | 'closed' | 'all';
  readonly label?: string;
  /** Injected by tests. The global otherwise. */
  readonly send?: typeof fetch;
}

export type FetchResult =
  | { readonly ok: true; readonly issues: readonly Issue[] }
  | { readonly ok: false; readonly why: string };

const API = 'https://api.github.com';

export async function fetchIssues(input: FetchIssuesInput): Promise<FetchResult> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo)) {
    return { ok: false, why: `"${input.repo}" is not an owner/name repository.` };
  }

  const query = new URLSearchParams({ state: input.state ?? 'open', per_page: '100' });
  if (input.label !== undefined && input.label !== '') query.set('labels', input.label);

  const send = input.send ?? fetch;

  try {
    const response = await send(`${API}/repos/${input.repo}/issues?${query.toString()}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.token}`,
        'user-agent': 'gorilla',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 401 || response.status === 403) {
      // Named separately from any other failure: this is the one an operator
      // can fix, and "request failed: 403" sends them looking at the network.
      return {
        ok: false,
        why: `GitHub refused the token (${String(response.status)}). Check ${TOKEN_ENV} has read access to that repository.`,
      };
    }

    if (response.status === 404) {
      // 404 is also what a private repository returns to a token that cannot
      // see it, so the message says both rather than asserting the first.
      return {
        ok: false,
        why: `No such repository, or the token cannot see it: ${input.repo}.`,
      };
    }

    if (!response.ok) {
      return { ok: false, why: `GitHub answered ${String(response.status)}.` };
    }

    return { ok: true, issues: parseIssues(await response.json()) };
  } catch (error) {
    return { ok: false, why: `Could not reach GitHub: ${(error as Error).message}` };
  }
}
