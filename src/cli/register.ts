import { registerCommand } from './cli.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { replayCommand } from './commands/replay.js';
import { serveCommand } from './commands/serve.js';

/**
 * Single place commands are wired in. Importing this module has the side
 * effect of registering them, so tests can import `cli.js` alone and exercise
 * dispatch without every command's dependencies loading.
 */
let registered = false;

export function registerBuiltinCommands(): void {
  if (registered) return;
  registered = true;

  registerCommand(doctorCommand);
  registerCommand(initCommand);
  registerCommand(replayCommand);
  registerCommand(serveCommand);
}
