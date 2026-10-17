import { InvalidPayloadError } from '../../../shared/domain/invalid-payload.error';

/** Cursor opaco e estável: base64url de { v: walletVersion } — sequência imutável por wallet. */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof parsed.v === 'number' && Number.isInteger(parsed.v) && parsed.v >= 1) return parsed.v;
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidPayloadError('Invalid ledger cursor');
}