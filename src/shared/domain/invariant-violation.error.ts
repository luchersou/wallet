/**
 * Erro de programação: o código tentou produzir um estado impossível.
 * Não é caminho de negócio e não carrega failureCode.
 */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}