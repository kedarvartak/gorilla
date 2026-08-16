#!/usr/bin/env node
import { runCli } from './cli.js';
import { registerBuiltinCommands } from './register.js';

registerBuiltinCommands();

const result = await runCli(process.argv.slice(2));

if (result.stdout !== '') {
  process.stdout.write(`${result.stdout}\n`);
}
if (result.stderr !== '') {
  process.stderr.write(`${result.stderr}\n`);
}

process.exitCode = result.exitCode;
