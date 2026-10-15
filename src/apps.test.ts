import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { appOpenInputSchema } from "./apps.js";

describe("App opening intent", () => {
  it("accepts a bounded role and compose text", () => {
    expect(
      Schema.decodeUnknownSync(appOpenInputSchema, {
        onExcessProperty: "error",
      })({
        role: "inbox",
        intent: { kind: "compose", text: "Make me a game about…" },
      }),
    ).toEqual({
      role: "inbox",
      intent: { kind: "compose", text: "Make me a game about…" },
    });
  });

  it("rejects unknown intents and overlong drafts", () => {
    for (const intent of [
      { kind: "send", text: "not allowed" },
      { kind: "compose", text: "x".repeat(2_001) },
    ])
      expect(() =>
        Schema.decodeUnknownSync(appOpenInputSchema, {
          onExcessProperty: "error",
        })({ role: "inbox", intent }),
      ).toThrow();
  });

  it("accepts a bounded generic navigation intent", () => {
    expect(
      Schema.decodeUnknownSync(appOpenInputSchema, {
        onExcessProperty: "error",
      })({
        role: "games",
        intent: {
          kind: "navigate",
          params: [{ key: "gameId", value: "game-a" }],
        },
      }).intent.kind,
    ).toBe("navigate");
  });
});

it("opens one explicit App identity and rejects ambiguous targets", () => {
  const decode = Schema.decodeUnknownSync(appOpenInputSchema, {
    onExcessProperty: "error",
  });
  expect(
    decode({ appId: "app_game", intent: { kind: "navigate", params: [] } }),
  ).toEqual({ appId: "app_game", intent: { kind: "navigate", params: [] } });
  expect(() =>
    decode({
      appId: "app_game",
      role: "games",
      intent: { kind: "navigate", params: [] },
    }),
  ).toThrow();
});

it("offers member App calls as an optional capability with owned JSON results", async () => {
  const apps = await import("./apps.js");
  expect(apps.appsCall.id).toBe("apps.call");
  const requests: string[] = [];
  const handle = apps.appsCall.schema.parse({
    call: (appId: string, method: string, input: string) => {
      requests.push(`${appId}:${method}:${input}`);
      return Promise.resolve({ text: "hello" });
    },
  });
  await expect(handle.call("app_bonsai", "files.read", "{}")).resolves.toEqual({
    text: "hello",
  });
  expect(requests).toEqual(["app_bonsai:files.read:{}"]);
});
