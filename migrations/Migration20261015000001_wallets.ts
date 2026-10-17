import { Migration } from '@mikro-orm/migrations';

export class Migration20261015000001_wallets extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function forbid_row_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'table % is append-only (% blocked)', tg_table_name, tg_op
          using errcode = 'check_violation';
      end $$;
    `);

    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   uuid not null,
        currency    char(3) not null,
        balance     numeric(19,2) not null,
        version     integer not null,
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint wallets_currency_format_chk check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative_chk check (balance >= 0),
        constraint wallets_version_positive_chk check (version >= 1),
        constraint wallets_player_currency_uq unique (player_id, currency),
        constraint wallets_identity_uq unique (id, player_id, currency)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table wallets;`);
    this.addSql(`drop function forbid_row_mutation();`);
  }
}