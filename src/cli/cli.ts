/**
 * Command dispatch for the `gorilla` CLI.
 *
 * Kept free of I/O so it can be exercised directly in tests: a command returns
 * its output and exit code rather than writing to the console or calling
 * `process.exit`. The thin wrapper in `index.ts` is what touches the process.
 */

export const VERSION = '0.0.0';

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  run(args: readonly string[]): Promise<CommandResult> | CommandResult;
}

const commands = new Map<string, Command>();

export function registerCommand(command: Command): void {
  if (commands.has(command.name)) {
    throw new Error(`Command already registered: ${command.name}`);
  }
  commands.set(command.name, command);
}

export function registeredCommands(): readonly Command[] {
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function helpText(): string {
  const lines = [
    'gorilla - keep yourself in sync with autonomous Claude Code sessions',
    '',
    'Usage: gorilla [command] [options]',
    '',
    'Options:',
    '  -h, --help       Show this help',
    '  -v, --version    Show the version',
    '',
    'Commands:',
  ];

  const available = registeredCommands();
  if (available.length === 0) {
    lines.push('  (none yet)');
  } else {
    const width = Math.max(...available.map((c) => c.name.length));
    for (const command of available) {
      lines.push(`  ${command.name.padEnd(width)}  ${command.summary}`);
    }
  }

  return lines.join('\n');
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr: string): CommandResult {
  return { exitCode: 1, stdout: '', stderr };
}

export async function runCli(argv: readonly string[]): Promise<CommandResult> {
  const [first, ...rest] = argv;

  if (first === undefined || first === '-h' || first === '--help' || first === 'help') {
    return ok(helpText());
  }

  if (first === '-v' || first === '--version' || first === 'version') {
    return ok(VERSION);
  }

  const command = commands.get(first);
  if (command === undefined) {
    return fail(`Unknown command: ${first}\n\n${helpText()}`);
  }

  return command.run(rest);
}
