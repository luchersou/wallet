import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { z, ZodError } from 'zod';
import { TransientInfrastructureError } from '../../../../shared/application/errors';
import { Metrics } from '../../../../shared/application/ports/metrics.port';
import { DomainError } from '../../../../shared/domain/domain-error';
import { SQS_CONFIG, type SqsConfig } from '../../../../shared/infrastructure/sqs/sqs.module';
import { LogContext } from '../../../../shared/observability/log-context';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction.use-case';
import { SubmitWagerSchema } from '../http/dto/wager.dto';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';
export const CONSUMER_OPTIONS = Symbol('CONSUMER_OPTIONS');

export interface ConsumerOptions {
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  maxReceiveCount: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
}

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Lido no bootstrap (não no import), para permitir ajuste nos testes. */
export function readConsumerOptions(): ConsumerOptions {
  return {
    maxMessages: 10,
    waitTimeSeconds: num(process.env.SQS_WAIT_TIME_SECONDS, 10),
    visibilityTimeoutSeconds: num(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS, 30),
    maxReceiveCount: num(process.env.SQS_MAX_RECEIVE_COUNT, 10),
    retryBaseSeconds: num(process.env.SQS_RETRY_BASE_SECONDS, 2),
    retryMaxSeconds: num(process.env.SQS_RETRY_MAX_SECONDS, 60),
  };
}

const EnvelopeSchema = z.object({
  messageId: z.string().trim().min(1).max(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string(),
  data: SubmitWagerSchema.extend({ idempotencyKey: z.string().trim().min(1).max(255) }),
});

type Failure = { kind: 'permanent' | 'transient'; reason: string; detail: string };

function classify(err: unknown): Failure {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof ZodError) return { kind: 'permanent', reason: 'INVALID_MESSAGE', detail };
  if (err instanceof DomainError) return { kind: 'permanent', reason: err.code, detail };
  if (err instanceof TransientInfrastructureError) return { kind: 'transient', reason: 'TRANSIENT', detail };
  return { kind: 'transient', reason: 'UNEXPECTED', detail }; // limitado por maxReceiveCount
}

@Injectable()
export class WagerTransactionConsumer {
  private readonly logger = new Logger('WagerTransactionConsumer');
  private queueUrl?: string;
  private dlqUrl?: string;
  private running = false;
  private stopping = false;
  private loop?: Promise<void>;
  private abort?: AbortController;

  constructor(
    private readonly sqs: SQSClient,
    @Inject(SQS_CONFIG) private readonly config: SqsConfig,
    @Inject(CONSUMER_OPTIONS) private readonly options: ConsumerOptions,
    private readonly processWager: ProcessWagerTransaction,
    private readonly metrics: Metrics,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loop = this.run();
  }

