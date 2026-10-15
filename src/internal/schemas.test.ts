import { describe, expect, it } from "vitest";
import { rpcFailure, unwrapRpcResult } from "./result.js";
import { AppError } from "../errors.js";
import {
  parseBrowserAction,
  parseVoidResult,
  parseContext,
  parseNavigationState,
  parseNavigationStateInput,
} from "./schemas.js";

const context = {
  computerId: null,
  teamHasComputers: false,
  computerAccessGranted: false,
  focus: { editing: false, surface: null },
  visibility: "visible",
} as const;

it("preserves the non-retryable safety-filter verdict through the RPC failure codec", () => {
  const failure = new AppError(
    "The model's safety filter refused this prompt — try rewording.",
    {
      code: "SAFETY_FILTER_REFUSED",
      retryable: false,
    },
  );
  const parsed = parseVoidResult(rpcFailure(failure));
  expect(() => {
    unwrapRpcResult(parsed);
  }).toThrow(
    expect.objectContaining({
      code: "SAFETY_FILTER_REFUSED",
      retryable: false,
    }),
  );
});

describe("AppContext open request", () => {
  it("preserves host-owned Team Computer facts", () => {
    const parsed = parseContext({
      ...context,
      openRequest: null,
    });

    expect(parsed.teamHasComputers).toBe(false);
    expect(parsed.computerAccessGranted).toBe(false);
  });

  it("preserves an unknown Team Computer fact from the host", () => {
    const parsed = parseContext({
      ...context,
      teamHasComputers: null,
      openRequest: null,
    });

    expect(parsed.teamHasComputers).toBeNull();
  });

  it("rejects the removed Agent Session launch kind", () => {
    expect(() =>
      parseContext({
        ...context,
        openRequest: {
          kind: "open-agent-session",
          requestId: "grove-open-request-1",
          agentId: "agent-a",
          sessionId: "session-a",
        },
      }),
    ).toThrow(AppError);
  });

  it("copies a bounded navigation request at the host boundary", () => {
    const openRequest = {
      kind: "navigate",
      requestId: "app-open-1",
      params: [{ key: "level", value: "garden" }],
    };
    const parsed = parseContext({ ...context, openRequest });
    expect(parsed.openRequest).toEqual(openRequest);
    expect(Object.isFrozen(parsed.openRequest)).toBe(true);
  });

  it("preserves a full Computer path in an App navigation request", () => {
    const path = `/${"界".repeat(4095)}`;
    const openRequest = {
      kind: "navigate",
      requestId: "recent-file-open",
      params: [{ key: "path", value: path }],
    };
    const parsed = parseContext({ ...context, openRequest });
    expect(parsed.openRequest).toEqual(openRequest);
    expect(() =>
      parseContext({
        ...context,
        openRequest: {
          ...openRequest,
          params: [{ key: "path", value: `${path}x` }],
        },
      }),
    ).toThrow(AppError);
  });

  it("accepts a bounded compose intent without turning it into a prompt", () => {
    const parsed = parseContext({
      ...context,
      openRequest: {
        kind: "compose",
        requestId: "compose-1",
        text: "Make me a game about…",
      },
    });
    expect(parsed.openRequest).toEqual({
      kind: "compose",
      requestId: "compose-1",
      text: "Make me a game about…",
    });
    expect(Object.isFrozen(parsed.openRequest)).toBe(true);
    expect(() =>
      parseContext({
        ...context,
        openRequest: { kind: "compose", requestId: "compose-2", text: "" },
      }),
    ).toThrow(AppError);
  });

  it("rejects malformed or unknown launch requests", () => {
    for (const openRequest of [
      {
        kind: "open-agent-session",
        requestId: "",
        agentId: "agent-a",
        sessionId: "session-a",
      },
      {
        kind: "open-agent-session",
        requestId: "request-1",
        agentId: "agent-a",
        sessionId: "",
      },
      {
        kind: "open-agent-session",
        requestId: "request-1",
        agentId: "agent-a",
        sessionId: "session-a",
        extra: true,
      },
      {
        kind: "open-unknown",
        requestId: "request-1",
        agentId: "agent-a",
        sessionId: "session-a",
      },
      {
        kind: "play-game",
        requestId: "game-open-1",
        slug: "mossy-run",
        portalOrigin: "http://vishnu.shiit.app",
      },
    ]) {
      expect(() => parseContext({ ...context, openRequest })).toThrow(AppError);
    }
  });

  it("requires the current context contract's explicit null request", () => {
    expect(() => parseContext(context)).toThrow(AppError);
  });
});

