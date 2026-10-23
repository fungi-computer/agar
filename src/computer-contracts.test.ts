import { expect, it } from "vitest";
import * as computerContracts from "./computer-contracts.js";
import {
  appComputerAdmissionRefusalSchema,
  appComputerDispatchRefusalSchema,
  appComputerExecTimeoutSchema,
  appComputerInputRefusalSchema,
  connectorOperationBudgetKindSchema,
  connectorOperationBudgetRefusalSchema,
} from "./computer-contracts.js";

it("exports only public Computer outcomes, not host credential contracts", () => {
  expect(Object.keys(computerContracts).sort()).toEqual(
    [
      "appComputerAdmissionRefusalSchema",
      "appComputerDispatchRefusalSchema",
      "appComputerExecTimeoutSchema",
      "appComputerInputRefusalSchema",
      "connectorOperationBudgetKindSchema",
      "connectorOperationBudgetRefusalSchema",
    ].sort(),
  );
});

it("retains each existing admission and attachment budget outcome", () => {
  for (const error of [
    "revoked",
    "not_granted",
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
  for (const error of ["not_granted", "too_large", "conflict", "unavailable"]) {
    expect(appComputerDispatchRefusalSchema.parse({ error })).toEqual({
      error,
    });
  }
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
