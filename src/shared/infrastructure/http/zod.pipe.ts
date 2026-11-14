import type { PipeTransform } from '@nestjs/common';
import { z, type ZodType } from 'zod';

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}

export const UuidSchema = z.uuid();

/** Structural format; scale, sign and currency are validated by Money.from. */
export const MoneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});