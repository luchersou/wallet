import { Logger } from '@nestjs/common';

// Silencia o logger padrão do Nest nos testes (em produção os logs saem pelo pino, em JSON)
Logger.overrideLogger(false);

/**
 * As suítes de integração e concorrência usam só a infra (Postgres + MiniStack).
 * Se o stack completo estiver ligado, os workers dele consomem as mesmas filas e
 * publicam a mesma outbox que os testes observam. Testes unitários não precisam da checagem.
 */
const targets = process.argv.filter((arg) => /(^|[\\/])test[\\/]/.test(arg));
const unitOnly = targets.length > 0 && targets.every((arg) => /test[\\/]unit/.test(arg));

async function apiContainerIsUp(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:3000/health/live', { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false; // nada escutando na 3000: ok
  }
}

if (!unitOnly && (await apiContainerIsUp())) {
  console.error(
    '\n✖ The full stack (api/worker containers) is running. Its workers consume the same queues and ' +
      'outbox the tests observe.\n  Stop them first: docker compose stop api worker\n',
  );
  process.exit(1);
}