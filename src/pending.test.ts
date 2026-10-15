import { describe, expect, test } from "vitest";
import * as agar from "./index.js";

describe("App method Pending", () => {
  test("constructs and decodes the bounded polling result through the public package", () => {
    expect(agar.pending(5000)).toEqual({ kind: "pending", retryAfterMs: 5000 });
    for (const retryAfterMs of [1000, 60000]) {
      expect(agar.pendingSchema.parse(agar.pending(retryAfterMs))).toEqual({
        kind: "pending",
        retryAfterMs,
      });
    }
    for (const retryAfterMs of [999, 60001, 1000.5, NaN, Infinity]) {
      expect(() => agar.pending(retryAfterMs)).toThrow();
      expect(
        agar.pendingSchema.safeParse({ kind: "pending", retryAfterMs }).success,
      ).toBe(false);
    }
    expect(
      agar.pendingSchema.safeParse({
        kind: "pending",
        retryAfterMs: 5000,
        output: "extra",
      }).success,
    ).toBe(false);
  });
});
