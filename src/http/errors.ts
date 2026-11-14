export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function absent(): never {
  throw new ServiceError(404, "not-found", "Resource not found");
}
export function stale(): never {
  throw new ServiceError(409, "stale-mutation", "State changed; begin again explicitly");
}
