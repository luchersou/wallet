import { Logger } from '@nestjs/common';

// Silences Nest's default logger in tests (in production logs go through pino, as JSON)
Logger.overrideLogger(false);

/**
 * The integration and concurrency suites use only the infra (Postgres + MiniStack).
 * If the full stack is running, its workers consume the same queues and
 * publish the same outbox the tests observe. Unit tests do not need the check.
 */
const targets = process.argv.filter((arg) => /(^|[\\/])test[\\/]/.test(arg));
const unitOnly = targets.length > 0 && targets.every((arg) => /test[\\/]unit/.test(arg));

async function apiContainerIsUp(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:3000/health/live', { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false; // nothing listening on 3000: ok
  }
}

if (!unitOnly && (await apiContainerIsUp())) {
  console.error(
    '\n✖ The full stack (api/worker containers) is running. Its workers consume the same queues and ' +
      'outbox the tests observe.\n  Stop them first: docker compose stop api worker\n',
  );
  process.exit(1);
}