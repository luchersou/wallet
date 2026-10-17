import { Migration } from '@mikro-orm/migrations';

export class Migration20261015000002_wager_transactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wager_transactions (
        id                                 uuid primary key,
        provider_id                        text not null,
        external_transaction_id            text not null,
        idempotency_key                    text not null,
        payload_hash                       char(64) not null,
        wallet_id                          uuid not null,
        player_id                          uuid not null,
        currency                           char(3) not null,
        round_id                           text not null,
        game_id                            text not null,
        kind                               text not null,
        amount                             numeric(19,2) not null,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid,
        status                             text not null,
        failure_code                       text,
        observed_balance                   numeric(19,2),
        reference_attempts                 integer not null default 0,
        next_reference_attempt_at          timestamptz,
        created_at                         timestamptz not null,
        updated_at                         timestamptz not null,
        processed_at                       timestamptz,

        constraint wager_tx_wallet_identity_fk foreign key (wallet_id, player_id, currency)
          references wallets (id, player_id, currency),
        constraint wager_tx_reference_fk foreign key (reference_transaction_id)
          references wager_transactions (id),

        constraint wager_tx_provider_idempotency_uq unique (provider_id, idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        constraint wager_tx_ledger_ref_uq unique (id, wallet_id, currency),

        constraint wager_tx_kind_chk check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_tx_status_chk check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_tx_amount_chk check (amount > 0 or (kind = 'LOSS' and amount >= 0)),
        constraint wager_tx_opening_system_chk check ((kind = 'OPENING') = (provider_id = '__system__')),
        constraint wager_tx_reference_required_chk check (
          kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_reference_forbidden_chk check (
          kind not in ('OPENING','BET','LOSS') or reference_external_transaction_id is null),
        constraint wager_tx_processed_reversal_chk check (
          status <> 'PROCESSED' or kind not in ('REFUND','ROLLBACK') or reference_transaction_id is not null),
        constraint wager_tx_failure_code_chk check (
          (status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_tx_processed_at_chk check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_tx_observed_balance_chk check (
          status not in ('PROCESSED','REJECTED') or observed_balance is not null),
        constraint wager_tx_observed_balance_non_negative_chk check (observed_balance >= 0),
        constraint wager_tx_reference_attempts_chk check (reference_attempts >= 0)
      );
    `);

    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
    `);
    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      create index wager_tx_waiting_reference_idx
        on wager_transactions (provider_id, reference_external_transaction_id)
        where reference_external_transaction_id is not null;
    `);
    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id, created_at);`);

    this.addSql(`
      create function wager_tx_guard_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'wager_transaction % is terminal (%)', old.id, old.status
            using errcode = 'check_violation';
        end if;
        if (new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.currency, new.round_id, new.game_id, new.kind,
            new.amount, new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.currency, old.round_id, old.game_id, old.kind,
            old.amount, old.reference_external_transaction_id, old.created_at) then
          raise exception 'immutable columns of wager_transaction % cannot change', old.id
            using errcode = 'check_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger wager_tx_guard_update_trg before update on wager_transactions
        for each row execute function wager_tx_guard_update();
    `);
    this.addSql(`
      create trigger wager_tx_no_delete_trg before delete on wager_transactions
        for each row execute function forbid_row_mutation();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table wager_transactions;`);
    this.addSql(`drop function wager_tx_guard_update();`);
  }
}