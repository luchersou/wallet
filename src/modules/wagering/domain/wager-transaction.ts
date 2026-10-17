import type { FailureCode } from '../../../shared/domain/failure-code';
import { InvariantViolationError } from '../../../shared/domain/invariant-violation.error';
import type { Money } from '../../../shared/domain/money';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import { WagerTransactionKind as Kind } from './wager-transaction-kind';
import { WagerTransactionStatus as Status } from './wager-transaction-status';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from './wagering.errors';

export const SYSTEM_PROVIDER_ID = '__system__';

const TERMINAL = new Set<Status>([Status.Processed, Status.Rejected, Status.Failed]);
const REQUIRES_REFERENCE = new Set<Kind>([Kind.Refund, Kind.Rollback]);
const FORBIDS_REFERENCE = new Set<Kind>([Kind.Opening, Kind.Bet, Kind.Loss]);
const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
  at: Date;
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  at: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: Kind;
  money: Money;
  referenceExternalTransactionId?: string;
  status: Status;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  observedBalance?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  processedAt?: Date;
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: Kind;
  public readonly money: Money;
  /** id no provedor — não o id interno */
  public readonly referenceExternalTransactionId: string | undefined;
  public readonly createdAt: Date;

  private _status: Status;
  private _referenceTransactionId?: string;
  private _failureCode?: FailureCode;
  private _observedBalance?: Money;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt?: Date;
  private _updatedAt: Date;
  private _processedAt?: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._observedBalance = state.observedBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt = state.nextReferenceAttemptAt;
    this._updatedAt = state.updatedAt;
    this._processedAt = state.processedAt;
  }

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const required: (keyof CreateWagerTransactionProps)[] = [
      'id', 'providerId', 'externalTransactionId', 'idempotencyKey',
      'walletId', 'playerId', 'roundId', 'gameId',
    ];
    for (const field of required) {
      const value = props[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidWagerTransactionError(`${field} is required`);
      }
    }

    if (!Object.values(Kind).includes(props.kind)) {
      throw new InvalidWagerTransactionError(`unknown kind "${String(props.kind)}"`);
    }
    if ((props.kind === Kind.Opening) !== (props.providerId === SYSTEM_PROVIDER_ID)) {
      throw new InvalidWagerTransactionError('OPENING is internal and reserved to the system provider');
    }
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError('payloadHash must be a lowercase sha256 hex digest');
    }

    const amountValid = props.kind === Kind.Loss ? !props.money.isNegative() : props.money.isPositive();
    if (!amountValid) {
      throw new InvalidWagerTransactionError(`amount ${props.money.amount} not allowed for ${props.kind}`);
    }

    const ref = props.referenceExternalTransactionId;
    const hasRef = typeof ref === 'string' && ref.trim() !== '';
    if (REQUIRES_REFERENCE.has(props.kind) && !hasRef) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (FORBIDS_REFERENCE.has(props.kind) && ref !== undefined) {
      throw new InvalidWagerTransactionError(`${props.kind} must not have referenceExternalTransactionId`);
    }
    if (hasRef && ref === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('a transaction cannot reference itself');
    }

    return new WagerTransaction({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: hasRef ? ref : undefined,
      status: Status.Pending,
      referenceAttempts: 0,
      createdAt: props.at,
      updatedAt: props.at,
    });
  }

  /** Transação interna de abertura, já aplicada. */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    const externalId = `opening:${props.walletId}`;
    const tx = WagerTransaction.create({
      id: props.id,
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: externalId,
      idempotencyKey: `${SYSTEM_PROVIDER_ID}:${externalId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'system',
      kind: Kind.Opening,
      money: props.money,
      at: props.at,
    });
    tx.markProcessed(undefined, props.money, props.at);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  // ---- getters
  get status(): Status { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get observedBalance(): Money | undefined { return this._observedBalance; }
  get referenceAttempts(): number { return this._referenceAttempts; }
  get nextReferenceAttemptAt(): Date | undefined { return this._nextReferenceAttemptAt; }
  get updatedAt(): Date { return this._updatedAt; }
  get processedAt(): Date | undefined { return this._processedAt; }

  // ---- transições
  markProcessed(referenceTransactionId: string | undefined, observedBalance: Money, at: Date): void {
    this.assertTransition(Status.Processed, [Status.Pending, Status.PendingReference]);
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvariantViolationError(`${this.kind} cannot be processed without a resolved reference`);
    }
    this._status = Status.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
    this._processedAt = at;
    this._updatedAt = at;
  }

  markPendingReference(now: Date, policy: ReferenceRetryPolicy): void {
    this.assertTransition(Status.PendingReference, [Status.Pending]);
    if (!this.referenceExternalTransactionId) {
      throw new InvariantViolationError('only transactions with a reference can wait for it');
    }
    this._status = Status.PendingReference;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = policy.nextAttemptAt(now, 0);
    this._updatedAt = now;
  }

  scheduleReferenceRetry(now: Date, policy: ReferenceRetryPolicy): void {
    if (this._status !== Status.PendingReference) {
      throw new InvalidTransactionStateError(this.id, this._status, 'PENDING_REFERENCE (retry)');
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = policy.nextAttemptAt(now, this._referenceAttempts);
    this._updatedAt = now;
  }

  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertTransition(Status.Rejected, [Status.Pending, Status.PendingReference]);
    this._status = Status.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertTransition(Status.Failed, [Status.Pending, Status.PendingReference]);
    this._status = Status.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ---- consultas
  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  requiresReference(): boolean {
    return REQUIRES_REFERENCE.has(this.kind);
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  hasExhaustedReferenceRetries(policy: ReferenceRetryPolicy): boolean {
    return policy.isExhausted(this._referenceAttempts);
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Opening:
      case Kind.Win:
      case Kind.Refund:
        return LedgerDirection.Credit;
      case Kind.Rollback: {
        if (!reference) {
          throw new InvariantViolationError('ROLLBACK direction depends on its reference');
        }
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case Kind.Loss:
        throw new InvariantViolationError('LOSS does not produce a ledger entry');
    }
  }

  private assertTransition(to: Status, allowedFrom: Status[]): void {
    if (this.isTerminal() || !allowedFrom.includes(this._status)) {
      throw new InvalidTransactionStateError(this.id, this._status, to);
    }
  }
}