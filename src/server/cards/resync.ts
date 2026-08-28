import { existsSync } from 'node:fs';

import { eq } from 'drizzle-orm';
import { simpleGit } from 'simple-git';

import type { DatabaseHandle } from '../db/client.js';
import { cards, columns, runs } from '../db/schema.js';
import { parseGuardrails } from './guardrails.js';
import { claimedPaths, looksFinished } from './staleness.js';

/**
 * Catching up with work that happened somewhere else.
 *
 * The board only learns what its own hooks tell it. Work done in a second
 * Claude Code window, in Codex, or by hand leaves the card exactly where it
 * was - so an operator who switches harnesses accumulates a Ready column full
 * of things that are already finished, and the queue keeps offering them.
 *
 * `looksFinished` already flags the cheap half of this on every board read:
 * the card names files, they all exist, and it has never run. That signal is
 * weak on its own and the module that computes it says so. A file existing is
 * not the work being done - the card asking for a change *inside* a file that
 * already exists trips it on the day it is written.
 *
 * What this adds is the half that costs a git call, and so cannot run on every
 * read: whether anything has actually touched those files since the card was
 * written. "The files exist" is nearly meaningless; "somebody changed exactly
 * these files after this card was created" is evidence about this card.
 *
 * Both together still are not proof, which is why the destination is the review
 * gate and not Done. The board saying a thing is finished when it has only
 * inferred it would be the one failure this product cannot afford - its whole
 * claim is that it does not lie about what happened. "A human should look at
 * this" is exactly the claim the evidence supports.
 */

export interface ResyncCommit {
  readonly hash: string;
  readonly subject: string;
  readonly at: number;
}

export interface ResyncFinding {
  readonly cardId: string;
  readonly title: string;
  /** The files the card names, which is what was searched for. */
  readonly paths: readonly string[];
  /** Commits that touched them after the card was written. */
  readonly commits: readonly ResyncCommit[];
}

export interface ResyncReport {
  /** Cards that looked finished before git was asked anything. */
  readonly candidates: number;
  readonly movedTo: string | null;
  readonly moved: readonly ResyncFinding[];
  readonly unconfirmed: readonly ResyncFinding[];
  /** One sentence, for an operator who will not read the list. */
  readonly note: string;
}

interface Commit extends ResyncCommit {
  readonly files: readonly string[];
}

/**
 * The files a card names, keeping only the ones that name a file.
 *
 * A guardrail scope of `test/` is permission to touch the tests, not a claim
 * that this card is about all of them - and treated as evidence it matches
 * every commit in a project that has tests.
 *
 * Measured on a real board of four suspect cards. Counting any named path,
 * directories included, moved three and got two of them wrong: both wrong ones
 * were scoped to `test/` or `src/server/brief/`, and every commit of that week
 * touched something underneath. Restricting the evidence to concrete files
 * moved exactly the one card that was genuinely finished and left the three
 * that were not.
 *
 * A card that names no file at all cannot be confirmed here. That is the honest
 * answer rather than the permissive one.
 */
function evidencePaths(paths: readonly string[]): string[] {
  return paths.filter(
    (path) => !path.endsWith('/') && (path.split('/').at(-1) ?? '').includes('.'),
  );
}

/**
 * One `git log` for the whole board rather than one per card.
 *
 * Cards are checked against the same history, so the cost is a single call
 * however many cards are suspect - which matters because the alternative walks
 * the log once per card and this runs on a button an operator may lean on.
 */
async function commitsSince(repoCwd: string, since: number): Promise<Commit[]> {
  if (!existsSync(repoCwd)) return [];

  try {
    const raw = await simpleGit(repoCwd).raw([
      'log',
      `--since=${new Date(since).toISOString()}`,
      '--name-only',
      // NUL between commits and unit separators inside the header, because a
      // commit subject can contain anything at all, newlines included.
      '--pretty=format:%x00%H%x1f%ct%x1f%s',
    ]);

    return raw
      .split('\0')
      .filter((block) => block.trim() !== '')
      .map((block) => {
        const [header = '', ...rest] = block.split('\n');
        const [hash = '', seconds = '0', subject = ''] = header.split('\x1f');
        return {
          hash: hash.slice(0, 8),
          at: Number(seconds) * 1000,
          subject,
          files: rest.filter((line) => line.trim() !== ''),
        };
      });
  } catch {
    // Not a repository, no history, or a git that refused. The board is still
    // usable without this, and a resync that throws would take the button with
    // it - so an empty history reads as "nothing to confirm with".
    return [];
  }
}

