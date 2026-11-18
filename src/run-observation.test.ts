import { describe, expect, it } from "vitest";
import {
  runObservationLogSchema,
  runObservationSchema,
  runObservationStateSchema,
} from "./run-observation.js";

const base = {
  source: "shed.process",
  id: "proc_1",
  state: "running",
  requestedAt: 1,
  log: null,
  outputs: [],
  cost: null,
} as const;

describe("RunObservation contract", () => {
  it("names every state, including completed apart from verified", () => {
    expect(runObservationStateSchema.options).toEqual([
      "requested",
      "admitted",
      "running",
      "needs_review",
      "completed",
      "verified",
      "failed",
      "cancelled",
      "unknown",
    ]);
  });

  it("accepts a minimal run and a full one", () => {
    expect(runObservationSchema.parse(base)).toEqual(base);
    const full = {
      ...base,
      source: "oyster.build",
      parentId: "build_0",
      sourceRevision: "abc123",
      state: "failed",
      reason: "computer_slept",
      startedAt: 2,
      endedAt: 3,
      log: { cursor: 10, size: 10, eof: true },
      outputs: [{ kind: "log", ref: "/workspace/out.log" }],
      cost: { amount: 1.5, unit: "usd" },
    };
    expect(runObservationSchema.parse(full)).toEqual(full);
  });

  it("requires cost to be stated, null when unmetered", () => {
    expect(
      runObservationSchema.safeParse({ ...base, cost: undefined }).success,
    ).toBe(false);
    expect(
      runObservationSchema.safeParse({
        ...base,
        cost: { amount: -1, unit: "usd" },
      }).success,
    ).toBe(false);
  });

  it("refuses unknown fields, sources, states and reasons that are not codes", () => {
    for (const bad of [
      { ...base, extra: true },
      { ...base, source: "other" },
      { ...base, state: "exited" },
      { ...base, reason: "Computer slept" },
      { ...base, id: "" },
    ])
      expect(runObservationSchema.safeParse(bad).success).toBe(false);
  });

  it("keeps a log cursor inside its size and at the size at eof", () => {
    expect(
      runObservationLogSchema.parse({ cursor: 4, size: 9, eof: false }),
    ).toEqual({ cursor: 4, size: 9, eof: false });
    for (const bad of [
      { cursor: 9, size: 4, eof: false },
      { cursor: 4, size: 9, eof: true },
      { cursor: -1, size: 9, eof: false },
    ])
      expect(runObservationLogSchema.safeParse(bad).success).toBe(false);
  });
});
