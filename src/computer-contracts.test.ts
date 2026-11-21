import { expect, it } from "vitest";
import * as computerContracts from "./computer-contracts.js";
import {
  appComputerAdmissionRefusalSchema,
  appComputerDispatchRefusalSchema,
  appComputerExecTimeoutSchema,
  appComputerInputRefusalSchema,
  appComputerPlainRefusalSchema,
  appComputerRefusalCodeSchema,
  appComputerUnavailableSchema,
  connectorOperationBudgetKindSchema,
  connectorOperationBudgetRefusalSchema,
  computerRefusalMessage,
} from "./computer-contracts.js";

it("exports only public Computer outcomes, not host credential contracts", () => {
  expect(Object.keys(computerContracts).sort()).toEqual(
    [
      "appComputerAdmissionRefusalSchema",
      "appComputerDispatchRefusalSchema",
      "appComputerExecTimeoutSchema",
      "appComputerInputRefusalSchema",
      "appComputerNamedRefusalSchema",
      "appComputerPlainRefusalSchema",
      "appComputerRefusalCodeSchema",
      "appComputerUnavailableSchema",
      "connectorOperationBudgetKindSchema",
      "computerRefusalMessage",
      "connectorOperationBudgetRefusalSchema",
    ].sort(),
  );
});

it("retains each existing admission and attachment budget outcome", () => {
  for (const error of [
    "revoked",
    "not_granted",
    "command_list",
    "grantor_lost_authority",
    "unavailable",
  ]) {
    const result = { error };
    expect(appComputerAdmissionRefusalSchema.parse(result)).toEqual(result);
  }
  for (const kind of ["exec", "write", "media"]) {
    const result = {
      error: "attachment_budget_exceeded",
      kind,
      retryAfterMs: 123,
    };
    expect(connectorOperationBudgetKindSchema.parse(kind)).toBe(kind);
    expect(connectorOperationBudgetRefusalSchema.parse(result)).toEqual(result);
    expect(appComputerAdmissionRefusalSchema.parse(result)).toEqual(result);
  }
  expect(
    connectorOperationBudgetRefusalSchema.safeParse({
      error: "attachment_budget_exceeded",
      kind: "exec",
    }).success,
  ).toBe(false);
});

it("closes exactly the current argument, dispatch and timeout branches", () => {
  for (const error of ["too_large", "invalid_path", "invalid"]) {
    expect(appComputerInputRefusalSchema.parse({ error })).toEqual({ error });
  }
  for (const error of [
    "not_granted",
    "command_list",
    "too_large",
    "conflict",
    "capacity",
    "unfunded",
    "admission_unavailable",
    "backend_unavailable",
    "unavailable",
  ]) {
    expect(appComputerDispatchRefusalSchema.parse({ error })).toEqual({
      error,
    });
  }
  const unknown = { error: "unavailable", ref: "request-from-owner" };
  expect(appComputerDispatchRefusalSchema.parse(unknown)).toEqual(unknown);
  expect(appComputerAdmissionRefusalSchema.parse(unknown)).toEqual(unknown);
  expect(appComputerPlainRefusalSchema.parse(unknown)).toEqual(unknown);
  // Only an unknown cause carries a ref; a named cause is its own answer.
  expect(
    appComputerDispatchRefusalSchema.safeParse({ error: "capacity", ref: "x" })
      .success,
  ).toBe(false);
  expect(
    appComputerUnavailableSchema.safeParse({ error: "unavailable", ref: "" })
      .success,
  ).toBe(false);
  expect(
    appComputerUnavailableSchema.safeParse({ error: "unavailable" }).success,
  ).toBe(false);
  const timeout = { error: "timeout", requestId: "request-from-owner" };
  expect(appComputerExecTimeoutSchema.parse(timeout)).toEqual(timeout);
  expect(
    appComputerExecTimeoutSchema.safeParse({ error: "timeout" }).success,
  ).toBe(false);
  expect(
    appComputerInputRefusalSchema.safeParse({ error: "invalid_request" })
      .success,
  ).toBe(false);
});

it("never admits a Loader refusal envelope or silently drops extra fields", () => {
  for (const decoder of [
    appComputerAdmissionRefusalSchema,
    appComputerInputRefusalSchema,
    appComputerDispatchRefusalSchema,
    appComputerExecTimeoutSchema,
    connectorOperationBudgetRefusalSchema,
  ]) {
    expect(
      decoder.safeParse({ kind: "local_refusal", code: "not_granted" }).success,
    ).toBe(false);
    expect(
      decoder.safeParse({ error: "unavailable", kind: "local_refusal" })
        .success,
    ).toBe(false);
    expect(decoder.safeParse({ error: "future_error" }).success).toBe(false);
  }
});

it("words every Computer refusal code as a plain sentence, never the code", () => {
  for (const code of appComputerRefusalCodeSchema.options) {
    const sentence = computerRefusalMessage(code);
    expect(sentence).toMatch(/^[A-Z].*\.$/u);
    expect(sentence).not.toContain(code);
    expect(sentence).not.toContain("ref");
  }
  expect(computerRefusalMessage("unavailable", "req_123")).toBe(
    "The Computer didn't answer, and we don't know why yet (ref req_123).",
  );
  expect(computerRefusalMessage("capacity")).toBe(
    "The Computer's host is full right now. Try again in a minute.",
  );
});

it("accepts every plain code an App passes on, and no budget or timeout shape", () => {
  for (const error of appComputerRefusalCodeSchema.options)
    expect(appComputerPlainRefusalSchema.safeParse({ error }).success).toBe(
      error !== "attachment_budget_exceeded" && error !== "timeout",
    );
});