export async function resync(
  handle: DatabaseHandle,
  boardId: string,
  repoCwd: string,
  options: { readonly apply?: boolean } = {},
): Promise<ResyncReport> {
  const apply = options.apply ?? true;

  const boardColumns = handle.db.select().from(columns).where(eq(columns.boardId, boardId)).all();
  const terminal = new Set(
    boardColumns.filter((column) => column.isTerminal).map((column) => column.id),
  );
  const review = boardColumns.find((column) => column.isReviewGate) ?? null;

  const runCounts = new Map<string, number>();
  for (const run of handle.db.select().from(runs).where(eq(runs.boardId, boardId)).all()) {
    if (run.cardId !== null) runCounts.set(run.cardId, (runCounts.get(run.cardId) ?? 0) + 1);
  }

  // The same population the "May be done" chip marks, deliberately. The button
  // exists because of that chip, and a resync that acted on cards the operator
  // was never shown would be doing something else.
  const candidates = handle.db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .all()
    .filter(
      (card) =>
        card.archivedAt === null &&
        !terminal.has(card.columnId) &&
        card.status !== 'running' &&
        looksFinished({
          body: card.body,
          guardrails: parseGuardrails(card.guardrails),
          runCount: runCounts.get(card.id) ?? 0,
          repoCwd,
        }),
    );

  if (candidates.length === 0) {
    return {
      candidates: 0,
      movedTo: null,
      moved: [],
      unconfirmed: [],
      note: 'No card on this board looks finished. Nothing to catch up on.',
    };
  }

  const earliest = Math.min(...candidates.map((card) => card.createdAt));
  const history = await commitsSince(repoCwd, earliest);

  const moved: ResyncFinding[] = [];
  const unconfirmed: ResyncFinding[] = [];

  for (const card of candidates) {
    const paths = claimedPaths({
      body: card.body,
      guardrails: parseGuardrails(card.guardrails),
    });
    // After the card was written, not merely recent. A commit that predates the
    // card is the state the card was written against, so counting it would
    // confirm every card the moment it was created.
    const since = history.filter((commit) => commit.at > card.createdAt);
    const wanted = evidencePaths(paths);

    /*
     * One commit that touched every file the card names.
     *
     * Not "each file was touched at some point", which is the rule this had
     * first and which confirmed an abandoned card on a real board: its three
     * files had all changed since it was written, in three unrelated commits,
     * for three unrelated reasons. File-level history cannot say why a file
     * changed - but a single commit spanning exactly the surface a card
     * describes is a change shaped like that card, and unrelated churn is not
     * shaped like anything in particular.
     *
     * On the same four cards this moved one and left three, which is what a
     * person reading them concludes.
     */
    const commits =
      wanted.length === 0
        ? []
        : since
            .filter((commit) => wanted.every((path) => commit.files.includes(path)))
            .map(({ hash, subject, at }) => ({ hash, subject, at }));

    const finding: ResyncFinding = {
      cardId: card.id,
      title: card.title,
      paths: wanted,
      commits,
    };

    if (commits.length === 0) {
      unconfirmed.push(finding);
      continue;
    }

    moved.push(finding);
    if (apply && review !== null) {
      handle.db
        .update(cards)
        .set({ columnId: review.id, updatedAt: Date.now() })
        .where(eq(cards.id, card.id))
        .run();
    }
  }

  return {
    candidates: candidates.length,
    movedTo: review?.name ?? null,
    moved,
    unconfirmed,
    note: describe(moved.length, unconfirmed.length, review?.name ?? null, apply),
  };
}

/** Says what happened without overstating it, which is the whole point here. */
function describe(
  moved: number,
  unconfirmed: number,
  reviewName: string | null,
  apply: boolean,
): string {
  const rest =
    unconfirmed === 0
      ? ''
      : ` ${String(unconfirmed)} other card(s) name files that already exist, but nothing has` +
        ' changed those files since the cards were written, so they were left alone.';

  if (moved === 0) {
    return `Nothing to move.${rest === '' ? ' No suspect card had its files touched since it was written.' : rest}`.trim();
  }

  const where = reviewName === null ? 'the review column' : `"${reviewName}"`;
  const verb =
    apply && reviewName !== null ? `Moved ${String(moved)}` : `Would move ${String(moved)}`;

  return (
    `${verb} card(s) to ${where}: their files have changed since they were written. ` +
    `Nothing was marked done - whether the work is finished is still a judgement.${rest}`
  ).trim();
}
