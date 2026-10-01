export class LastfmApiError extends Error {
  public readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'LastfmApiError';
    this.code = code;
  }
}
