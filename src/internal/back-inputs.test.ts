// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { installBackInputs } from "./back-inputs.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

function install(mac: boolean, canGoBack = true) {
  const state = { canGoBack, backs: 0 };
  cleanups.push(
    installBackInputs({
      window,
      mac,
      canGoBack: () => state.canGoBack,
      back: () => {
        state.backs += 1;
      },
    }),
  );
  return state;
}

function key(
  init: KeyboardEventInit,
  target: EventTarget = document.body,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function mouse(type: string, button: number): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
  });
  document.body.dispatchEvent(event);
  return event;
}

describe("browser back inputs inside an App", () => {
  it("turns Alt+Left into App Back and keeps Alt+Right from leaving the page", () => {
    const state = install(false);
    expect(key({ key: "ArrowLeft", altKey: true }).defaultPrevented).toBe(true);
    expect(state.backs).toBe(1);
    expect(key({ key: "ArrowRight", altKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(
      key({ key: "ArrowLeft", altKey: true, repeat: true }).defaultPrevented,
    ).toBe(true);
    expect(state.backs).toBe(1);
    // Other chords stay the App's own.
    expect(key({ key: "ArrowLeft" }).defaultPrevented).toBe(false);
    expect(
      key({ key: "ArrowLeft", altKey: true, shiftKey: true }).defaultPrevented,
    ).toBe(false);
  });

  it("uses ⌘[ and ⌘← on macOS, leaving caret keys in text alone", () => {
    const state = install(true);
    expect(key({ key: "[", metaKey: true }).defaultPrevented).toBe(true);
    expect(key({ key: "ArrowLeft", metaKey: true }).defaultPrevented).toBe(
      true,
    );
    expect(state.backs).toBe(2);
    const input = document.createElement("input");
    document.body.append(input);
    expect(
      key({ key: "ArrowLeft", metaKey: true }, input).defaultPrevented,
    ).toBe(false);
    // Alt+Left is word-left on a Mac, never history.
    expect(key({ key: "ArrowLeft", altKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(state.backs).toBe(2);
  });

  it("runs Back once per mouse back press and cancels every navigation event", () => {
    const state = install(false);
    expect(mouse("mousedown", 3).defaultPrevented).toBe(true);
    expect(mouse("mouseup", 3).defaultPrevented).toBe(true);
    expect(mouse("auxclick", 3).defaultPrevented).toBe(true);
    expect(mouse("mouseup", 4).defaultPrevented).toBe(true);
    expect(mouse("mouseup", 0).defaultPrevented).toBe(false);
    expect(state.backs).toBe(1);
  });

  it("only guards while the App cannot go back, and defers to input the App handled", () => {
    const state = install(false, false);
    expect(key({ key: "ArrowLeft", altKey: true }).defaultPrevented).toBe(true);
    expect(mouse("mouseup", 3).defaultPrevented).toBe(true);
    expect(state.backs).toBe(0);
    state.canGoBack = true;
    const handled = (event: Event) => {
      event.preventDefault();
    };
    document.body.addEventListener("keydown", handled);
    key({ key: "ArrowLeft", altKey: true });
    document.body.removeEventListener("keydown", handled);
    expect(state.backs).toBe(0);
  });
});
