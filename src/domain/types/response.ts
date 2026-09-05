import { ResponseStatus } from '@domain/enums/responseStatus';

export class Response<T> {
  public readonly status: ResponseStatus;
  public readonly result?: T;

  private constructor(status: ResponseStatus, result?: T) {
    this.status = status;
    this.result = result;
  }

  public static success<TData>(result: TData): Response<TData> {
    return new Response<TData>(ResponseStatus.Success, result);
  }

  public static failure<TData>(status: ResponseStatus): Response<TData> {
    return new Response<TData>(status);
  }

  public get isSuccess(): boolean {
    return this.status === ResponseStatus.Success;
  }
}
