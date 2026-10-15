import { expect, it } from "vitest";
import { statusText } from "./status.js";

it("cleans person-supplied text into one bounded status line", () => {
  expect(statusText("  my‮older\nname  ")).toBe("my older name");
  expect(statusText("x".repeat(100))).toHaveLength(80);
  expect(statusText("x".repeat(100)).endsWith("…")).toBe(true);
  expect(statusText("/a/very/long/path", 8)).toBe("/a/very…");
});
