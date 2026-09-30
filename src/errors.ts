export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const invalid = (message: string, details?: unknown) =>
  new AppError("INVALID_PARAMETER", message, 400, details);

export const notFound = (message: string) =>
  new AppError("NOT_FOUND", message, 404);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(code, message, 409, details);
