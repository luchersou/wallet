import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';

/** sha256 (hex minúsculo) do JSON canônico. */
export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}