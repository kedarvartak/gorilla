import { registerCommand } from './cli.js';
import { backfillCommand } from './commands/backfill.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { probeCommand } from './commands/probe.js';
import { replayCommand } from './commands/replay.js';
import { reportCommand } from './commands/report.js';
import { serveCommand } from './commands/serve.js';
import { statusCommand } from './commands/status.js';
import { exportCommand } from './commands/export.js';
import { addCommand } from './commands/add.js';
import { fixtureCommand } from './commands/fixture.js';
import { importCommand } from './commands/import.js';
import { dispatchCommand, verifyCommand } from './commands/card.js';

/**
 * Single place commands are wired in. Importing this module has the side
 * effect of registering them, so tests can import `cli.js` alone and exercise
 * dispatch without every command's dependencies loading.
 */
let registered = false;

export function registerBuiltinCommands(): void {
  if (registered) return;
  registered = true;

  registerCommand(backfillCommand);
  registerCommand(doctorCommand);
  registerCommand(initCommand);
  registerCommand(probeCommand);
  registerCommand(replayCommand);
  registerCommand(reportCommand);
  registerCommand(serveCommand);
  registerCommand(statusCommand);
  registerCommand(exportCommand);
  registerCommand(addCommand);
  registerCommand(fixtureCommand);
  registerCommand(importCommand);
  registerCommand(dispatchCommand);
  registerCommand(verifyCommand);
}
