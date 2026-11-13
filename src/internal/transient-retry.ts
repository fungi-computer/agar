import * as z from "zod";
import { AppError } from "../errors.js";

const statusFact = z.looseObject({ status: z.number() });

/** Retries after the first failure; the error state returns when they run out. */
const retries = 3;

const networkMessage =
  /network ?(?:changed|error)|failed to fetch|load failed|network connection was lost/iu;

function causes(error: AppError): unknown[] {
  // `cause` is the native Error option; each step is read, never assumed.
  const chain: unknown[] = [];
  for (
    let current: unknown = error;
    current !== undefined && chain.length < 5;
    current = current instanceof Error ? current.cause : undefined
  )
    chain.push(current);
  return chain;
}

/**
 * A read failed in transit, not by decision: a fetch TypeError, a browser
 * network-change error, a 5xx status, or the host's generic retryable remote
 * failure. Typed refusals, 4xx statuses and unexpected errors are final.
 */
function isTransientReadFailure(error: AppError): boolean {
  return causes(error).some((cause) => {
    if (cause instanceof TypeError) return true;
    if (cause instanceof AppError)
      return cause.code === "HOST_FAILURE" && cause.retryable;
    const status = statusFact.safeParse(cause);
    if (status.success) return status.data.status >= 500;
    return cause instanceof Error && networkMessage.test(cause.message);
  });
}

/** TanStack `retry` for reads: bounded, transient failures only. */
export function retryTransientRead(
  failureCount: number,
  error: AppError,
): boolean {
  return failureCount < retries && isTransientReadFailure(error);
}

/** TanStack `retryDelay`: 250ms, 500ms, 1s. */
export function transientReadDelay(failureCount: number): number {
  return 250 * 2 ** failureCount;
}
