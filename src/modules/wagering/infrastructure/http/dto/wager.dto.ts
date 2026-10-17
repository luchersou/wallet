import { z } from 'zod';
import { MoneySchema } from '../../../../../shared/infrastructure/http/zod.pipe';

const text = (max: number) => z.string().trim().min(1).max(max);

export const SubmitWagerSchema = z.object({
  providerId: text(100),
  externalTransactionId: text(200),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: text(200),
  gameId: text(200),
  kind: text(20),
  money: MoneySchema,
  referenceExternalTransactionId: text(200).optional(),
});
export type SubmitWagerDto = z.infer<typeof SubmitWagerSchema>;