import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

const ownedCode = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/)),
});
/** An Agar-owned refusal code such as `unavailable`; never free-form text. */
const failureCode = (cause: unknown): string | undefined => {
  const parsed = Schema.decodeUnknownOption(ownedCode)(cause);
  return Option.isSome(parsed) && cause instanceof Error
    ? parsed.value.code
    : undefined;
};

/**
 * Retain the original Agar failure without printing exception or request
 * data. The line names the operation and, when the failure carries one, its
 * owned code, so a console reader sees the cause without secrets or payloads.
 */
export function reportCatchFailure(operation: string, cause: unknown): void {
  const base = {
    source: "agar",
    operation,
    failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
  };
  const code = failureCode(cause);
  const entry = code === undefined ? base : { ...base, code };
  console.error(JSON.stringify(entry), Redacted.make(cause));
}
