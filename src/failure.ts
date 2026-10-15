import * as Redacted from "effect/Redacted";

/** Retain the original Agar failure without printing exception or request data. */
export function reportCatchFailure(operation: string, cause: unknown): void {
  console.error(
    JSON.stringify({
      source: "agar",
      operation,
      failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
    }),
    Redacted.make(cause),
  );
}
