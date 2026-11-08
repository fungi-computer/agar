import { AppError, type AppErrorCode } from "../errors.js";
import { parseErrorData } from "./schemas.js";

export type AppErrorData = {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Only `SETUP_REQUIRED` carries one: what the person must set up. */
  readonly need?: string;
};

export function appErrorData(cause: unknown): AppErrorData {
  if (cause instanceof AppError) {
    return {
      code: cause.code,
      message: bounded(cause.message),
      retryable: cause.retryable,
      ...(cause.need !== undefined && { need: cause.need }),
    };
  }
  return {
    code: "HOST_FAILURE",
    message: "Host operation failed",
    retryable: false,
  };
}

export function appErrorFromData(value: AppErrorData): AppError {
  try {
    const parsed = parseErrorData(value);
    return new AppError(parsed.message, {
      code: parsed.code,
      retryable: parsed.retryable,
      ...(parsed.need !== undefined && { need: parsed.need }),
    });
  } catch (cause) {
    return new AppError("The host returned a malformed error", {
      cause,
      code: "PROTOCOL",
      retryable: false,
    });
  }
}

function bounded(message: string): string {
  const clean = message.trim().slice(0, 512);
  return clean || "Host operation failed";
}
