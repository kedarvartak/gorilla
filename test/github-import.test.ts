import { describe, expect, it, vi } from 'vitest';

import { cardFor, fetchIssues, parseIssues, TOKEN_ENV } from '../src/server/cards/github.js';
import { importCommand } from '../src/cli/commands/import.js';

/**
 * Reading GitHub issues onto the board (T50).
 *
 * Written against a stubbed transport. The token to try it for real is not
 * available yet, and that is stated in doc 19 rather than implied by a passing
 * suite: these tests prove the shape handling, not that GitHub agrees.
 */

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('reading the response', () => {
  it('takes the issues', () => {
    const issues = parseIssues([
      { number: 7, title: 'A bug', body: 'It breaks.', html_url: 'https://x/7', labels: [] },
    ]);

    expect(issues[0]?.number).toBe(7);
    expect(issues[0]?.title).toBe('A bug');
  });

  it('drops pull requests', () => {
    // The issues endpoint returns those too. Importing them would put a card
    // on the board for every open review, which is the fastest way to make an
    // operator stop using the import.
    const issues = parseIssues([
      { number: 1, title: 'An issue' },
      { number: 2, title: 'A pull request', pull_request: { url: 'https://x' } },
    ]);

    expect(issues.map((issue) => issue.number)).toEqual([1]);
  });

  it('reads labels whether they are objects or strings', () => {
    const issues = parseIssues([
      { number: 1, title: 'x', labels: [{ name: 'bug' }, 'chore', { colour: 'red' }] },
    ]);

    expect(issues[0]?.labels).toEqual(['bug', 'chore']);
  });

  it('skips anything without a number and a title', () => {
    expect(parseIssues([{ title: 'no number' }, { number: 3 }])).toEqual([]);
  });

  it('answers empty for a body that is not a list', () => {
    expect(parseIssues({ message: 'Not Found' })).toEqual([]);
  });
});

describe('what the card says', () => {
  it('keeps the number in the title and the link in the body', () => {
    const card = cardFor({
      number: 7,
      title: 'A bug',
      body: 'It breaks.',
      url: 'https://github.test/x/7',
      labels: ['bug'],
    });

    // A card that only paraphrases an issue leaves the operator unable to find
    // the discussion it came from, which is usually where the requirement is.
    expect(card.title).toBe('#7 A bug');
    expect(card.body).toContain('https://github.test/x/7');
    expect(card.body).toContain('It breaks.');
    expect(card.body).toContain('bug');
  });
});

describe('asking GitHub', () => {
  it('refuses something that is not owner/name before asking', async () => {
    const send = vi.fn();
    const result = await fetchIssues({ repo: 'not-a-repo', token: 't', send });

    expect(result.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('names a token problem as a token problem', async () => {
    const send = vi.fn().mockResolvedValue(response(403, {}));
    const result = await fetchIssues({ repo: 'a/b', token: 't', send });

    // "Request failed: 403" sends the operator looking at the network. This is
    // the one failure they can actually fix.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.why).toContain(TOKEN_ENV);
  });

  it('does not claim a repository is missing when it may be private', async () => {
    const send = vi.fn().mockResolvedValue(response(404, {}));
    const result = await fetchIssues({ repo: 'a/b', token: 't', send });

    // 404 is what a private repository returns to a token that cannot see it.
    if (!result.ok) expect(result.why).toContain('cannot see it');
  });

  it('reports an unreachable GitHub rather than throwing', async () => {
    const send = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const result = await fetchIssues({ repo: 'a/b', token: 't', send });

    expect(result.ok).toBe(false);
  });

  it('sends the token as a bearer header, never in the url', async () => {
    const send = vi.fn().mockResolvedValue(response(200, []));
    await fetchIssues({ repo: 'a/b', token: 'secret-token', send });

    const [url, init] = send.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('secret-token');
    expect((init.headers as Record<string, string>)['authorization']).toContain('secret-token');
  });
});

describe('the command without a token', () => {
  it('says which variable to set', async () => {
    const before = process.env[TOKEN_ENV];
    delete process.env[TOKEN_ENV];

    try {
      const result = await importCommand.run(['--repo', 'a/b']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(TOKEN_ENV);
    } finally {
      if (before !== undefined) process.env[TOKEN_ENV] = before;
    }
  });

  it('asks for a repository when none was named', async () => {
    expect((await importCommand.run([])).stderr).toContain('--repo owner/name');
  });
});
