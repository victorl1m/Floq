export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function badRequest(message: string, code = "bad_request"): HttpError {
  return new HttpError(400, code, message);
}

export function unauthorized(message = "Missing or invalid token"): HttpError {
  return new HttpError(401, "unauthorized", message);
}

export function forbidden(message = "Origin not allowed"): HttpError {
  return new HttpError(403, "forbidden", message);
}

export function notFound(message = "Not found"): HttpError {
  return new HttpError(404, "not_found", message);
}

export function conflict(message: string, code = "conflict"): HttpError {
  return new HttpError(409, code, message);
}

export function tooMany(message: string): HttpError {
  return new HttpError(429, "too_many_sessions", message);
}

export function unavailable(message: string, code = "shard_unavailable"): HttpError {
  return new HttpError(503, code, message);
}
