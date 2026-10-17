import { z } from 'zod';
import { MoneySchema } from '../../../../../shared/infrastructure/http/zod.pipe';

export const OpenWalletSchema = z.object({
  playerId: z.uuid(),
  initialBalance: MoneySchema,
});
export type OpenWalletDto = z.infer<typeof OpenWalletSchema>;

export const LedgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type LedgerQueryDto = z.infer<typeof LedgerQuerySchema>;