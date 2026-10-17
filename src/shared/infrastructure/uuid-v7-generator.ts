import { Injectable } from '@nestjs/common';
import { IdGenerator } from '../application/ports/id-generator.port';

@Injectable()
export class UuidV7Generator extends IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}