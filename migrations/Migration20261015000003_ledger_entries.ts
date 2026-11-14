import { Migration } from '@mikro-orm/migrations';

export class Migration20261015000003_ledger_entries extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        wallet_id       uuid not null,
        transaction_id  uuid not null,
        direction       text not null,
        amount          numeric(19,2) not null,
        currency        char(3) not null,
        balance_before  numeric(19,2) not null,
        balance_after   numeric(19,2) not null,
        wallet_version  integer not null,
        created_at      timestamptz not null,

        constraint ledger_wallet_fk foreign key (wallet_id) references wallets (id),
        constraint ledger_transaction_fk foreign key (transaction_id, wallet_id, currency)
          references wager_transactions (id, wallet_id, currency),
        constraint ledger_one_entry_per_transaction_uq unique (transaction_id),
        constraint ledger_wallet_version_uq unique (wallet_id, wallet_version),
        constraint ledger_direction_chk check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive_chk check (amount > 0),
        constraint ledger_balances_non_negative_chk check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_wallet_version_positive_chk check (wallet_version >= 1),
        constraint ledger_arithmetic_chk check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount))
      );
    `);

    this.addSql(`
      create trigger ledger_append_only_trg before update or delete on wallet_ledger_entries
        for each row execute function forbid_row_mutation();
    `);

    // Chaining: balance_before of entry N == balance_after of entry N-1
    // First entry of the wallet: starts at 0, with version 1 (opening with balance)
    // or 2 (first movement of a wallet opened with zero balance, which starts at v1 with no ledger).
    this.addSql(`
      create function ledger_check_chain() returns trigger language plpgsql as $$
      declare
        previous_after numeric(19,2);
        has_entries boolean;
      begin
        select exists (select 1 from wallet_ledger_entries where wallet_id = new.wallet_id)
          into has_entries;

        if not has_entries then
          if new.balance_before <> 0 or new.wallet_version not in (1, 2) then
            raise exception 'first ledger entry of wallet % must start at 0 with version 1 or 2', new.wallet_id
              using errcode = 'check_violation';
          end if;
          return new;
        end if;

        select balance_after into previous_after
          from wallet_ledger_entries
         where wallet_id = new.wallet_id and wallet_version = new.wallet_version - 1;

        if previous_after is null or previous_after <> new.balance_before then
          raise exception 'ledger chain broken for wallet % at version %', new.wallet_id, new.wallet_version
            using errcode = 'check_violation';
        end if;
        return new;
      end $$;
    `);
    this.addSql(`
      create trigger ledger_check_chain_trg before insert on wallet_ledger_entries
        for each row execute function ledger_check_chain();
    `);

    // Common check: wallet balance == balance_after of the current version's entry
    this.addSql(`
      create function assert_wallet_matches_ledger(p_wallet_id uuid) returns void language plpgsql as $$
      begin
        if not exists (
          select 1 from wallets w
           where w.id = p_wallet_id
             and (
               (w.version = 1 and w.balance = 0
                 and not exists (select 1 from wallet_ledger_entries l where l.wallet_id = w.id))
               or exists (
                 select 1 from wallet_ledger_entries l
                  where l.wallet_id = w.id
                    and l.wallet_version = w.version
                    and l.balance_after = w.balance)
             )
        ) then
          raise exception 'wallet % balance does not match its ledger', p_wallet_id
            using errcode = 'check_violation';
        end if;
      end $$;
    `);

    // One function per table: NEW has a different shape in each one
    this.addSql(`
      create function wallet_matches_ledger_on_wallet() returns trigger language plpgsql as $$
      begin
        perform assert_wallet_matches_ledger(new.id);
        return null;
      end $$;
    `);
    this.addSql(`
      create function wallet_matches_ledger_on_entry() returns trigger language plpgsql as $$
      begin
        perform assert_wallet_matches_ledger(new.wallet_id);
        return null;
      end $$;
    `);

    this.addSql(`
      create constraint trigger wallet_matches_ledger_on_wallet_trg
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallet_matches_ledger_on_wallet();
    `);
    this.addSql(`
      create constraint trigger wallet_matches_ledger_on_entry_trg
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_matches_ledger_on_entry();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger wallet_matches_ledger_on_wallet_trg on wallets;`);
    this.addSql(`drop table wallet_ledger_entries;`);
    this.addSql(`drop function wallet_matches_ledger_on_wallet();`);
    this.addSql(`drop function wallet_matches_ledger_on_entry();`);
    this.addSql(`drop function assert_wallet_matches_ledger(uuid);`);
    this.addSql(`drop function ledger_check_chain();`);
  }
}