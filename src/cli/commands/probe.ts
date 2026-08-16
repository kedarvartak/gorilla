import { runProbe } from '../../probe/runner.js';
import { summarise } from '../../probe/compaction.js';
import type { Command, CommandResult } from '../cli.js';

export const probeCommand: Command = {
  name: 'probe',
  summary: 'Run the compaction probe against a real Claude Code session (T9)',
  async run(args: readonly string[]): Promise<CommandResult> {
    const portIndex = args.indexOf('--port');
    const port = portIndex === -1 ? 4488 : Number(args[portIndex + 1]);

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { exitCode: 1, stdout: '', stderr: '--port expects a port number' };
    }

    try {
      const findings = await runProbe({
        port,
        log: (message) => process.stderr.write(`${message}\n`),
      });

      return {
        exitCode: 0,
        stdout: `${summarise(findings)}\n\nObservations:\n${findings.observations
          .map((o) => `  ${o.event}${o.matcher === null ? '' : ` (${o.matcher})`}`)
          .join('\n')}`,
        stderr: '',
      };
    } catch (error) {
      return { exitCode: 1, stdout: '', stderr: `Probe failed: ${(error as Error).message}` };
    }
  },
};
