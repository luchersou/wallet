import { InvalidPayloadError } from '../../../shared/domain/invalid-payload.error';

/** Opaque, stable cursor: base64url of { v: walletVersion } — immutable sequence per wallet. */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v >= 1) return parsed.v;
  } catch {
    // falls through to the error below
  }
  throw new InvalidPayloadError('Invalid ledger cursor');
}