  /** SIGTERM: para de buscar, conclui as mensagens em andamento e devolve as não iniciadas. */
  async stop(timeoutMs: number): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.abort?.abort();
    await Promise.race([this.loop ?? Promise.resolve(), Bun.sleep(timeoutMs)]);
  }

  /** Uma rodada de receive + processamento. Exposto para testes determinísticos. */
  async pollOnce(): Promise<number> {
    const queueUrl = await this.mainQueueUrl();
    this.abort = new AbortController();

    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: this.options.maxMessages,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        AttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
      { abortSignal: this.abort.signal },
    );

    const messages = response.Messages ?? [];
    if (messages.length === 0) return 0;

    // Ordem dentro do grupo (wallet), paralelismo entre grupos
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }

    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
    return messages.length;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (!this.running) break; // abort do long polling no shutdown
        this.logger.error('poll failed', err instanceof Error ? err.stack : String(err));
        await Bun.sleep(1_000);
      }
    }
  }

  private async processGroup(messages: Message[]): Promise<void> {
    for (let i = 0; i < messages.length; i++) {
      if (this.stopping) {
        await this.releaseAll(messages.slice(i));
        return;
      }
      const settled = await this.handle(messages[i]!);
      if (!settled) {
        // A mensagem foi reagendada: as seguintes do grupo voltam para a fila sem serem processadas.
        // O FIFO só as entrega de novo depois dela, e a ordem dentro do grupo se mantém.
        await this.releaseAll(messages.slice(i + 1));
        return;
      }
    }
  }

  /** true se a mensagem saiu da fila (ack ou DLQ); false se foi reagendada para retry. */
  private handle(message: Message): Promise<boolean> {
    return LogContext.run({ messageId: message.MessageId }, () => this.handleInContext(message));
  }

  private async handleInContext(message: Message): Promise<boolean> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    let envelope: z.infer<typeof EnvelopeSchema>;
    try {
      envelope = EnvelopeSchema.parse(JSON.parse(message.Body ?? ''));
    } catch (err) {
      await this.deadLetter(message, 'INVALID_MESSAGE', err instanceof Error ? err.message : String(err), receiveCount);
      return true;
    }

    LogContext.assign({
      messageId: envelope.messageId,
      correlationId: envelope.messageId,
      providerId: envelope.data.providerId,
      walletId: envelope.data.walletId,
    });

    const startedAt = performance.now();
    try {
      const { idempotencyKey, ...data } = envelope.data;
      const result = await this.processWager.execute({
        ...data,
        idempotencyKey,
        correlationId: envelope.messageId,
        source: { type: 'sqs', consumerName: WAGER_CONSUMER_NAME, messageId: envelope.messageId },
      });

      this.metrics.transactionCompleted(result.status, 'sqs', (performance.now() - startedAt) / 1000);
      if (result.idempotentReplay) this.metrics.duplicateDetected('sqs');

      // Fault injection (somente testes): simula o processo morrendo após o commit e antes do ack
      if (process.env.CHAOS_EXIT_BEFORE_ACK === 'true') {
        this.logger.warn('CHAOS: exiting after commit, before ack');
        process.exit(137);
      }

      // execute() só retorna depois do commit: ack é sempre pós-commit
      await this.ack(message);
      return true;
    } catch (err) {
      const failure = classify(err);

      if (failure.kind === 'permanent') {
        await this.deadLetter(message, failure.reason, failure.detail, receiveCount);
        return true;
      }
      if (receiveCount >= this.options.maxReceiveCount) {
        await this.deadLetter(message, 'RETRIES_EXHAUSTED', failure.detail, receiveCount);
        return true;
      }

      const delay = Math.min(
        this.options.retryBaseSeconds * 2 ** (receiveCount - 1),
        this.options.retryMaxSeconds,
      );
      this.metrics.retryScheduled('consumer');
      this.logger.warn(`retrying message ${envelope.messageId} in ${delay}s (attempt ${receiveCount}): ${failure.detail}`);
      await this.changeVisibility(message, delay);
      return false;
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: await this.mainQueueUrl(), ReceiptHandle: message.ReceiptHandle }),
    );
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.mainQueueUrl(),
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  private async releaseAll(messages: Message[]): Promise<void> {
    await Promise.all(messages.map((m) => this.changeVisibility(m, 0).catch(() => undefined)));
  }

  /** Envia à DLQ com o motivo e só então remove da fila principal. */
  private async deadLetter(message: Message, reason: string, detail: string, receiveCount: number): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.deadLetterQueueUrl(),
        MessageBody: message.Body || '{}',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          failureDetail: { DataType: 'String', StringValue: (detail || reason).slice(0, 1000) },
          receiveCount: { DataType: 'Number', StringValue: String(receiveCount) },
        },
      }),
    );
    await this.ack(message);
    this.metrics.deadLettered(reason);
    this.logger.warn(`message ${message.MessageId} sent to DLQ: ${reason}`);
  }

  private async mainQueueUrl(): Promise<string> {
    this.queueUrl ??= await this.resolveUrl(this.config.wagerQueue);
    return this.queueUrl;
  }

  private async deadLetterQueueUrl(): Promise<string> {
    this.dlqUrl ??= await this.resolveUrl(this.config.wagerDlq);
    return this.dlqUrl;
  }

  private async resolveUrl(name: string): Promise<string> {
    const res = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!res.QueueUrl) throw new Error(`queue ${name} not found`);
    return res.QueueUrl;
  }
}