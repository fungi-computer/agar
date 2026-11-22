import { inspect } from "node:util";
import * as Redacted from "effect/Redacted";
import { afterEach, expect, it, vi } from "vitest";
import { reportCatchFailure } from "./failure.js";

afterEach(() => vi.restoreAllMocks());

const marker = "synthetic-private-cause-marker";
const nested = new Error(`Nested I/O failure ${marker}`);
const failure = new Error(`Operation failed ${marker}`, { cause: nested });

it.each([failure, marker])(
  "Agar reporter retains the redacted caught value (case %#)",
  (cause) => {
    const report = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    reportCatchFailure("fixture.read", cause);
    expect(report).toHaveBeenCalledOnce();
    const retained = report.mock.calls
      .flatMap((args: unknown[]) => args)
      .filter(Redacted.isRedacted)
      .map(Redacted.value);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toBe(cause);
    if (retained[0] instanceof Error) {
      expect(retained[0].cause).toBe(nested);
      expect(retained[0].stack).toBe(failure.stack);
    }
    expect(JSON.stringify(report.mock.calls)).toContain("fixture.read");
    expect(JSON.stringify(report.mock.calls)).not.toContain(marker);
    expect(inspect(report.mock.calls, { depth: null })).not.toContain(marker);
    expect(
      report.mock.calls
        .flatMap((args: unknown[]) => args)
        .map(String)
        .join(" "),
    ).not.toContain(marker);
  },
);

it("names an owned failure code and never a free-form message", () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const refusal = Object.assign(new Error(`secret ${marker}`), {
    code: "unavailable",
  });
  reportCatchFailure("fixture.read", refusal);
  reportCatchFailure(
    "fixture.read",
    Object.assign(new Error("x"), { code: `leaks ${marker}` }),
  );
  expect(JSON.parse(String(report.mock.calls[0]?.[0]))).toEqual({
    source: "agar",
    operation: "fixture.read",
    failureKind: "Error",
    code: "unavailable",
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain(marker);
});
