import { DEFAULT_HOOK_BASE_URL } from '../../hooks/definitions.js';
import { replayFixture } from '../../server/fixtures/replay.js';
import type { Command, CommandResult } from '../cli.js';

export const replayCommand: Command = {
  name: 'replay',
  summary: 'Replay a recorded hook fixture into a running board',
  async run(args: readonly string[]): Promise<CommandResult> {
    const positional = args.filter((arg) => !arg.startsWith('--'));
    const path = positional[0];

    if (path === undefined) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'usage: gorilla replay <fixture.jsonl> [--url <base>] [--original]',
      };
    }

    const urlIndex = args.indexOf('--url');
    const url = urlIndex === -1 ? DEFAULT_HOOK_BASE_URL : (args[urlIndex + 1] ?? '');
    if (url === '') {
      return { exitCode: 1, stdout: '', stderr: '--url requires a value' };
    }

    try {
      const result = await replayFixture(path, {
        url,
        pacing: args.includes('--original') ? 'original' : 'fast',
      });

      const summary =
        `Replayed ${result.sent + result.failed} event(s) into ${url} ` +
        `in ${result.durationMs}ms: ${result.sent} accepted, ${result.failed} failed.`;

      if (result.failed > 0) {
        return {
          exitCode: 1,
          stdout: summary,
          stderr: `Failures by event: ${JSON.stringify(result.failures)}`,
        };
      }

      return { exitCode: 0, stdout: summary, stderr: '' };
    } catch (error) {
      return { exitCode: 1, stdout: '', stderr: (error as Error).message };
    }
  },
};
