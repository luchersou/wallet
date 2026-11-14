import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';

/** sha256 (lowercase hex) of the canonical JSON. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}