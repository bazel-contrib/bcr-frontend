#!/usr/bin/env node

/**
 * Wrangler wrapper entrypoint
 * This wraps the real wrangler CLI to allow custom behavior if needed
 */

const { spawn } = require('child_process');

// Find the wrangler CLI entry point
const wranglerCli = require.resolve('wrangler/wrangler-dist/cli.js');

// Spawn wrangler with the same arguments and stdio
const wranglerProcess = spawn(
  process.execPath,
  [
    '--no-warnings',
    '--experimental-vm-modules',
    ...process.execArgv,
    wranglerCli,
    ...process.argv.slice(2),
  ],
  {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  }
)
  .on('exit', (code) =>
    process.exit(code === undefined || code === null ? 0 : code)
  )
  .on('message', (message) => {
    if (process.send) {
      process.send(message);
    }
  })
  .on('disconnect', () => {
    if (process.disconnect) {
      process.disconnect();
    }
  });

process.on('SIGINT', () => {
  wranglerProcess && wranglerProcess.kill();
});
process.on('SIGTERM', () => {
  wranglerProcess && wranglerProcess.kill();
});
