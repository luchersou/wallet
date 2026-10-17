import { beforeAll } from 'bun:test';

const STACK_RUNNING =
  'The full stack (api/worker containers) is running. Its workers consume the same queues and ' +
  'outbox the tests observe. Stop them first: docker compose stop api worker';

/** Os testes usam só a infra (Postgres + MiniStack). Workers do stack interferem nos resultados. */
beforeAll(async () => {
  let apiUp = false;
  try {
    const res = await fetch('http://localhost:3000/health/live', { signal: AbortSignal.timeout(500) });
    apiUp = res.ok;
  } catch {
    apiUp = false; // nada escutando na 3000: ok
  }
  if (apiUp) throw new Error(STACK_RUNNING);
});