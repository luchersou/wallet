import type { InboxMessage } from '../../domain/inbox-message';

export abstract class InboxRepository {
  /** INSERT ... ON CONFLICT DO NOTHING. false = mensagem já registrada (duplicata). */
  abstract tryRegister(message: InboxMessage): Promise<boolean>;
  abstract find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}