describe("App navigation contract", () => {
  it("projects a version 1 report without its contract version", () => {
    expect(
      parseNavigationState({
        contractVersion: 1,
        canGoBack: true,
        title: "Leaderboard",
      }),
    ).toEqual({ canGoBack: true, title: "Leaderboard" });
    expect(
      parseNavigationState({ contractVersion: 1, canGoBack: false }),
    ).toEqual({ canGoBack: false });
  });

  it.each([
    { contractVersion: 2, canGoBack: true },
    { canGoBack: true },
    { contractVersion: 1, canGoBack: "yes" },
    { contractVersion: 1, canGoBack: true, title: "" },
    { contractVersion: 1, canGoBack: true, title: " padded " },
    { contractVersion: 1, canGoBack: true, title: "x".repeat(81) },
    { contractVersion: 1, canGoBack: true, href: "/secret" },
    null,
  ])("rejects a malformed host-edge report %#", (value) => {
    expect(() => parseNavigationState(value)).toThrow(AppError);
  });

  it("trims the App's title and drops an empty one before it travels", () => {
    expect(
      parseNavigationStateInput({ canGoBack: true, title: "  Detail  " }),
    ).toEqual({ contractVersion: 1, canGoBack: true, title: "Detail" });
    expect(parseNavigationStateInput({ canGoBack: false, title: " " })).toEqual(
      { contractVersion: 1, canGoBack: false },
    );
    expect(() =>
      parseNavigationStateInput({ canGoBack: true, title: "x".repeat(81) }),
    ).toThrow(AppError);
  });
});

it("preserves typed credit refusal in ordinary host RPC replies", () => {
  const failure = rpcFailure(
    new AppError("Credit is required", {
      code: "INSUFFICIENT_CREDIT",
      retryable: false,
    }),
  );
  const parsed = parseVoidResult(failure);
  expect(parsed).toMatchObject({
    ok: false,
    error: { code: "INSUFFICIENT_CREDIT", retryable: false },
  });
  expect(() => {
    unwrapRpcResult(parsed);
  }).toThrow(
    expect.objectContaining({ code: "INSUFFICIENT_CREDIT", retryable: false }),
  );
});

it("bounds browser actions by actual bytes and rejects filenames with a path", () => {
  expect(
    parseBrowserAction({
      kind: "saveFile",
      name: "../pond.json",
      mime: "application/json",
      bytes: new Uint8Array(),
    }),
  ).toEqual({ kind: "refused", reason: "invalid-request" });
  expect(
    parseBrowserAction({
      kind: "saveFile",
      name: "pond.bin",
      mime: "application/octet-stream",
      bytes: new Uint8Array(32 * 1024 * 1024 + 1),
    }),
  ).toEqual({ kind: "refused", reason: "too-large" });
  expect(
    parseBrowserAction({ kind: "copyText", text: "🌿".repeat(262145) }),
  ).toEqual({ kind: "refused", reason: "too-large" });
  expect(
    parseBrowserAction({ kind: "copyText", text: "Pond", surprise: true }),
  ).toEqual({ kind: "refused", reason: "invalid-request" });
  const bytes = new Uint8Array([0, 255]);
  const parsed = parseBrowserAction({
    kind: "saveFile",
    name: "pond.bin",
    mime: "application/octet-stream",
    bytes,
  });
  bytes[0] = 99;
  expect(parsed).toEqual({
    kind: "saveFile",
    name: "pond.bin",
    mime: "application/octet-stream",
    bytes: new Uint8Array([0, 255]),
  });
});
