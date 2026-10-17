import { Logger } from '@nestjs/common';

/** Executa `tick` em intervalo fixo; stop() espera o tick corrente terminar. */
export class PollingLoop {
  private running = false;
  private current?: Promise<void>;
  private wake?: () => void;
  private readonly logger: Logger;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.current;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.logger.error(`${this.name} tick failed`, err instanceof Error ? err.stack : String(err));
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.intervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}