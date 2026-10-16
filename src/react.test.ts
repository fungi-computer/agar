// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { AppError } from "./errors.js";
import { useHostNavigation } from "./react.js";
import type {
  AppBackHandler,
  AppNavigationActivation,
  AppNavigationActivationHandler,
  AppNavigationState,
  HostNavigation,
} from "./window.js";
import type { HostNavigationOptions } from "./react.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function recordingNavigation() {
  const reports: AppNavigationState[] = [];
  let back: AppBackHandler | undefined;
  let activate: AppNavigationActivationHandler | undefined;
  const navigation: HostNavigation = {
    publish: (state) => {
      reports.push(state);
      return Promise.resolve();
    },
    onBack: (handler) => {
      back = handler;
      return () => {
        if (back === handler) back = undefined;
      };
    },
    onActivate: (handler) => {
      activate = handler;
      return () => {
        if (activate === handler) activate = undefined;
      };
    },
  };
  return {
    navigation,
    reports,
    requestBack: () => back?.() ?? false,
    activate: (activation: AppNavigationActivation) =>
      activate?.(activation) ?? false,
  };
}

function Page(
  props: HostNavigationOptions & { navigation: HostNavigation | null },
) {
  useHostNavigation(props.navigation, props);
  return null;
}

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    act(() => {
      root.unmount();
    });
});

function render() {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  return (props: Parameters<typeof Page>[0]) => {
    act(() => {
      root.render(createElement(Page, props));
    });
  };
}

it("publishes changes, routes Back to the latest handler and withdraws on unmount", async () => {
  const host = recordingNavigation();
  const update = render();
  const visited: string[] = [];
  update({
    navigation: host.navigation,
    canGoBack: false,
    title: "List",
    onBack: () => false,
  });
  update({
    navigation: host.navigation,
    canGoBack: true,
    title: "Detail",
    onBack: () => {
      visited.push("list");
      return true;
    },
  });
  expect(await host.requestBack()).toBe(true);
  expect(visited).toEqual(["list"]);

  act(() => {
    roots.splice(0)[0]?.unmount();
  });
  expect(host.reports).toEqual([
    { canGoBack: false, title: "List" },
    { canGoBack: true, title: "Detail" },
    { canGoBack: false },
  ]);
  expect(await host.requestBack()).toBe(false);
});

it("does nothing without a connected App", () => {
  const update = render();
  expect(() => {
    update({ navigation: null, canGoBack: true, onBack: () => true });
  }).not.toThrow();
});

it("stays quiet when a closing App can no longer reach its host", async () => {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const update = render();
    update({
      navigation: {
        onActivate: () => () => undefined,
        publish: () =>
          Promise.reject(
            new AppError("The app connection is disposed", {
              code: "DISCONNECTED",
              retryable: true,
            }),
          ),
        onBack: () => () => undefined,
      },
      canGoBack: true,
      onBack: () => true,
    });
    await act(() => Promise.resolve());
    expect(warnings).toEqual([]);
  } finally {
    console.warn = original;
  }
});

it("publishes crumbs once per content and routes activations to the latest handlers", () => {
  const host = recordingNavigation();
  const update = render();
  const chosen: string[] = [];
  const props = () => ({
    navigation: host.navigation,
    canGoBack: false,
    crumbs: [
      { id: "app", label: "Trellis" },
      {
        id: "wf",
        label: "Storyboard",
        siblings: [{ id: "b", label: "Other" }],
      },
    ],
    primary: [{ id: "run", label: "Run", variant: "primary" as const }],
    menu: [{ id: "fork", label: "Fork" }],
    status: [{ id: "valid", label: "Valid", tone: "success" as const }],
    onBack: () => false,
    onCrumb: (id: string, sibling?: string) => {
      chosen.push(sibling === undefined ? id : `${id}/${sibling}`);
    },
    onAction: (id: string) => {
      chosen.push(`action:${id}`);
    },
  });
  update(props());
  update(props());
  expect(host.reports).toHaveLength(1);
  expect(host.reports[0]).toEqual({
    canGoBack: false,
    crumbs: props().crumbs,
    primary: props().primary,
    menu: props().menu,
    status: props().status,
  });
  expect(host.activate({ kind: "crumb", crumbId: "app" })).toBe(true);
  expect(host.activate({ kind: "crumb", crumbId: "wf", siblingId: "b" })).toBe(
    true,
  );
  expect(host.activate({ kind: "action", actionId: "run" })).toBe(true);
  expect(chosen).toEqual(["app", "wf/b", "action:run"]);
});

it("declines an activation when the App has no handler for it", () => {
  const host = recordingNavigation();
  const update = render();
  update({
    navigation: host.navigation,
    canGoBack: false,
    onBack: () => false,
  });
  expect(host.activate({ kind: "action", actionId: "run" })).toBe(false);
  expect(host.reports).toEqual([{ canGoBack: false }]);
});
