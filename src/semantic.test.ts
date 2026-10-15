import * as z from "zod";
import { defineCapability } from "./capabilities.js";
import {
  rpcHandleSchema,
  rpcMethod,
  rpcDataSchema,
} from "./internal/rpc-contract.js";
// @vitest-environment jsdom
import { APP_PROTOCOL_VERSION } from "./internal/protocol.js";
import type {
  AppConnectMessage,
  AppHostRpc,
  AppReadyMessage,
} from "./internal/protocol.js";
import {
  newMessagePortRpcSession,
  RpcTarget,
  RpcStub,
} from "@fungi.computer/capnweb";
import { expect, it, vi } from "vitest";
import { WhistleActionError } from "@fungi.computer/whistle";

import type { CapabilityContract } from "./capabilities.js";
import type { AppCommand } from "./commands.js";
import type { AppNavigationState } from "./window.js";
import type { WhistleJsonValue } from "@fungi.computer/whistle";

import { connectApp } from "./connect.js";
import { AppError } from "./errors.js";
import { connectAppHost, type AppHost } from "./host.js";
import { createReservedChordState } from "./internal/browser-bridge.js";
import {
  createCapabilityDirectory,
  disposeRpcValue,
} from "./internal/capabilities.js";
import { createAppCommands } from "./internal/commands.js";
import {
  parseCommand,
  parseReservedChords,
  parseVoidResult,
} from "./internal/schemas.js";
import { createReadonlyStore } from "./internal/store.js";

type TestWindowMessage =
  | AppConnectMessage
  | AppReadyMessage
  | { readonly protocolVersion: 1; readonly type: "fungi.app.ready" };

const messageTargets = new WeakMap<IframeWindow, string[]>();

class IframeWindow extends EventTarget {
  readonly document = globalThis.document;
  parent: IframeWindow = this;
  peer?: IframeWindow;

  constructor(public origin: string) {
    super();
    messageTargets.set(this, []);
  }

  postMessage(
    message: TestWindowMessage,
    targetOrigin: string,
    transfer?: Transferable[],
  ): void {
    messageTargets.get(this)?.push(targetOrigin);
    const source = this.peer;
    if (!source) throw new Error("Fake window peer is missing");
    const event = new MessageEvent<TestWindowMessage>("message");
    Object.defineProperties(event, {
      data: { value: message },
      origin: { value: source.origin },
      ports: { value: transfer?.filter(isMessagePort) ?? [] },
      source: { value: source },
    });
    this.dispatchEvent(event);
  }
}

function asBrowserWindow(value: IframeWindow): Window {
  // SAFETY: this host double supplies a real Document plus native EventTarget,
  // parent/source identity and the transferred MessagePort operations under test.
  return value as Window;
}

class LoopbackTarget extends RpcTarget {
  ping(): string {
    return "pong";
  }

  [Symbol.dispose](): void {
    return undefined;
  }
}

function isMessagePort(value: Transferable): value is MessagePort {
  return value instanceof MessagePort;
}

it.each(["https://app.example", "null"])(
  "LAW: valid %s ready → connect → RPC connect resolves once",
  async (origin) => {
    const host = new IframeWindow("https://host.example");
    const app = new IframeWindow(origin);
    app.parent = host;
    app.peer = host;
    host.peer = app;
    const originalWindow = replaceWindow(app);
    try {
      const hostPromise = connectAppHost({
        appWindow: asBrowserWindow(app),
        expectedAppOrigin: app.origin,
        handlers: {
          invokeReservedChord: () => Promise.resolve(undefined),
          onDisconnect: () => Promise.resolve(undefined),
          openNavigation: () => Promise.resolve(undefined),
          registerCommands: () =>
            Promise.resolve({
              update: () => undefined,
              dispose: () => undefined,
            }),
          reportFocus: () => Promise.resolve(undefined),
          reportAgentSessionSelection: () => Promise.resolve(undefined),
          showToast: () => Promise.resolve(undefined),
        },
        hostWindow: asBrowserWindow(host),
        launch: {
          capabilities: [],
          context: {
            value: {
              computerId: null,
              focus: { editing: false, surface: null },
              openRequest: null,
              visibility: "visible",
            },
            version: 0,
          },
          identity: {
            appId: "app",
            releaseId: "release",
            surfaceId: "surface",
          },
          lifecycle: { value: "connected", version: 0 },
          reservedChords: { value: [], version: 0 },
          theme: { value: "dark", version: 0 },
        },
      });
      const root = await connectApp({ expectedHostOrigin: host.origin });
      const mounted = await hostPromise;
      expect(root.identity.appId).toBe("app");
      expect(messageTargets.get(app)).toEqual([
        origin === "null" ? "*" : origin,
      ]);
      expect(messageTargets.get(host)).toEqual([host.origin]);
      await expectDuplicateMountRejected(app, host);
      disposePair(root, mounted);
    } finally {
      restoreWindow(originalWindow);
    }
  },
);

