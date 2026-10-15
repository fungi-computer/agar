import { describe, expect, it } from "vitest";
import {
  appBuildReplySchema,
  appBuildBrokerResultSchema,
  teamAppBuildFailureCodeSchema,
} from "./app-build-contract.js";

describe("App build result contract", () => {
  it("retains pending, completed and owner failure replies", () => {
    const replies = [
      { kind: "pending", retryAfterMs: 1000 },
      { releaseId: "release_1", previewUrl: "https://preview.example.com" },
      ...["invalid", "denied", "conflict", "unavailable", "build_failed"].map(
        (error) => ({ error }),
      ),
    ];
    for (const reply of replies) {
      expect(appBuildReplySchema.parse(reply)).toEqual(reply);
      expect(appBuildBrokerResultSchema.parse(reply)).toEqual(reply);
    }
    expect(teamAppBuildFailureCodeSchema.options).toEqual([
      "invalid",
      "denied",
      "conflict",
      "unavailable",
      "build_failed",
    ]);
  });

  it("retains the broker error branch without widening successful replies", () => {
    expect(
      appBuildBrokerResultSchema.parse({ error: "invalid_request" }),
    ).toEqual({
      error: "invalid_request",
    });
    for (const reply of [
      { releaseId: "release_1" },
      { kind: "pending", retryAfterMs: 999 },
      { error: 42 },
      { error: "unavailable", extra: true },
    ]) {
      expect(appBuildBrokerResultSchema.safeParse(reply).success).toBe(false);
    }
    expect(
      appBuildReplySchema.safeParse({ error: "invalid_request" }).success,
    ).toBe(false);
  });
});
