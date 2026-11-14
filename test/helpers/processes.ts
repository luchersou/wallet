import type { Subprocess } from 'bun';

export interface WorkerProcess {
  proc: Subprocess;
  port: number;
}

let nextPort = 4100;

export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** Starts a real worker process (main.worker.ts) and waits for /health/live to respond. */
export async function spawnWorker(extraEnv: Record<string, string> = {}): Promise<WorkerProcess> {
  const port = nextPort++;
  const logs = process.env.TEST_WORKER_LOGS ? 'inherit' : 'ignore';

  const proc = Bun.spawn([process.execPath, 'run', 'src/main.worker.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      WORKER_PORT: String(port),
      WORKER_AUTOSTART: 'true',
      SQS_WAIT_TIME_SECONDS: '1',
      SQS_VISIBILITY_TIMEOUT_SECONDS: '5',
      SQS_RETRY_BASE_SECONDS: '1',
      OUTBOX_POLL_INTERVAL_MS: '100',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
      ...extraEnv,
    },
    stdout: logs,
    stderr: logs,
  });

  await waitFor(async () => {
    try {
      return (await fetch(`http://localhost:${port}/health/live`)).ok;
    } catch {
      return false;
    }
  }, 30_000);

  return { proc, port };
}

export async function killAll(workers: WorkerProcess[], signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  for (const w of workers) w.proc.kill(signal);
  await Promise.all(workers.map((w) => w.proc.exited));
}