it("LAW: a page retries its handshake when the replacement host starts listening late", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("null");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const originalWindow = replaceWindow(app);
  try {
    const appPromise = connectApp({ expectedHostOrigin: host.origin });
    expect(messageTargets.get(host)).toEqual([host.origin]);
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      hostWindow: asBrowserWindow(host),
      expectedAppOrigin: app.origin,
      handlers: mountedHandlers(),
      launch: mountedLaunch(),
    });
    const root = await appPromise;
    const mounted = await hostPromise;
    expect(messageTargets.get(host)?.length).toBeGreaterThan(1);
    expect(root.identity.appId).toBe("app");
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("LAW: the App owns one close consultation and release restores host close", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const originalWindow = replaceWindow(app);
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: mountedHandlers(),
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    expect(await mounted.requestClose()).toBe(true);
    const release = root.window.onBeforeClose(() => false);
    expect(() => root.window.onBeforeClose(() => true)).toThrow(
      "already owns a close consultation",
    );
    expect(await mounted.requestClose()).toBe(false);
    release();
    release();
    expect(await mounted.requestClose()).toBe(true);
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("LAW: navigation reports reach the host parsed and Back reaches its one owner", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const originalWindow = replaceWindow(app);
  const reports: AppNavigationState[] = [];
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        reportNavigation: (state: AppNavigationState) => {
          reports.push(state);
          return Promise.resolve();
        },
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    expect(await mounted.requestBack()).toBe(false);

    await root.window.navigation.publish({
      canGoBack: true,
      title: "  Leaderboard ",
    });
    await root.window.navigation.publish({ canGoBack: false, title: "   " });
    expect(reports).toEqual([
      { canGoBack: true, title: "Leaderboard" },
      { canGoBack: false },
    ]);
    await expect(
      root.window.navigation.publish({
        canGoBack: true,
        title: "x".repeat(81),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(reports).toHaveLength(2);

    let backs = 0;
    const release = root.window.navigation.onBack(() => {
      backs += 1;
      return true;
    });
    expect(() => root.window.navigation.onBack(() => true)).toThrow(
      "already owns Back requests",
    );
    expect(await mounted.requestBack()).toBe(true);
    expect(backs).toBe(1);

    // The browser's own back key inside the App is App Back, never history.
    const altLeft = () => {
      const event = new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        altKey: true,
        cancelable: true,
      });
      app.dispatchEvent(event);
      return event;
    };
    expect(altLeft().defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(backs).toBe(1);
    await root.window.navigation.publish({ canGoBack: true });
    expect(altLeft().defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      expect(backs).toBe(2);
    });
    release();
    release();
    expect(await mounted.requestBack()).toBe(false);
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("LAW: abort during the real host ready wait releases the mount", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  const controller = new AbortController();
  const pending = connectAppHost({
    appWindow: asBrowserWindow(app),
    expectedAppOrigin: app.origin,
    handlers: mountedHandlers(),
    hostWindow: asBrowserWindow(host),
    launch: mountedLaunch(),
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  const secondController = new AbortController();
  const second = connectAppHost({
    appWindow: asBrowserWindow(app),
    expectedAppOrigin: app.origin,
    handlers: mountedHandlers(),
    hostWindow: asBrowserWindow(host),
    launch: mountedLaunch(),
    signal: secondController.signal,
  });
  secondController.abort();
  await expect(second).rejects.toMatchObject({ code: "CANCELLED" });
});

it("bootstrap snapshots are frozen while capability handles stay live", async () => {
  const channel = new MessageChannel();
  const remote = newMessagePortRpcSession<LoopbackTarget>(channel.port1);
  const peer = newMessagePortRpcSession(channel.port2, new LoopbackTarget());
  const contract: CapabilityContract<{ ping(): Promise<string> }> =
    defineCapability(
      "example",
      1,
      rpcHandleSchema({
        ping: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => z.string().parse(value)),
          ),
        ),
      }),
    );
  const controller = createCapabilityDirectory([
    { handle: remote, id: contract.id, version: contract.version },
  ]);
  expect(await controller.directory.require(contract).ping()).toBe("pong");
  controller.disconnect();
  expect(() => controller.directory.require(contract)).toThrow(AppError);
  disposeRpcValue(remote);
  disposeRpcValue(peer);
  channel.port1.close();
  channel.port2.close();
});

it("LAW: real host fact publication is newer-only and updates retained stores before listeners", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const originalWindow = replaceWindow(app);
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: mountedHandlers(),
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    const seen: string[] = [];
    root.context.subscribe((value) =>
      seen.push(
        `context:${value.computerId ?? "none"}:${value.visibility}:${root.context.get().visibility}`,
      ),
    );
    root.theme.subscribe((value) => seen.push(`theme:${value}`));
    root.lifecycle.subscribe((value) => seen.push(`lifecycle:${value}`));
    await publishFactSequence(mounted);
    expect(seen).toEqual([
      "context:computer-a:hidden:hidden",
      "theme:latte",
      "theme:mocha",
      "lifecycle:suspended",
      "lifecycle:connected",
    ]);
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("LAW: real command registration is acknowledged, invoked, unregistered, and disposed once", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const originalWindow = replaceWindow(app);
  let invoke:
    | ((input: {
        origin: "keyboard" | "programmatic";
        arguments?: import("@fungi.computer/whistle").WhistleJsonValue;
        signal?: AbortSignal;
      }) => Promise<
        import("@fungi.computer/whistle").WhistleJsonValue | undefined
      >)
    | undefined;
  let disposed = 0;
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        registerCommands: (input) => {
          invoke = (value) => input.invoke("save", value);
          return Promise.resolve({
            update: () => undefined,
            dispose: () => {
              disposed += 1;
              throw new Error("disposer failed");
            },
          });
        },
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    const calls: string[] = [];
    const unregister = await root.commands.register(
      { category: "editor", id: "save", title: "Save" },
      (input) => {
        calls.push(input.origin);
        return undefined;
      },
    );
    await invoke?.({ origin: "keyboard" });
    expect(calls).toEqual(["keyboard"]);
    unregister();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(0);
    root.dispose();
    mounted.dispose();
    expect(disposed).toBe(1);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("carries Whistle metadata and JSON results while hiding host correlation IDs", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const originalWindow = replaceWindow(app);
  let invoke:
    | ((input: {
        readonly arguments?: import("@fungi.computer/whistle").WhistleJsonValue;
        readonly origin: import("@fungi.computer/whistle").WhistleExecutionOrigin;
        readonly signal?: AbortSignal;
      }) => Promise<
        import("@fungi.computer/whistle").WhistleJsonValue | undefined
      >)
    | undefined;
  let received: Parameters<NonNullable<typeof invoke>>[0] | undefined;
  let command: AppCommand | undefined;
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        registerCommands: (input) => {
          command = input.commands[0];
          invoke = (value) => input.invoke("save", value);
          return Promise.resolve({
            update: () => undefined,
            dispose: () => undefined,
          });
        },
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    await root.commands.register(
      {
        id: "save",
        title: "Save",
        category: "editor",
        description: "Save the current document",
        projections: { menu: { order: 2 } },
        action: {
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          presentation: { type: "form", submitLabel: "Save" },
        },
        availability: { status: "unavailable", reason: "Read-only" },
      },
      (input) => {
        received = input;
        return { saved: true };
      },
    );
    expect(command).toMatchObject({
      id: "save",
      projections: { menu: { order: 2 } },
      action: { presentation: { type: "form", submitLabel: "Save" } },
      availability: { status: "unavailable", reason: "Read-only" },
    });
    const result = await invoke?.({
      origin: "menu",
      arguments: { path: "README.md" },
    });
    expect(result).toEqual({ saved: true });
    expect(received).toMatchObject({
      origin: "menu",
      arguments: { path: "README.md" },
    });
    expect(received?.signal).toBeInstanceOf(AbortSignal);
    expect(received).not.toHaveProperty("commandId");
    expect(received).not.toHaveProperty("requestId");
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("carries portable Whistle action failures through the command envelope", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  let invoke:
    | ((input: {
        readonly origin: import("@fungi.computer/whistle").WhistleExecutionOrigin;
        readonly signal?: AbortSignal;
      }) => Promise<WhistleJsonValue | undefined>)
    | undefined;
  const originalWindow = replaceWindow(app);
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        registerCommands: (input) => {
          invoke = (value) => input.invoke("fail", value);
          return Promise.resolve({
            update: () => undefined,
            dispose: () => undefined,
          });
        },
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    await root.commands.register(
      { category: "test", id: "fail", title: "Fail" },
      () => {
        throw new WhistleActionError("conflict", "Cannot save", {
          itemId: "doc-1",
        });
      },
    );
    await expect(invoke?.({ origin: "agent" })).rejects.toMatchObject({
      name: "WhistleActionError",
      code: "conflict",
      message: "Cannot save",
      details: { itemId: "doc-1" },
    });
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("rolls back a rejected aggregate update and leaves the lease authoritative", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  let active: string[] = [];
  let disposed = 0;
  let invoke:
    | ((
        commandId: string,
        input: {
          readonly origin: "programmatic";
          readonly signal?: AbortSignal;
        },
      ) => Promise<WhistleJsonValue | undefined>)
    | undefined;
  const originalWindow = replaceWindow(app);
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        registerCommands: (input) => {
          invoke = input.invoke;
          active = input.commands.map((command) => command.id);
          return Promise.resolve({
            update: (commands: readonly AppCommand[]) => {
              active = commands.map((command) => command.id);
              if (commands.length === 2) throw new Error("stale update");
            },
            dispose: () => {
              disposed += 1;
            },
          });
        },
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    const first = root.commands.register(
      { category: "test", id: "save", title: "Save" },
      () => undefined,
    );
    const second = root.commands.register(
      { category: "test", id: "next", title: "Next" },
      () => undefined,
    );
    const unregister = await first;
    await expect(second).rejects.toMatchObject({ code: "HOST_FAILURE" });
    expect(active).toEqual(["save"]);
    await expect(
      Promise.resolve().then(() =>
        invoke?.("next", { origin: "programmatic" }),
      ),
    ).rejects.toMatchObject({ code: "DISCONNECTED" });
    unregister();
    for (let attempt = 0; attempt < 20 && active.length !== 0; attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(active).toEqual([]);
    disposePair(root, mounted);
    expect(disposed).toBe(2);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("drops an acknowledged callback when a mutating unregister update fails", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  let active: string[] = [];
  let disposed = 0;
  let invoke:
    | ((
        commandId: string,
        input: {
          readonly origin: "programmatic";
          readonly signal?: AbortSignal;
        },
      ) => Promise<WhistleJsonValue | undefined>)
    | undefined;
  const originalWindow = replaceWindow(app);
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        registerCommands: (input) => {
          invoke = input.invoke;
          active = input.commands.map((command) => command.id);
          return Promise.resolve({
            update: (commands: readonly AppCommand[]) => {
              active = commands.map((command) => command.id);
              if (commands.length === 0) throw new Error("stale removal");
            },
            dispose: () => {
              disposed += 1;
            },
          });
        },
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    const unregister = await root.commands.register(
      { category: "test", id: "save", title: "Save" },
      () => undefined,
    );
    unregister();
    for (let attempt = 0; attempt < 20 && disposed === 0; attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(active).toEqual([]);
    expect(disposed).toBe(1);
    await expect(
      Promise.resolve().then(() =>
        invoke?.("save", { origin: "programmatic" }),
      ),
    ).rejects.toMatchObject({ code: "DISCONNECTED" });
    disposePair(root, mounted);
    expect(disposed).toBe(1);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("does not promote a pending command after reentrant mount disposal", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  let active: string[] = [];
  let disposed = 0;
  let mounted: AppHost | undefined;
  const originalWindow = replaceWindow(app);
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        registerCommands: (input) => {
          active = input.commands.map((command) => command.id);
          return Promise.resolve({
            update: (commands: readonly AppCommand[]) => {
              active = commands.map((command) => command.id);
              if (commands.length === 2) mounted?.dispose();
            },
            dispose: () => {
              disposed += 1;
              active = [];
            },
          });
        },
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    mounted = await hostPromise;
    await root.commands.register(
      { category: "test", id: "save", title: "Save" },
      () => undefined,
    );
    await expect(
      root.commands.register(
        { category: "test", id: "next", title: "Next" },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "HOST_FAILURE" });
    expect(active).toEqual([]);
    expect(disposed).toBe(1);
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("terminalizes the mount when a failed update cannot recover its generation", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  let active: string[] = [];
  let registrations = 0;
  let disposed = 0;
  const originalWindow = replaceWindow(app);
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        registerCommands: (input) => {
          registrations += 1;
          if (registrations === 2) throw new Error("recovery failed");
          active = input.commands.map((command) => command.id);
          return Promise.resolve({
            update: (commands: readonly AppCommand[]) => {
              active = commands.map((command) => command.id);
              throw new Error("stale update");
            },
            dispose: () => {
              disposed += 1;
              active = [];
            },
          });
        },
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    await root.commands.register(
      { category: "test", id: "save", title: "Save" },
      () => undefined,
    );
    await expect(
      root.commands.register(
        { category: "test", id: "next", title: "Next" },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "HOST_FAILURE" });
    for (let attempt = 0; attempt < 20; attempt++) {
      if (root.lifecycle.get() === "disposed") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(root.lifecycle.get()).toBe("disposed");
    expect(active).toEqual([]);
    expect(disposed).toBe(1);
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("LAW: concurrent same-ID registration reserves one host slot and one owner", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const pendingRegistration: (() => void)[] = [];
  let resolveRegistrationStarted: (() => void) | undefined;
  const registrationStarted = new Promise<void>((resolve) => {
    resolveRegistrationStarted = resolve;
  });
  let disposerCount = 0;
  let cleanup: (() => void) | undefined;
  const originalWindow = replaceWindow(app);
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        registerCommands: async () =>
          new Promise<{
            update: (commands: readonly AppCommand[]) => void;
            dispose: () => void;
          }>((resolve) => {
            resolveRegistrationStarted?.();
            pendingRegistration.push(() => {
              resolve({
                update: () => undefined,
                dispose: () => {
                  disposerCount += 1;
                },
              });
            });
          }),
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    cleanup = () => {
      disposePair(root, mounted);
    };
    const command = { category: "editor", id: "save", title: "Save" };
    const first = root.commands.register(command, () =>
      Promise.resolve(undefined),
    );
    const second = root.commands.register(command, () =>
      Promise.resolve(undefined),
    );

    await expect(second).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await registrationStarted;
    expect(pendingRegistration).toHaveLength(1);
    pendingRegistration[0]?.();
    const unregister = await first;
    unregister();
    await expectRelease(root, mounted, () => disposerCount, 0);
    expect(disposerCount).toBe(1);
  } finally {
    cleanup?.();
    restoreWindow(originalWindow);
  }
});

it("LAW: synchronous command supervision isolates a throwing fatal callback", async () => {
  const unused = () => {
    throw new Error("Unexpected host method in command supervision test");
  };
  const target: AppHostRpc = {
    requestComputerChoice: unused,
    requestBrowserAction: unused,
    connect: unused,
    invokeReservedChord: unused,
    openNavigation: unused,
    reportStatus: unused,
    requestAppPermissions: unused,
    openTeamBilling: unused,
    openDesktopSettings: unused,
    reportFocus: unused,
    reportNavigation: unused,
    reportAgentSessionSelection: unused,
    showToast: unused,
    registerCommand: () =>
      Promise.resolve({ ok: true, value: { commandId: "app/save" } }),
    unregisterCommand: unused,
  };
  using stub = new RpcStub(target);
  // Inject the synchronous transport throw before RPC dispatch, retaining the
  // maintained stub for the successful registration and its result ownership.
  const remote = new Proxy(stub, {
    get(target, property) {
      if (property === "unregisterCommand")
        return () => {
          throw new Error("transport failed");
        };
      if (property === "registerCommand") return target.registerCommand;
      throw new Error("Unexpected stub property in command supervision test");
    },
  });
  let fatalCalls = 0;
  const controller = createAppCommands(
    remote,
    () => undefined,
    () => {
      fatalCalls += 1;
      throw new Error("fatal callback failed");
    },
  );
  const unregister = await controller.commands.register(
    { category: "editor", id: "save", title: "Save" },
    () => Promise.resolve(undefined),
  );
  expect(() => {
    unregister();
  }).not.toThrow();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(fatalCalls).toBe(1);
  controller.dispose();
});

it("LAW: mounted command namespace enforces cap, duplicates, cancellation, and release", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const invocations = new Map<
    string,
    (input: {
      origin: "keyboard" | "programmatic";
      arguments?: import("@fungi.computer/whistle").WhistleJsonValue;
      signal?: AbortSignal;
    }) => Promise<
      import("@fungi.computer/whistle").WhistleJsonValue | undefined
    >
  >();
  let disposerCount = 0;
  const originalWindow = replaceWindow(app);
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        registerCommands: (input) => {
          const update = (commands: readonly AppCommand[]) => {
            for (const command of commands)
              invocations.set(command.id, (value) =>
                input.invoke(command.id, value),
              );
          };
          return Promise.resolve({
            update,
            dispose: () => {
              disposerCount += 1;
            },
          });
        },
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    const unregister: (() => void)[] = [];
    for (let index = 0; index < 128; index++) {
      unregister.push(
        await root.commands.register(
          {
            category: "test",
            id: `command-${String(index)}`,
            title: "Command",
          },
          () => Promise.resolve(undefined),
        ),
      );
    }
    await expect(
      root.commands.register(
        { category: "test", id: "overflow", title: "Overflow" },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(invocations.get("command-0")).toBeDefined();
    await expect(
      root.commands.register(
        { category: "test", id: "command-0", title: "Duplicate" },
        () => Promise.resolve(undefined),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    unregister[0]();
    await expectRelease(root, mounted, () => disposerCount, 0);
    expect(disposerCount).toBe(1);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("LAW: an aborted mounted command sends the exact request cancellation and releases it", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  let invoke:
    | ((input: {
        origin: "keyboard" | "programmatic";
        arguments?: import("@fungi.computer/whistle").WhistleJsonValue;
        signal?: AbortSignal;
      }) => Promise<
        import("@fungi.computer/whistle").WhistleJsonValue | undefined
      >)
    | undefined;
  const aborted = new Set<string>();
  const originalWindow = replaceWindow(app);
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        ...mountedHandlers(),
        registerCommands: (input) => {
          invoke = (value) => input.invoke("cancel", value);
          return Promise.resolve({
            update: () => undefined,
            dispose: () => undefined,
          });
        },
      },
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    await root.commands.register(
      { category: "test", id: "cancel", title: "Cancel" },
      (input) => {
        const id =
          input.arguments !== undefined &&
          Array.isArray(input.arguments) &&
          input.arguments[0] === "first"
            ? "first"
            : "second";
        return new Promise<undefined>((resolve) => {
          input.signal.addEventListener(
            "abort",
            () => {
              aborted.add(id);
              resolve(undefined);
            },
            { once: true },
          );
        });
      },
    );
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = invoke?.({
      origin: "programmatic",
      arguments: ["first"],
      signal: firstController.signal,
    });
    const second = invoke?.({
      origin: "programmatic",
      arguments: ["second"],
      signal: secondController.signal,
    });
    firstController.abort();
    await first;
    expect(aborted).toEqual(new Set(["first"]));
    expect(second).toBeDefined();
    secondController.abort();
    await second;
    expect(aborted).toEqual(new Set(["first", "second"]));
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("LAW: graceful remote teardown publishes the terminal history and permits a later epoch", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: app,
  });
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: mountedHandlers(),
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    const history: string[] = [];
    root.lifecycle.subscribe((value) => history.push(value));
    await mounted.disconnect();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(history).toEqual(["disconnected", "disposing", "disposed"]);

    const nextHostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: mountedHandlers(),
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    });
    const nextRoot = await connectApp({ expectedHostOrigin: host.origin });
    const nextHost = await nextHostPromise;
    expect(nextRoot.lifecycle.get()).toBe("connected");
    nextRoot.dispose();
    nextHost.dispose();
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

it("throwing store subscriber is warned and does not block later publication", () => {
  const store = createReadonlyStore(0);
  const seen: number[] = [];
  store.subscribe(() => {
    throw new Error("subscriber failed");
  });
  store.subscribe((value) => seen.push(value));
  expect(() => {
    store.update(1);
  }).not.toThrow();
  expect(seen).toEqual([1]);
});

it("malformed success/error envelopes become bounded PROTOCOL errors", () => {
  expect(() =>
    parseVoidResult({ extra: 1, ok: true, value: undefined }),
  ).toThrow(AppError);
  expect(() => parseVoidResult({ ok: true, value: "not void" })).toThrow(
    AppError,
  );
});

it("LAW: a broken transferred port before RPC connect rejects instead of hanging", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  // Cap'n Web's MessagePort transport treats a received null as an
  // owner-issued close/brokenness signal. A raw MessagePort.close() emits
  // nothing to the peer and is intentionally not observable here.
  app.addEventListener("message", (event) => {
    if (event instanceof MessageEvent) event.ports[0]?.postMessage(null);
  });
  const pending = connectAppHost({
    appWindow: asBrowserWindow(app),
    expectedAppOrigin: app.origin,
    handlers: mountedHandlers(),
    hostWindow: asBrowserWindow(host),
    launch: mountedLaunch(),
  });
  app.parent.postMessage(
    { protocolVersion: APP_PROTOCOL_VERSION, type: "fungi.app.ready" },
    host.origin,
  );
  await expect(pending).rejects.toMatchObject({ code: "DISCONNECTED" });
});

/* Schema cardinality is covered by the real mounted registration probes. */
it("hostile aggregate bounds reject at the schema door", () => {
  expect(() =>
    parseReservedChords(
      Array.from({ length: 65 }, (_, i) => ({
        altKey: false,
        ctrlKey: false,
        id: String(i),
        key: "K",
        metaKey: false,
        shiftKey: false,
      })),
    ),
  ).toThrow(AppError);
  expect(() =>
    parseCommand({
      projections: {
        bindings: { values: Array.from({ length: 17 }, () => "K") },
      },
      category: "x",
      id: "c",
      title: "C",
    }),
  ).toThrow(AppError);
});

it("capability controller disposal is terminal", () => {
  const channel = new MessageChannel();
  const remote = newMessagePortRpcSession<LoopbackTarget>(channel.port1);
  const peer = newMessagePortRpcSession(channel.port2, new LoopbackTarget());
  const controller = createCapabilityDirectory([
    { handle: remote, id: "x", version: 1 },
  ]);
  controller.disconnect();
  expect(() =>
    controller.directory.require(
      defineCapability(
        "x",
        1,
        rpcHandleSchema({
          ping: rpcMethod(
            rpcDataSchema(
              z.unknown().transform((value) => z.string().parse(value)),
            ),
          ),
        }),
      ),
    ),
  ).toThrow(AppError);
  disposeRpcValue(remote);
  disposeRpcValue(peer);
  channel.port1.close();
  channel.port2.close();
});

it("command metadata remains semantic", () => {
  const command = parseCommand({
    category: "editor",
    id: "save",
    title: "Save",
  });
  expect(command.id).toBe("save");
  expect(Object.isFrozen(command)).toBe(true);
  expect(() =>
    parseCommand({ category: "editor", id: "  ", title: "Save" }),
  ).toThrow(AppError);
  expect(() =>
    parseCommand({ category: "editor", id: "save:other", title: "Save" }),
  ).toThrow(AppError);
  expect(() =>
    parseCommand({
      category: "editor",
      id: "save",
      title: "Save",
      projections: { bindings: { values: ["  "] } },
    }),
  ).toThrow(AppError);
});

it("reserved-chord subscription disposer releases callback ownership", () => {
  const chords = createReservedChordState([]);
  let updates = 0;
  const off = chords.subscribe(() => updates++);
  chords.update([]);
  expect(updates).toBe(1);
  off();
  chords.update([]);
  expect(updates).toBe(1);
});

it("store teardown history remains ordered", () => {
  const store = createReadonlyStore("connected");
  const history: string[] = [];
  store.subscribe((value) => history.push(value));
  store.update("disconnected");
  store.update("disposing");
  store.update("disposed");
  expect(history).toEqual(["disconnected", "disposing", "disposed"]);
});
function disposePair(
  root: { dispose(): void },
  mounted: { dispose(): void },
): void {
  root.dispose();
  mounted.dispose();
}

async function expectDuplicateMountRejected(
  app: IframeWindow,
  host: IframeWindow,
): Promise<void> {
  await expect(
    connectApp({ expectedHostOrigin: host.origin }),
  ).rejects.toMatchObject({ code: "IDENTITY" });
  await expect(
    connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: mountedHandlers(),
      hostWindow: asBrowserWindow(host),
      launch: mountedLaunch(),
    }),
  ).rejects.toMatchObject({ code: "IDENTITY" });
}

async function expectRelease(
  root: { dispose(): void },
  mounted: { dispose(): void },
  count: () => number,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20 && count() !== expected; attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(count()).toBe(expected);
  disposePair(root, mounted);
}

function mountedHandlers() {
  return {
    invokeReservedChord: () => Promise.resolve(undefined),
    onDisconnect: () => Promise.resolve(undefined),
    openNavigation: () => Promise.resolve(undefined),
    registerCommands: () =>
      Promise.resolve({ update: () => undefined, dispose: () => undefined }),
    reportFocus: () => Promise.resolve(undefined),
    reportAgentSessionSelection: () => Promise.resolve(undefined),
    showToast: () => Promise.resolve(undefined),
  };
}

function mountedLaunch() {
  return {
    capabilities: [],
    context: {
      value: {
        computerId: null,
        focus: { editing: false, surface: null },
        openRequest: null,
        visibility: "visible" as const,
      },
      version: 0,
    },
    identity: { appId: "app", releaseId: "release", surfaceId: "surface" },
    lifecycle: { value: "connected" as const, version: 0 },
    reservedChords: { value: [], version: 0 },
    theme: { value: "dark", version: 0 },
  };
}

async function publishFactSequence(
  mounted: Pick<
    AppHost,
    "updateContext" | "updateLifecycle" | "updateReservedChords" | "updateTheme"
  >,
): Promise<void> {
  await mounted.updateContext({
    value: {
      computerId: "computer-a",
      focus: { editing: false, surface: null },
      openRequest: null,
      visibility: "hidden",
    },
    version: 1,
  });
  await mounted.updateTheme({ value: "latte", version: 1 });
  await mounted.updateTheme({ value: "stale", version: 1 });
  await mounted.updateTheme({ value: "mocha", version: 2 });
  await mounted.updateLifecycle({ value: "suspended", version: 1 });
  await mounted.updateLifecycle({ value: "connected", version: 1 });
  await mounted.updateLifecycle({ value: "connected", version: 2 });
  await mounted.updateReservedChords({ value: [], version: 1 });
  await mounted.updateReservedChords({ value: [], version: 1 });
  await mounted.updateReservedChords({
    value: [
      {
        altKey: false,
        ctrlKey: true,
        id: "save",
        key: "k",
        metaKey: false,
        shiftKey: false,
      },
    ],
    version: 2,
  });
}

function replaceWindow(value: IframeWindow): Window {
  const original = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value });
  return original;
}

function restoreWindow(value: Window): void {
  Object.defineProperty(globalThis, "window", { configurable: true, value });
}

it("LAW: permission requests cross the host boundary decoded and bounded", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const originalWindow = replaceWindow(app);
  const requests: unknown[] = [];
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        invokeReservedChord: () => Promise.resolve(undefined),
        onDisconnect: () => Promise.resolve(undefined),
        openNavigation: () => Promise.resolve(undefined),
        requestAppPermissions: (input) => {
          requests.push(input);
          return Promise.resolve("granted");
        },
        registerCommands: () =>
          Promise.resolve({
            update: () => undefined,
            dispose: () => undefined,
          }),
        reportFocus: () => Promise.resolve(undefined),
        reportAgentSessionSelection: () => Promise.resolve(undefined),
        showToast: () => Promise.resolve(undefined),
      },
      hostWindow: asBrowserWindow(host),
      launch: {
        capabilities: [],
        context: {
          value: {
            computerId: null,
            focus: { editing: false, surface: null },
            visibility: "visible",
            openRequest: null,
          },
          version: 0,
        },
        identity: { appId: "app", releaseId: "release", surfaceId: "surface" },
        lifecycle: { value: "connected", version: 0 },
        reservedChords: { value: [], version: 0 },
        theme: { value: "dark", version: 0 },
      },
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    await expect(
      root.ui.requestAppPermissions({
        agents: ["agent.manage", "agent.list", "agent.manage"],
      }),
    ).resolves.toBe("granted");
    expect(requests).toEqual([
      { agents: ["agent.manage", "agent.list"], computers: [] },
    ]);
    await expect(
      root.ui.requestAppPermissions({
        // @ts-expect-error an undeclared right never reaches the host
        agents: ["computer.execute"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(requests).toHaveLength(1);
    await expect(root.ui.openDesktopSettings()).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    // A host that owns no Billing page denies the handoff explicitly.
    await expect(root.ui.openTeamBilling()).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});

it("LAW: an App's status items reach its window decoded and bounded, and actions come back", async () => {
  const host = new IframeWindow("https://host.example");
  const app = new IframeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const originalWindow = replaceWindow(app);
  const reports: unknown[] = [];
  try {
    const hostPromise = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: {
        invokeReservedChord: () => Promise.resolve(undefined),
        onDisconnect: () => Promise.resolve(undefined),
        openNavigation: () => Promise.resolve(undefined),
        reportStatus: (items) => {
          reports.push(items);
          return Promise.resolve();
        },
        registerCommands: () =>
          Promise.resolve({
            update: () => undefined,
            dispose: () => undefined,
          }),
        reportFocus: () => Promise.resolve(undefined),
        reportAgentSessionSelection: () => Promise.resolve(undefined),
        showToast: () => Promise.resolve(undefined),
      },
      hostWindow: asBrowserWindow(host),
      launch: {
        capabilities: [],
        context: {
          value: {
            computerId: null,
            focus: { editing: false, surface: null },
            visibility: "visible",
            openRequest: null,
          },
          version: 0,
        },
        identity: { appId: "app", releaseId: "release", surfaceId: "surface" },
        lifecycle: { value: "connected", version: 0 },
        reservedChords: { value: [], version: 0 },
        theme: { value: "dark", version: 0 },
      },
    });
    const root = await connectApp({ expectedHostOrigin: host.origin });
    const mounted = await hostPromise;
    const items = [
      { kind: "text", id: "state", text: "open", tone: "success" },
      { kind: "button", id: "ports", text: "Ports", count: 2 },
      { kind: "toggle", id: "preview", text: ":5173", pressed: true },
      {
        kind: "menu",
        id: "folder",
        text: "media",
        options: [{ id: "/media", text: "/media", checked: true }],
      },
      { kind: "text", id: "save", text: "All changes saved", end: true },
    ] as const;
    await root.ui.reportStatus(items);
    expect(reports).toEqual([items]);
    await expect(
      root.ui.reportStatus([
        { kind: "text", id: "long", text: "x".repeat(81) },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      root.ui.reportStatus(
        Array.from({ length: 7 }, (_, index) => ({
          kind: "text" as const,
          id: String(index),
          text: "item",
        })),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      root.ui.reportStatus([
        { kind: "text", id: "same", text: "one" },
        { kind: "text", id: "same", text: "two" },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      root.ui.reportStatus([
        { kind: "text", id: "spoof", text: "Computer: \u202eoiduts" },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    for (const hidden of ["\u2028", "\u2029", "\u200b", "\ufeff", "\u061c"])
      await expect(
        root.ui.reportStatus([
          { kind: "text", id: "hidden", text: `Studio${hidden}` },
        ]),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      root.ui.reportStatus([
        {
          kind: "menu",
          id: "menu",
          text: "Pick",
          options: [
            { id: "same", text: "One" },
            { id: "same", text: "Two" },
          ],
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(reports).toHaveLength(1);
    await root.ui.reportStatus(items);
    reports.pop();

    // Nothing owns actions yet: the host hears that nothing acted.
    await expect(mounted.activateStatus({ itemId: "ports" })).resolves.toBe(
      false,
    );
    const actions: unknown[] = [];
    const release = root.ui.onStatusAction((action) => {
      actions.push(action);
      return true;
    });
    expect(() => root.ui.onStatusAction(() => false)).toThrow();
    await expect(
      mounted.activateStatus({ itemId: "folder", optionId: "/media" }),
    ).resolves.toBe(true);
    expect(actions).toEqual([{ itemId: "folder", optionId: "/media" }]);
    // The App session checks each action against what the App declares now,
    // even when the shell's copy is stale.
    for (const stale of [
      { itemId: "state" },
      { itemId: "gone" },
      { itemId: "folder", optionId: "nope" },
      { itemId: "folder" },
      { itemId: "ports", optionId: "/media" },
    ])
      await expect(mounted.activateStatus(stale)).resolves.toBe(false);
    await root.ui.reportStatus([
      { kind: "button", id: "ports", text: "Ports", disabled: true },
    ]);
    await expect(mounted.activateStatus({ itemId: "ports" })).resolves.toBe(
      false,
    );
    expect(actions).toHaveLength(1);
    release();
    await expect(mounted.activateStatus({ itemId: "ports" })).resolves.toBe(
      false,
    );
    disposePair(root, mounted);
  } finally {
    restoreWindow(originalWindow);
  }
});
