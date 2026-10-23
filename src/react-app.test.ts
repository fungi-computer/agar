// @vitest-environment jsdom
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createCapabilityRegistry } from "./capabilities.js";
import { connectAppHost, type AppHost } from "./host.js";
import type {
  AppReadyMessage,
  AppConnectMessage,
} from "./internal/protocol.js";
import { APP_CONNECT_TYPE, APP_PROTOCOL_VERSION } from "./internal/protocol.js";
import { createReadonlyStore } from "./internal/store.js";
import type { AppContext, AppLifecycle } from "./lifecycle.js";
import {
  mountApp,
  type AppMountState,
  useAppCommandCatalog,
  useAppContext,
  useComputerId,
  useStore,
} from "./react.js";
import type { AppRoot } from "./root.js";
import type { Disposer } from "./store.js";
import { inertHostNavigation } from "./window.js";
import type {
  WhistleContribution,
  WhistleRuntime,
} from "@fungi.computer/whistle";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const releases: Disposer[] = [];
afterEach(() => {
  act(() => {
    for (const release of releases.splice(0).reverse()) release();
  });
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-theme");
});

function unused(): never {
  throw new Error("Unused host capability");
}
function fixture() {
  const context = createReadonlyStore<AppContext>({
    computerId: "a",
    focus: { editing: false, surface: null },
    openRequest: null,
    visibility: "visible",
  });
  const lifecycle = createReadonlyStore<AppLifecycle>("connected");
  const theme = createReadonlyStore("dark");
  const dispose = vi.fn(() => {
    lifecycle.update("disposed");
  });
  const app: AppRoot = {
    capabilities: createCapabilityRegistry(),
    commands: { register: unused },
    context,
    lifecycle,
    theme,
    dispose,
    identity: { appId: "app", releaseId: "release", surfaceId: "surface" },
    ui: {
      requestComputerChoice: unused,
      requestBrowserAction: unused,
      requestAppPermissions: unused,
      openNavigation: unused,
      reportStatus: unused,
      onStatusAction: unused,
      openTeamBilling: unused,
      openDesktopSettings: unused,
      reportAgentSessionSelection: unused,
      showToast: unused,
    },
    window: { onBeforeClose: unused, navigation: inertHostNavigation },
  };
  return { app, context, lifecycle, theme, dispose };
}
/** jsdom omits postMessage source/origin and transfer; deliver those browser facts over real ports. */
function embedded(referrer = "https://host.example/team") {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const parent = frame.contentWindow;
  if (!parent) throw new Error("Fixture frame has no window");
  releases.push(() => {
    frame.remove();
  });
  vi.spyOn(window, "parent", "get").mockReturnValue(parent);
  vi.spyOn(document, "referrer", "get").mockReturnValue(referrer);
  const toHost = vi
    .spyOn(parent, "postMessage")
    .mockImplementation((data: AppReadyMessage) => {
      parent.dispatchEvent(
        new MessageEvent<unknown>("message", {
          data,
          source: window,
          origin: location.origin,
        }),
      );
    });
  vi.spyOn(window, "postMessage").mockImplementation(
    (
      data: AppConnectMessage,
      _options?: string | WindowPostMessageOptions,
      transfer?: Transferable[],
    ) => {
      window.dispatchEvent(
        new MessageEvent<unknown>("message", {
          data,
          source: parent,
          origin: "https://host.example",
          ports:
            transfer?.filter((value) => value instanceof MessagePort) ?? [],
        }),
      );
    },
  );
  const host = (): Promise<AppHost> => {
    const abort = new AbortController();
    releases.push(() => {
      abort.abort();
    });
    return connectAppHost({
      appWindow: window,
      expectedAppOrigin: location.origin,
      hostWindow: parent,
      signal: abort.signal,
      launch: {
        capabilities: [],
        context: { value: fixture().context.get(), version: 0 },
        identity: { appId: "app", releaseId: "release", surfaceId: "surface" },
        lifecycle: { value: "connected", version: 0 },
        reservedChords: { value: [], version: 0 },
        theme: { value: "dark", version: 0 },
      },
      handlers: {
        invokeReservedChord: () => Promise.resolve(),
        onDisconnect: () => Promise.resolve(),
        openNavigation: () => Promise.resolve(),
        reportFocus: () => Promise.resolve(),
        reportAgentSessionSelection: () => Promise.resolve(),
        showToast: () => Promise.resolve(),
        registerCommands: () =>
          Promise.resolve({
            update: () => undefined,
            dispose: () => undefined,
          }),
      },
    }).then((connection) => {
      releases.push(() => {
        connection.dispose();
      });
      return connection;
    });
  };
  return { host, toHost, parent };
}
function mount(options: Parameters<typeof mountApp>[1] = { name: "Test" }) {
  const element = document.createElement("div");
  const states: AppMountState[] = [];
  let dispose: Disposer = unused;
  act(() => {
    dispose = mountApp(element, options, (state) => {
      states.push(state);
      return createElement("span", null, state.status);
    });
  });
  releases.push(dispose);
  return { element, dispose, states };
}
async function settle() {
  await act(() => Promise.resolve());
}
async function connected(
  pending: Promise<AppHost>,
  element: HTMLElement,
): Promise<AppHost> {
  let host: AppHost | undefined;
  await act(async () => {
    host = await pending;
    await vi.waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
  });
  expect(element.textContent).toBe("live");
  if (!host) throw new Error("Host connection did not settle");
  return host;
}
it("mounts standalone without a host and disposes idempotently", () => {
  const page = mount();
  expect(page.element.textContent).toBe("standalone");
  act(() => {
    page.dispose();
    page.dispose();
  });
  expect(page.element.textContent).toBe("");
});
it.each(["", "not a URL", "https://unrelated.example/"])(
  "connects to its actual parent regardless of referrer %s",
  async (referrer) => {
    const bridge = embedded(referrer);
    const page = mount();
    expect(page.element.textContent).toBe("connecting");
    const pending = bridge.host();
    await connected(pending, page.element);
    expect(bridge.toHost.mock.calls[0]?.[1]).toBe("*");
  },
);
it("does not use another Window to connect a document with no view", () => {
  const bridge = embedded("");
  const owner = document.implementation.createHTMLDocument();
  const element = owner.createElement("div");
  let dispose: () => void = () => undefined;
  act(() => {
    dispose = mountApp(element, { name: "Detached" }, (state) =>
      createElement("span", null, state.status),
    );
  });
  releases.push(dispose);
  expect(element.textContent).toContain("not-hosted");
  expect(element.querySelector('[role="alert"]')).not.toBeNull();
  expect(bridge.toHost).not.toHaveBeenCalled();
});
it("shows a typed not-hosted failure when an embedded parent never answers", async () => {
  vi.useFakeTimers();
  embedded("");
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = mount();
  expect(page.element.textContent).toBe("connecting");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(page.states.at(-1)).toMatchObject({
    app: null,
    status: "not-hosted",
    error: { code: "DISCONNECTED", retryable: true },
  });
  expect(page.element.querySelector('[role="alert"]')?.textContent).toBe(
    "App host connection unavailable. Open this App through its host to try again.",
  );
  expect(page.states.some((state) => state.status === "standalone")).toBe(
    false,
  );
  expect(report).toHaveBeenCalledWith(
    "Test host connection failed",
    expect.objectContaining({ code: "DISCONNECTED" }),
  );
});
it.each(["other-window", "opaque-parent"])(
  "refuses %s instead of accepting it as the discovered host",
  async (sender) => {
    const bridge = embedded("");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const page = mount();
    const channel = new MessageChannel();
    releases.push(() => {
      channel.port1.close();
      channel.port2.close();
    });
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: APP_CONNECT_TYPE,
            protocolVersion: APP_PROTOCOL_VERSION,
            epoch: "test-epoch",
          },
          source: sender === "other-window" ? window : bridge.parent,
          origin: sender === "opaque-parent" ? "null" : "https://host.example",
          ports: [channel.port1],
        }),
      );
    });
    await settle();
    expect(page.states.at(-1)).toMatchObject({
      app: null,
      status: "not-hosted",
      error: { code: "IDENTITY" },
    });
    expect(page.element.querySelector('[role="alert"]')).not.toBeNull();
  },
);
it.each([null, "light"])(
  "restores the original theme %s and ends on real host disconnect",
  async (previous) => {
    const bridge = embedded();
    if (previous) document.documentElement.setAttribute("data-theme", previous);
    const pending = bridge.host();
    const page = mount();
    expect(page.element.textContent).toBe("connecting");
    const host = await connected(pending, page.element);
    expect(bridge.toHost.mock.calls[0]?.[1]).toBe("*");
    await act(async () => {
      await host.updateTheme({ value: "forest", version: 1 });
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("forest");
    await act(async () => {
      await host.disconnect();
    });
    expect(page.element.textContent).toBe("ended");
    expect(document.documentElement.getAttribute("data-theme")).toBe(previous);
    act(page.dispose);
  },
);
it("unmount releases the live connection and allows the next page epoch", async () => {
  const bridge = embedded();
  const pending = bridge.host();
  const page = mount();
  const host = await connected(pending, page.element);
  act(page.dispose);
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  expect(page.element.textContent).toBe("");
  host.dispose();
  const next = bridge.host();
  const replacement = mount();
  await connected(next, replacement.element);
});
it("aborts a pending handshake without reporting cancellation or blocking the next epoch", async () => {
  const bridge = embedded();
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = mount();
  expect(page.element.textContent).toBe("connecting");
  act(page.dispose);
  await settle();
  const pending = bridge.host();
  const next = mount();
  await connected(pending, next.element);
  expect(report).not.toHaveBeenCalled();
});
it("reports a platform handshake failure with its cause and App name", async () => {
  const bridge = embedded();
  const failure = new DOMException("Host unavailable", "SecurityError");
  bridge.toHost.mockImplementation(() => {
    throw failure;
  });
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const page = mount({ name: "Bazaar" });
  await settle();
  expect(page.states.at(-1)?.status).toBe("not-hosted");
  expect(report.mock.calls.at(-1)?.[0]).toBe("Bazaar host connection failed");
  expect(report.mock.calls.at(-1)?.[1]).toMatchObject({
    code: "DISCONNECTED",
    cause: failure,
  });
});
it("provides the supplied QueryClient without clearing its caller-owned cache", () => {
  const client = new QueryClient();
  client.setQueryData(["owned"], "retained");
  function Consumer() {
    return createElement(
      "span",
      null,
      useQueryClient().getQueryData<string>(["owned"]),
    );
  }
  const element = document.createElement("div");
  act(() => {
    releases.push(
      mountApp(element, { name: "Queries", queryClient: client }, () =>
        createElement(Consumer),
      ),
    );
  });
  expect(element.textContent).toBe("retained");
  act(() => releases.pop()?.());
  expect(client.getQueryData(["owned"])).toBe("retained");
});
it("tracks context/store replacement, clears absent values and releases subscriptions", () => {
  const first = fixture();
  const second = fixture();
  second.context.update({ ...second.context.get(), computerId: "b" });
  const element = document.createElement("div");
  const root = createRoot(element);
  releases.push(() => {
    root.unmount();
  });
  function Read({ app }: { app?: AppRoot }) {
    const context = useAppContext(app);
    const computer = useComputerId(app);
    const theme = useStore(app?.theme);
    return createElement(
      "span",
      null,
      `${context?.visibility ?? "none"}/${computer ?? "none"}/${theme ?? "none"}`,
    );
  }
  const update = (app?: AppRoot) => {
    act(() => {
      root.render(createElement(Read, { app }));
    });
  };
  update(first.app);
  expect(element.textContent).toBe("visible/a/dark");
  act(() => {
    first.context.update({
      ...first.context.get(),
      computerId: "updated",
      visibility: "hidden",
    });
  });
  expect(element.textContent).toBe("hidden/updated/dark");
  update(second.app);
  act(() => {
    first.context.update({ ...first.context.get(), computerId: "stale" });
  });
  expect(element.textContent).toBe("visible/b/dark");
  update();
  expect(element.textContent).toBe("none/none/none");
});
it("owns local and host command leases across StrictMode, catalog changes and late registration", async () => {
  const host = fixture();
  const registered: string[] = [];
  const released: string[] = [];
  const pending: (() => void)[] = [];
  host.app.commands.register = (command) => {
    registered.push(command.id);
    return new Promise((resolve) =>
      pending.push(() => {
        resolve(() => {
          released.push(command.id);
        });
      }),
    );
  };
  let runtime: WhistleRuntime | undefined;
  const build =
    (id: string): (() => WhistleContribution["commands"]) =>
    () => [
      {
        id,
        title: id,
        category: "Test",
        handler: () => undefined,
        projections: { palette: {} },
      },
    ];
  function Commands({
    catalog,
  }: {
    catalog: () => WhistleContribution["commands"];
  }) {
    runtime = useAppCommandCatalog(
      host.app,
      { sourceId: "test", namespace: "test" },
      catalog,
    );
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const release = () => {
    root.unmount();
  };
  releases.push(release);
  act(() => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(Commands, { catalog: build("first") }),
      ),
    );
  });
  expect(
    runtime?.snapshot().palette.map((command) => command.commandId),
  ).toEqual(["test:first"]);
  act(() => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(Commands, { catalog: build("second") }),
      ),
    );
  });
  expect(
    runtime?.snapshot().palette.map((command) => command.commandId),
  ).toEqual(["test:second"]);
  act(release);
  expect(runtime?.snapshot().palette).toEqual([]);
  for (const resolve of pending) resolve();
  await settle();
  expect(registered).toEqual(["first", "first", "second"]);
  expect(released).toEqual(registered);
});
