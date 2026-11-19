// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { frameFocusRaiser, frameHoldsFocus } from "./host.js";

/** A host window whose animation frames run when the test says so. */
function hostWindow(focused: () => Element | null, pageFocused = () => true) {
  const queue: (() => void)[] = [];
  return {
    window: {
      document: {
        get activeElement() {
          return focused();
        },
        hasFocus: pageFocused,
      },
      requestAnimationFrame: (callback: () => void) => queue.push(callback),
    },
    step: () => queue.shift()?.(),
    pending: () => queue.length,
  };
}

describe("frameHoldsFocus", () => {
  const frame = document.createElement("iframe");

  it("answers true at once when the host already sees the frame focused", async () => {
    const { window } = hostWindow(() => frame);
    await expect(frameHoldsFocus(frame, window)).resolves.toBe(true);
  });

  it("answers false for a guest that claims focus the host never sees", async () => {
    const { window, step } = hostWindow(() => null);
    const answer = frameHoldsFocus(frame, window, 3);
    step();
    step();
    step();
    await expect(answer).resolves.toBe(false);
  });

  it("waits a few frames for the browser to move activeElement", async () => {
    let current: Element | null = null;
    const { window, step } = hostWindow(() => current);
    const answer = frameHoldsFocus(frame, window);
    step();
    current = frame;
    step();
    await expect(answer).resolves.toBe(true);
  });

  it("answers false when the frame is the active element but the page lost focus", async () => {
    const { window, step } = hostWindow(
      () => frame,
      () => false,
    );
    const answer = frameHoldsFocus(frame, window, 2);
    step();
    step();
    await expect(answer).resolves.toBe(false);
  });
});

describe("frameFocusRaiser", () => {
  const frame = document.createElement("iframe");

  it("keeps one pending check however many reports arrive", () => {
    const { window, pending } = hostWindow(() => null);
    const raise = frameFocusRaiser(frame, window, () => undefined);
    for (let report = 0; report < 100; report++) raise();
    expect(pending()).toBe(1);
  });

  it("raises once for reports that join a check, then accepts a new one", async () => {
    let current: Element | null = null;
    const raised: string[] = [];
    const { window, step } = hostWindow(() => current);
    const raise = frameFocusRaiser(frame, window, () => {
      raised.push("raise");
    });
    raise();
    raise();
    current = frame;
    step();
    await Promise.resolve();
    await Promise.resolve();
    expect(raised).toEqual(["raise"]);
    current = null;
    raise();
    step();
    await Promise.resolve();
    await Promise.resolve();
    expect(raised).toEqual(["raise"]);
  });
});
