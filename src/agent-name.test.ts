import { expect, it } from "vitest";
import { agentNameSchema } from "./agents.js";

it("accepts an ordinary name, trimmed, in any script or emoji", () => {
  for (const name of ["Shiitake", "  Crumb  ", "Ünï", "名前", "Moss 🍄"])
    expect(agentNameSchema.safeParse(name).success).toBe(true);
  expect(agentNameSchema.parse("  Crumb  ")).toBe("Crumb");
});

it("refuses empty, oversized and control, bidi or zero-width names", () => {
  const refused = [
    "",
    "   ",
    "x".repeat(257),
    "a\nb",
    "a\tb",
    "a\u0000b",
    "a\u202Ab",
    "a\u202Eb",
    "a\u2066b",
    "a\u2069b",
    "a\u200Bb",
    "a\u200Cb",
    "a\u200Db",
    "a\u2060b",
    "a\uFEFFb",
  ];
  for (const name of refused)
    expect(agentNameSchema.safeParse(name).success, JSON.stringify(name)).toBe(
      false,
    );
});
