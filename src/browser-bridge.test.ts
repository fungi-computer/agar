// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalBindingState,
  createReservedChordState,
  installBrowserBridge,
} from "./internal/browser-bridge.js";

const disposedResult = () => ({
  ok: true as const,
  [Symbol.dispose]() {
    return undefined;
  },
  value: undefined,
});

function createBridgeHarness() {
  const invokeReservedChord = vi.fn(() => Promise.resolve(disposedResult()));
  const remote = {
    invokeReservedChord,
    reportFocus: vi.fn(() => Promise.resolve(disposedResult())),
  };
  const onBroken = vi.fn();
  const dispose = installBrowserBridge({
    chords: createReservedChordState([
      {
        altKey: false,
        ctrlKey: true,
        id: "save",
        key: "k",
        metaKey: false,
        shiftKey: false,
      },
    ]),
    identity: { appId: "app", releaseId: "release", surfaceId: "surface" },
    onBroken,
    remote,
    window,
  });
  return { dispose, invokeReservedChord, onBroken, remote };
}

describe("App SDK browser bridge", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("LAW: a real DOM reserved chord is prevented once and invokes the host", async () => {
    const { dispose, invokeReservedChord, onBroken } = createBridgeHarness();
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "k",
    });
    document.documentElement.dispatchEvent(event);
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(invokeReservedChord).toHaveBeenCalledWith("save", false);
    expect(onBroken).not.toHaveBeenCalled();
    dispose();
  });

  it("LAW: the App layer runs its own chords and bare keys yield to text entry", () => {
    const bindings = createLocalBindingState();
    const save = vi.fn();
    const next = vi.fn();
    const dispose = installBrowserBridge({
      bindings,
      chords: createReservedChordState([]),
      identity: { appId: "app", releaseId: "release", surfaceId: "surface" },
      onBroken: vi.fn(),
      remote: {
        invokeReservedChord: vi.fn(() => Promise.resolve(disposedResult())),
        reportFocus: vi.fn(() => Promise.resolve(disposedResult())),
      },
      window,
    });
    bindings.update([
      { key: "ctrl+s", run: save },
      { key: "j", run: next },
    ]);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      input.dispatchEvent(event);
      return event;
    };
    expect(press({ key: "j" }).defaultPrevented).toBe(false);
    expect(next).not.toHaveBeenCalled();
    expect(press({ key: "s", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    input.blur();
    document.documentElement.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "j",
      }),
    );
    expect(next).toHaveBeenCalledOnce();
    bindings.update([]);
    expect(press({ key: "s", ctrlKey: true }).defaultPrevented).toBe(false);
    dispose();
  });

  it("LAW: composing DOM input is not forwarded as a reserved command", async () => {
    const { dispose, invokeReservedChord } = createBridgeHarness();
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      isComposing: true,
      key: "k",
    });
    document.documentElement.dispatchEvent(event);
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(invokeReservedChord).not.toHaveBeenCalled();
    dispose();
  });

  it("LAW: the App document gaining or losing focus reports it to the host", async () => {
    const settle = () =>
      new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
    let focused = false;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    const { dispose, remote } = createBridgeHarness();
    await settle();
    expect(remote.reportFocus).toHaveBeenLastCalledWith({
      editing: false,
      surface: null,
    });
    // A click on plain App content focuses the document with no focusin.
    focused = true;
    window.dispatchEvent(new FocusEvent("focus"));
    await settle();
    expect(remote.reportFocus).toHaveBeenLastCalledWith({
      editing: false,
      surface: "surface",
    });
    focused = false;
    window.dispatchEvent(new FocusEvent("blur"));
    await settle();
    expect(remote.reportFocus).toHaveBeenLastCalledWith({
      editing: false,
      surface: null,
    });
    expect(remote.reportFocus).toHaveBeenCalledTimes(3);
    dispose();
    focused = true;
    window.dispatchEvent(new FocusEvent("focus"));
    await settle();
    expect(remote.reportFocus).toHaveBeenCalledTimes(3);
  });

  it("LAW: synchronous initial focus failure is queued after bridge construction", async () => {
    const failure = new Error("private focus data");
    const failureLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const reportFocus = vi.fn(() => {
      throw failure;
    });
    const onBroken = vi.fn();
    const invokeReservedChord = vi.fn();
    const dispose = installBrowserBridge({
      chords: createReservedChordState([]),
      identity: { appId: "app", releaseId: "release", surfaceId: "surface" },
      onBroken,
      remote: { invokeReservedChord, reportFocus },
      window,
    });
    expectQueuedFailure(reportFocus, onBroken);
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(reportFocus).toHaveBeenCalledOnce();
    expect(onBroken).toHaveBeenCalledOnce();
    expect(onBroken).toHaveBeenCalledWith(failure);
    expect(failureLog).toHaveBeenCalledWith(
      JSON.stringify({
        source: "agar",
        operation: "browser-bridge.host-call",
        failureKind: "Error",
      }),
      expect.anything(),
    );
    expect(JSON.stringify(failureLog.mock.calls)).not.toContain(
      "private focus data",
    );
    dispose();
    dispatchAfterDispose();
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(reportFocus).toHaveBeenCalledOnce();
    expect(invokeReservedChord).not.toHaveBeenCalled();
  });
});

function dispatchAfterDispose(): void {
  document.documentElement.dispatchEvent(
    new FocusEvent("focusin", { bubbles: true }),
  );
  document.documentElement.dispatchEvent(
    new FocusEvent("focusout", { bubbles: true }),
  );
  document.documentElement.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "k",
    }),
  );
}

function expectQueuedFailure(
  reportFocus: ReturnType<typeof vi.fn>,
  onBroken: ReturnType<typeof vi.fn>,
): void {
  expect(reportFocus).not.toHaveBeenCalled();
  expect(onBroken).not.toHaveBeenCalled();
}
