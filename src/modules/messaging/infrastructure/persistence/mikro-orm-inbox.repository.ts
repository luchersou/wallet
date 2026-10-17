import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../domain/inbox-message';
import { InboxRepository } from '../../application/ports/inbox.repository';
import { InboxRecord } from './messaging.schema';

@Injectable()
export class MikroOrmInboxRepository extends InboxRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async tryRegister(message: InboxMessage): Promise<boolean> {
    // Concorrentes com o mesmo id: o segundo espera o commit do primeiro e cai no conflito.
    const rows = (await this.em.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    )) as { message_id: string }[];
    return rows.length > 0;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const r = await this.em.findOne(InboxRecord, { consumerName, messageId });
    return r
      ? InboxMessage.rehydrate({
          consumerName: r.consumerName,
          messageId: r.messageId,
          payloadHash: r.payloadHash,
          receivedAt: r.receivedAt,
          processedAt: r.processedAt ?? undefined,
        })
      : undefined;
  }
}