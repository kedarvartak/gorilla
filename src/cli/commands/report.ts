import { writeFileSync } from 'node:fs';

import { resolveDatabasePath } from '../../server/db/client.js';
import { collectStats, fetchDiagnostics, renderReport } from '../../server/report.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../../server/index.js';
import type { Command, CommandResult } from '../cli.js';

export const reportCommand: Command = {
  name: 'report',
  summary: 'Generate Phase 0 verification statistics from the recorded events',
  async run(args: readonly string[]): Promise<CommandResult> {
    const dbIndex = args.indexOf('--db');
    const outIndex = args.indexOf('--out');
    const portIndex = args.indexOf('--port');

    const port = portIndex === -1 ? DEFAULT_PORT : Number(args[portIndex + 1]);
    const databasePath = resolveDatabasePath(dbIndex === -1 ? undefined : args[dbIndex + 1]);

    try {
      const stats = collectStats(databasePath);
      const diagnostics = await fetchDiagnostics(`http://${DEFAULT_HOST}:${port}`);
      const rendered = renderReport(stats, diagnostics, Date.now());

      const out = outIndex === -1 ? undefined : args[outIndex + 1];
      if (out !== undefined) {
        writeFileSync(out, rendered, 'utf8');
        return { exitCode: 0, stdout: `Wrote ${out}`, stderr: '' };
      }

      return { exitCode: 0, stdout: rendered, stderr: '' };
    } catch (error) {
      return { exitCode: 1, stdout: '', stderr: (error as Error).message };
    }
  },
};
