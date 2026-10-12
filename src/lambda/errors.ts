/** A request the API refuses; the router answers with `status` and this message. */
export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
