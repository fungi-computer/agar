import { expect, it } from "vitest";
import { createAppHistory } from "./history.js";

it("starts with nowhere to go", () => {
  const history = createAppHistory("home");
  expect(history.get()).toEqual({
    current: "home",
    canGoBack: false,
    canGoForward: false,
  });
  expect(history.back()).toBe(false);
  expect(history.forward()).toBe(false);
});

it("walks back and forward over pushed places", () => {
  const history = createAppHistory("a");
  history.push("b");
  history.push("c");
  expect(history.get()).toEqual({
    current: "c",
    canGoBack: true,
    canGoForward: false,
  });
  expect(history.back()).toBe(true);
  expect(history.get()).toEqual({
    current: "b",
    canGoBack: true,
    canGoForward: true,
  });
  expect(history.back()).toBe(true);
  expect(history.get().canGoBack).toBe(false);
  expect(history.forward()).toBe(true);
  expect(history.forward()).toBe(true);
  expect(history.get().current).toBe("c");
  expect(history.forward()).toBe(false);
});

it("drops the forward stack when a new place is pushed", () => {
  const history = createAppHistory("a");
  history.push("b");
  history.back();
  history.push("c");
  expect(history.get()).toEqual({
    current: "c",
    canGoBack: true,
    canGoForward: false,
  });
  expect(history.back()).toBe(true);
  expect(history.get().current).toBe("a");
});

it("replaces the current place without adding a step", () => {
  const history = createAppHistory("a");
  history.replace("a2");
  expect(history.get()).toEqual({
    current: "a2",
    canGoBack: false,
    canGoForward: false,
  });
  history.push("b");
  history.back();
  history.replace("a3");
  expect(history.get()).toEqual({
    current: "a3",
    canGoBack: false,
    canGoForward: true,
  });
  expect(history.forward()).toBe(true);
  expect(history.get().current).toBe("b");
});

it("tells subscribers every change until they leave, and not when nothing moved", () => {
  const history = createAppHistory(0);
  const seen: number[] = [];
  const stop = history.subscribe((value) => seen.push(value.current));
  history.push(1);
  history.back();
  history.back();
  stop();
  history.push(2);
  expect(seen).toEqual([1, 0]);
});
