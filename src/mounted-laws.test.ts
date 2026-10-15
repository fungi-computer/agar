import * as z from "zod";
import { defineCapability } from "./capabilities.js";
import {
  rpcHandleSchema,
  rpcMethod,
  rpcDataSchema,
} from "./internal/rpc-contract.js";
import type {
  AppReadyMessage,
  AppConnectMessage,
} from "./internal/protocol.js";
// @vitest-environment jsdom
import { newMessagePortRpcSession, RpcTarget } from "@fungi.computer/capnweb";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mountApp } from "./react-mount.js";

import type { AppClientRpc } from "./internal/protocol.js";

import { connectApp } from "./connect.js";
import { AppError } from "./errors.js";
import { appBackend } from "./backend.js";
import { type AppHostHandlers, connectAppHost } from "./host.js";
import { disposeRpcValue } from "./internal/capabilities.js";
import { disconnectHost } from "./internal/disconnect-host.js";
import { rpcSuccess } from "./internal/result.js";

it("isolates mounted App contents below body-portaled overlays", () => {
  const element = document.createElement("div");
  document.body.append(element);
  let dispose: (() => void) | undefined;
  try {
    act(() => {
      dispose = mountApp(element, { name: "Overlay host" }, () => null);
    });
    expect(element.style.isolation).toBe("isolate");
  } finally {
    act(() => dispose?.());
    element.remove();
  }
});

class FakeWindow extends EventTarget {
  readonly document = globalThis.document;
  parent: FakeWindow = this;
  peer?: FakeWindow;
  constructor(readonly origin: string) {
    super();
  }
  postMessage(
    data: AppReadyMessage | AppConnectMessage,
    _origin: string,
    transfer?: Transferable[],
  ): void {
    if (!this.peer) throw new Error("missing peer");
    const event = new MessageEvent<AppReadyMessage | AppConnectMessage>(
      "message",
    );
    Object.defineProperties(event, {
      data: { value: data },
      origin: { value: this.peer.origin },
      ports: {
        value: transfer?.filter((item) => item instanceof MessagePort) ?? [],
      },
      source: { value: this.peer },
    });
    this.dispatchEvent(event);
  }
}

function asBrowserWindow(value: FakeWindow): Window {
  // SAFETY: this mounted-host double supplies the actual Document, native EventTarget,
  // parent/source identity and MessagePort transfer used by connectAppHost/connectApp.
  return value as Window;
}

const launch = (
  capabilities: readonly { handle: object; id: string; version: number }[] = [],
) => ({
  capabilities,
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
});

const handlers = (
  onDisconnect: () => Promise<void> = vi.fn(() => Promise.resolve(undefined)),
) => ({
  invokeReservedChord: () => Promise.resolve(undefined),
  onDisconnect,
  openNavigation: () => Promise.resolve(undefined),
  registerCommands: () =>
    Promise.resolve({ update: () => undefined, dispose: () => undefined }),
  reportFocus: () => Promise.resolve(undefined),
  reportAgentSessionSelection: () => Promise.resolve(undefined),
  showToast: () => Promise.resolve(undefined),
});

function message(
  source: FakeWindow,
  origin: string,
  ports: MessagePort[] = [],
  protocolVersion = 2,
) {
  const event = new MessageEvent<unknown>("message");
  Object.defineProperties(event, {
    data: { value: { protocolVersion, type: "fungi.app.ready" } },
    origin: { value: origin },
    ports: { value: ports },
    source: { value: source },
  });
  return event;
}

describe("mounted App SDK doors", () => {
  it(
    "rejects an invalid host origin before claiming an iframe mount",
    invalidHostOrigin,
  );
  it(
    "rejects invalid app origins and pre-aborted app sessions",
    invalidAppSession,
  );
  it("aborts a held host mount and permits the next epoch", abortsHeldMount);
  it.each(["https://app.example", "null"])(
    "rejects hostile %s source, origin, protocol, and port doors and releases each mount",
    rejectsHostileDoors,
  );
  it(
    "LAW: simultaneous opaque-origin mounts ignore each other's ready messages",
    simultaneousMountsIgnoreForeignReady,
  );
  it(
    "local disposal is synchronous and suppresses later break callbacks",
    localDisposal,
  );
  it(
    "preserves a typed stale-selection failure across the mounted host bridge",
    staleSelectionFailureCrossesHostBridge,
  );
  it(
    "LAW: app-error terminal history permits the next same-iframe epoch",
    appErrorTerminal,
  );
  it(
    "LAW: unexpected break history permits the next same-iframe epoch",
    unexpectedBreakTerminal,
  );
  it(
    "LAW: graceful and break race settles and notifies exactly once",
    gracefulBreakRace,
  );
  it(
    "LAW: throwing onDisconnect is warned and cannot poison the next epoch",
    throwingDisconnect,
  );
  it(
    "LAW: throwing terminal command disposer is isolated and permits the next epoch",
    throwingTerminalDisposer,
  );
  it(
    "LAW: queued initial focus failure disposes once and permits the next epoch",
    queuedInitialFocusFailure,
  );
  it(
    "LAW: deferred disconnect carries the bounded error before terminal effects",
    deferredDisconnectError,
  );
  it(
    "LAW: reconfiguration preserves the root and ignores stale context",
    reconfigurationPreservesRoot,
  );
  it(
    "LAW: reconfiguration releases rejected, stale, replaced and final handles",
    reconfigurationOwnsHandles,
  );
  it(
    "LAW: a broken deferred disconnect rejects once and ignores the late response",
    brokenDeferredDisconnect,
  );
});

class DeferredClient extends RpcTarget implements AppClientRpc {
  received: Parameters<AppClientRpc["disconnect"]>[0];
  receivedCall = false;
  release:
    | ((value: Awaited<ReturnType<AppClientRpc["disconnect"]>>) => void)
    | undefined;

  disconnect(
    error?: Parameters<AppClientRpc["disconnect"]>[0],
  ): ReturnType<AppClientRpc["disconnect"]> {
    this.receivedCall = true;
    this.received = error;
    return new Promise((resolve) => {
      this.release = resolve;
    });
  }

  requestClose() {
    return Promise.resolve(rpcSuccess(true));
  }

  requestBack() {
    return Promise.resolve(rpcSuccess(false));
  }

  activateStatus() {
    return Promise.resolve(rpcSuccess(false));
  }

  updateContext() {
    return Promise.resolve(rpcSuccess(undefined));
  }
  reconfigure() {
    return Promise.resolve(rpcSuccess(undefined));
  }
  updateLifecycle() {
    return Promise.resolve(rpcSuccess(undefined));
  }
  updateReservedChords() {
    return Promise.resolve(rpcSuccess(undefined));
  }
  updateTheme() {
    return Promise.resolve(rpcSuccess(undefined));
  }
}

async function abortsHeldMount(): Promise<void> {
  const host = new FakeWindow("https://host.example");
  const app = new FakeWindow("https://app.example");
  const controller = new AbortController();
  const pending = connectAppHost({
    appWindow: asBrowserWindow(app),
    expectedAppOrigin: app.origin,
    handlers: handlers(),
    hostWindow: asBrowserWindow(host),
    launch: launch(),
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  const nextController = new AbortController();
  const next = connectAppHost({
    appWindow: asBrowserWindow(app),
    expectedAppOrigin: app.origin,
    handlers: handlers(),
    hostWindow: asBrowserWindow(host),
    launch: launch(),
    signal: nextController.signal,
  });
  nextController.abort();
  await expect(next).rejects.toMatchObject({ code: "CANCELLED" });
}

async function appErrorTerminal(): Promise<void> {
  const { app, host, mount, restore } = await prepareMount();
  try {
    const history: string[] = [];
    mount.root.lifecycle.subscribe((value) => history.push(value));
    const terminalError = new AppError("terminal", {
      code: "HOST_FAILURE",
      retryable: false,
    });
    expect(terminalError).toMatchObject({
      code: "HOST_FAILURE",
      message: "terminal",
      retryable: false,
    });
    await mount.host.disconnect(terminalError);
    await eventually(() => history.length === 3);
    expect(history).toEqual(["disconnected", "disposing", "disposed"]);
    await expectNextEpoch(app, host);
  } finally {
    mount.root.dispose();
    mount.host.dispose();
    restore();
  }
}

async function brokenDeferredDisconnect(): Promise<void> {
  const { channel, client, peer, target } = deferredClient();
  let graceful = 0;
  let disposed = 0;
  const pending = disconnectHost(
    undefined,
    () => undefined,
    {
      client,
      onGracefulDisconnect: () => {
        graceful += 1;
        return Promise.resolve();
      },
    },
    () => {
      disposed += 1;
    },
  );
  await eventually(() => target.receivedCall);
  disposeRpcValue(peer);
  await expect(pending).rejects.toMatchObject({ code: "HOST_FAILURE" });
  expect(graceful).toBe(0);
  expect(disposed).toBe(1);
  target.release?.(rpcSuccess(undefined));
  expect(disposed).toBe(1);
  disposeRpcValue(client);
  channel.port1.close();
  channel.port2.close();
}

async function reconfigurationPreservesRoot(): Promise<void> {
  const { mount, restore } = await prepareMount();
  try {
    const contract = defineCapability(
      "test.computer",
      1,
      rpcHandleSchema({
        name: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => z.string().parse(value)),
          ),
        ),
      }),
    );
    class Computer extends RpcTarget {
      name() {
        return "computer-a";
      }
    }
    const directory = mount.root.capabilities;
    const versions: number[] = [];
    const unsubscribe = directory.subscribe(() => {
      versions.push(directory.version);
    });
    await mount.host.reconfigure({
      capabilities: [{ ...contract, handle: new Computer() }],
      context: {
        version: 1,
        value: {
          computerId: "computer-a",
          focus: { editing: false, surface: null },
          openRequest: null,
          visibility: "visible",
        },
      },
    });
    expect(mount.root.capabilities).toBe(directory);
    expect(versions).toEqual([1]);
    expect(mount.root.context.get().computerId).toBe("computer-a");
    await expect(
      mount.root.capabilities
        .require<{ name(): Promise<string> }>(contract)
        .name(),
    ).resolves.toBe("computer-a");
    await mount.host.reconfigure({
      capabilities: [],
      context: {
        version: 1,
        value: {
          computerId: "computer-b",
          focus: { editing: false, surface: null },
          openRequest: null,
          visibility: "visible",
        },
      },
    });
    expect(mount.root.context.get().computerId).toBe("computer-a");
    await expect(
      mount.root.capabilities
        .require<{ name(): Promise<string> }>(contract)
        .name(),
    ).resolves.toBe("computer-a");
    expect(versions).toEqual([1]);
    mount.root.dispose();
    expect(versions).toEqual([1, 2]);
    unsubscribe();
  } finally {
    mount.root.dispose();
    mount.host.dispose();
    restore();
  }
}

async function reconfigurationOwnsHandles(): Promise<void> {
  const { mount, restore } = await prepareMount();
  const disposed: string[] = [];
  class Handle extends RpcTarget {
    constructor(readonly label: string) {
      super();
    }
    name() {
      return this.label;
    }
    [Symbol.dispose]() {
      disposed.push(this.label);
    }
  }
  const contract = defineCapability(
    "test.computer",
    1,
    rpcHandleSchema({
      name: rpcMethod(
        rpcDataSchema(
          z.unknown().transform((value) => z.string().parse(value)),
        ),
      ),
    }),
  );
  const grant = (label: string, id = contract.id) => ({
    ...contract,
    id,
    handle: new Handle(label),
  });
  const context = (version: number, computerId = "computer-a") => ({
    version,
    value: {
      computerId,
      focus: { editing: false, surface: null },
      openRequest: null,
      visibility: "visible" as const,
    },
  });
  const name = () =>
    mount.root.capabilities
      .require<{ name(): Promise<string> }>(contract)
      .name();
  try {
    await mount.host.reconfigure({
      capabilities: [grant("first")],
      context: context(1),
    });
    await expect(name()).resolves.toBe("first");
    await mount.host.reconfigure({
      capabilities: [grant("stale")],
      context: context(1),
    });
    await eventually(() => disposed.includes("stale"));
    await expect(
      mount.host.reconfigure({
        capabilities: [
          grant("invalid-one"),
          grant("invalid-two"),
          grant("invalid-tail", "test.tail"),
        ],
        context: context(2, "computer-b"),
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL" });
    await eventually(() =>
      ["invalid-one", "invalid-two", "invalid-tail"].every((label) =>
        disposed.includes(label),
      ),
    );
    await expect(name()).resolves.toBe("first");
    expect(mount.root.context.get().computerId).toBe("computer-a");
    await mount.host.reconfigure({
      capabilities: [grant("second")],
      context: context(2, "computer-b"),
    });
    await eventually(() => disposed.includes("first"));
    await expect(name()).resolves.toBe("second");
    mount.root.dispose();
    mount.host.dispose();
    await eventually(() => disposed.includes("second"));
    expect(disposed.sort()).toEqual([
      "first",
      "invalid-one",
      "invalid-tail",
      "invalid-two",
      "second",
      "stale",
    ]);
  } finally {
    mount.root.dispose();
    mount.host.dispose();
    restore();
  }
}

function deferredClient() {
  const channel = new MessageChannel();
  const target = new DeferredClient();
  const client = newMessagePortRpcSession<AppClientRpc>(channel.port1);
  const peer = newMessagePortRpcSession(channel.port2, target);
  return { channel, client, peer, target };
}

async function deferredDisconnectError(): Promise<void> {
  const { channel, client, peer, target } = deferredClient();
  let graceful = 0;
  let disposed = 0;
  const error = new AppError("terminal", {
    code: "HOST_FAILURE",
    retryable: false,
  });
  const pending = disconnectHost(
    error,
    () => undefined,
    {
      client,
      onGracefulDisconnect: () => {
        graceful += 1;
        return Promise.resolve();
      },
    },
    () => {
      disposed += 1;
    },
  );
  await eventually(() => target.receivedCall);
  expect(target.received).toEqual({
    code: "HOST_FAILURE",
    message: "terminal",
    retryable: false,
  });
  expect(graceful).toBe(0);
  expect(disposed).toBe(0);
  target.release?.(rpcSuccess(undefined));
  await pending;
  expect(graceful).toBe(1);
  expect(disposed).toBe(1);
  disposeRpcValue(peer);
  disposeRpcValue(client);
  channel.port1.close();
  channel.port2.close();
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt++)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}

async function expectNextEpoch(
  app: FakeWindow,
  host: FakeWindow,
): Promise<void> {
  const pending = connectAppHost({
    appWindow: asBrowserWindow(app),
    expectedAppOrigin: app.origin,
    handlers: handlers(),
    hostWindow: asBrowserWindow(host),
    launch: launch(),
  });
  const root = await connectApp({ expectedHostOrigin: host.origin });
  const mounted = await pending;
  root.dispose();
  mounted.dispose();
}

async function gracefulBreakRace(): Promise<void> {
  let notifications = 0;
  const { breakTransport, mount, restore } = await prepareMount(true, () => {
    notifications += 1;
    return Promise.resolve();
  });
  try {
    let acknowledged = false;
    const graceful = mount.host.disconnect();
    const acknowledgement = graceful.then(() => {
      acknowledged = true;
      breakTransport();
    });
    await graceful;
    await acknowledgement;
    await eventually(() => mount.root.lifecycle.get() === "disposed");
    expect(acknowledged).toBe(true);
    expect(notifications).toBe(1);
  } finally {
    mount.root.dispose();
    mount.host.dispose();
    restore();
  }
}

async function invalidAppSession(): Promise<void> {
  await expect(
    connectApp({ expectedHostOrigin: "not-an-origin" }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  const controller = new AbortController();
  controller.abort();
  await expect(
    connectApp({
      expectedHostOrigin: "https://host.example",
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
}

async function invalidHostOrigin(): Promise<void> {
  const app = new FakeWindow("https://app.example");
  await expect(
    connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: "not-an-origin",
      handlers: handlers(),
      hostWindow: asBrowserWindow(app),
      launch: launch(),
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
}

async function localDisposal(): Promise<void> {
  const host = new FakeWindow("https://host.example");
  const app = new FakeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const onDisconnect = vi.fn(() => Promise.resolve(undefined));
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: app,
  });
  const pending = connectAppHost({
    appWindow: asBrowserWindow(app),
    expectedAppOrigin: app.origin,
    handlers: handlers(onDisconnect),
    hostWindow: asBrowserWindow(host),
    launch: launch(),
  });
  await connectApp({ expectedHostOrigin: host.origin });
  const mounted = await pending;
  mounted.dispose();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(onDisconnect).not.toHaveBeenCalled();
  const controller = new AbortController();
  const next = connectAppHost({
    appWindow: asBrowserWindow(app),
    expectedAppOrigin: app.origin,
    handlers: handlers(),
    hostWindow: asBrowserWindow(host),
    launch: launch(),
    signal: controller.signal,
  });
  controller.abort();
  await expect(next).rejects.toMatchObject({ code: "CANCELLED" });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
}

async function prepareMount(
  capture = false,
  onDisconnect: () => Promise<void> = () => Promise.resolve(undefined),
  terminalDisposer: () => void = () => undefined,
  reportFocus: AppHostHandlers["reportFocus"] = () =>
    Promise.resolve(undefined),
  capabilities: Parameters<typeof launch>[0] = [],
  browserAction?: AppHostHandlers["requestBrowserAction"],
  computerChoice?: () => Promise<void>,
) {
  const host = new FakeWindow("https://host.example");
  const app = new FakeWindow("https://app.example");
  app.parent = host;
  app.peer = host;
  host.peer = app;
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: app,
  });
  let transferred: MessagePort | undefined;
  if (capture)
    app.addEventListener("message", (event) => {
      if (event instanceof MessageEvent) transferred ??= event.ports[0];
    });
  let hostHandlers: AppHostHandlers = {
    ...handlers(onDisconnect),
    registerCommands: () =>
      Promise.resolve({ update: () => undefined, dispose: terminalDisposer }),
    reportFocus,
    reportAgentSessionSelection: () => Promise.resolve(undefined),
  };
  if (browserAction !== undefined)
    hostHandlers = { ...hostHandlers, requestBrowserAction: browserAction };
  if (computerChoice !== undefined)
    hostHandlers = { ...hostHandlers, requestComputerChoice: computerChoice };
  const hostPromise = connectAppHost({
    appWindow: asBrowserWindow(app),
    expectedAppOrigin: app.origin,
    handlers: hostHandlers,
    hostWindow: asBrowserWindow(host),
    launch: launch(capabilities),
  });
  const root = await connectApp({ expectedHostOrigin: host.origin });
  const mountedHost = await hostPromise;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    app,
    breakTransport: () => transferred?.postMessage(null),
    host,
    mount: { host: mountedHost, root },
    restore: () =>
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      }),
  };
}

async function staleSelectionFailureCrossesHostBridge(): Promise<void> {
  class StaleBackend extends RpcTarget {
    request(): Promise<never> {
      return Promise.reject(
        new AppError("The App selection changed. Reopening it.", {
          code: "SELECTION_CHANGED",
          retryable: false,
        }),
      );
    }
  }
  const { mount, restore } = await prepareMount(
    false,
    undefined,
    undefined,
    undefined,
    [{ ...appBackend, handle: new StaleBackend() }],
  );
  try {
    const backend = mount.root.capabilities.require(appBackend);
    await expect(backend.request("{}")).rejects.toMatchObject({
      code: "SELECTION_CHANGED",
      retryable: false,
    });
  } finally {
    mount.root.dispose();
    mount.host.dispose();
    restore();
  }
}

async function queuedInitialFocusFailure(): Promise<void> {
  const reportFocus = vi.fn(() =>
    Promise.reject(new Error("focus report failed")),
  );
  const { app, breakTransport, host, mount, restore } = await prepareMount(
    true,
    undefined,
    undefined,
    reportFocus,
  );
  try {
    await eventually(() => mount.root.lifecycle.get() === "disposed");
    expect(reportFocus).toHaveBeenCalledOnce();
    mount.host.dispose();
    void breakTransport;
    await expectNextEpoch(app, host);
  } finally {
    mount.root.dispose();
    mount.host.dispose();
    restore();
  }
}

async function rejectsHostileDoors(origin: string): Promise<void> {
  const host = new FakeWindow("https://host.example");
  const app = new FakeWindow(origin);
  const foreign = new FakeWindow("https://foreign.example");
  const cases: [MessageEvent<unknown>, string][] = [
    [message(app, foreign.origin), "IDENTITY"],
    [message(app, app.origin, [new MessageChannel().port1]), "PROTOCOL"],
    [message(app, app.origin, [], 2), "PROTOCOL"],
  ];
  for (const [event, code] of cases) {
    const pending = connectAppHost({
      appWindow: asBrowserWindow(app),
      expectedAppOrigin: app.origin,
      handlers: handlers(),
      hostWindow: asBrowserWindow(host),
      launch: launch(),
    });
    host.dispatchEvent(event);
    await expect(pending).rejects.toMatchObject({ code });
  }
}

async function simultaneousMountsIgnoreForeignReady(): Promise<void> {
  const host = new FakeWindow("https://host.example");
  const firstApp = new FakeWindow("null");
  const secondApp = new FakeWindow("null");
  firstApp.parent = host;
  firstApp.peer = host;
  secondApp.parent = host;
  secondApp.peer = host;
  const originalWindow = globalThis.window;
  let firstHost: ReturnType<typeof connectAppHost> | undefined;
  let secondHost: ReturnType<typeof connectAppHost> | undefined;
  let firstRoot: Awaited<ReturnType<typeof connectApp>> | undefined;
  let secondRoot: Awaited<ReturnType<typeof connectApp>> | undefined;
  let firstMounted: Awaited<ReturnType<typeof connectAppHost>> | undefined;
  let secondMounted: Awaited<ReturnType<typeof connectAppHost>> | undefined;
  let secondOutcome: "connected" | "rejected" | undefined;
  try {
    firstHost = connectAppHost({
      appWindow: asBrowserWindow(firstApp),
      expectedAppOrigin: firstApp.origin,
      handlers: handlers(),
      hostWindow: asBrowserWindow(host),
      launch: launch(),
    });
    secondHost = connectAppHost({
      appWindow: asBrowserWindow(secondApp),
      expectedAppOrigin: secondApp.origin,
      handlers: handlers(),
      hostWindow: asBrowserWindow(host),
      launch: launch(),
    });
    void secondHost.then(
      () => {
        secondOutcome = "connected";
      },
      () => {
        secondOutcome = "rejected";
      },
    );

    host.peer = firstApp;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: firstApp,
    });
    firstRoot = await connectApp({ expectedHostOrigin: host.origin });
    firstMounted = await firstHost;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(secondOutcome).toBeUndefined();
    firstRoot.dispose();
    firstRoot = undefined;
    firstMounted.dispose();
    firstMounted = undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    host.peer = secondApp;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: secondApp,
    });
    secondRoot = await connectApp({ expectedHostOrigin: host.origin });
    secondMounted = await secondHost;
    expect(secondMounted).toBeDefined();
  } finally {
    firstRoot?.dispose();
    secondRoot?.dispose();
    firstMounted?.dispose();
    secondMounted?.dispose();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
}

async function throwingDisconnect(): Promise<void> {
  const onDisconnect = vi.fn(() =>
    Promise.reject(new Error("disconnect callback failed")),
  );
  const { app, breakTransport, host, mount, restore } = await prepareMount(
    true,
    onDisconnect,
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    breakTransport();
    await eventually(() => mount.root.lifecycle.get() === "disposed");
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "App host disconnect callback failed",
      expect.any(Error),
    );
    await expectNextEpoch(app, host);
  } finally {
    mount.root.dispose();
    mount.host.dispose();
    restore();
    warn.mockRestore();
  }
}

async function throwingTerminalDisposer(): Promise<void> {
  const disposer = vi.fn(() => {
    throw new Error("terminal disposer failed");
  });
  const { app, breakTransport, host, mount, restore } = await prepareMount(
    true,
    undefined,
    disposer,
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await mount.root.commands.register(
      { category: "test", id: "throw", title: "Throw" },
      () => Promise.resolve(undefined),
    );
    breakTransport();
    await eventually(() => mount.root.lifecycle.get() === "disposed");
    expect(disposer).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "App host command contribution cleanup failed",
      expect.any(Error),
    );
    await expectNextEpoch(app, host);
  } finally {
    mount.root.dispose();
    mount.host.dispose();
    restore();
    warn.mockRestore();
  }
}

async function unexpectedBreakTerminal(): Promise<void> {
  const { app, breakTransport, host, mount, restore } =
    await prepareMount(true);
  try {
    const history: string[] = [];
    mount.root.lifecycle.subscribe((value) => history.push(value));
    breakTransport();
    await eventually(() => history.length === 3);
    expect(history).toEqual(["disconnected", "disposing", "disposed"]);
    await expectNextEpoch(app, host);
  } finally {
    mount.root.dispose();
    mount.host.dispose();
    restore();
  }
}

it("carries browser copy text, typed refusal and session disposal across the existing bridge", async () => {
  const requests: unknown[] = [];
  const mounted = await prepareMount(
    false,
    undefined,
    undefined,
    undefined,
    [],
    (request) => {
      requests.push(request);
      return Promise.resolve({ kind: "refused", reason: "no-user-gesture" });
    },
  );
  try {
    const root = mounted.mount.root;
    await expect(
      root.ui.requestBrowserAction({
        kind: "copyText",
        text: "Pond 🌿",
      }),
    ).resolves.toEqual({ kind: "refused", reason: "no-user-gesture" });
    expect(requests).toEqual([
      {
        kind: "copyText",
        text: "Pond 🌿",
      },
    ]);
    root.dispose();
    await expect(
      root.ui.requestBrowserAction({ kind: "copyText", text: "Pond" }),
    ).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(requests).toHaveLength(1);
  } finally {
    mounted.mount.root.dispose();
    mounted.mount.host.dispose();
    mounted.restore();
  }
});

it("asks the mounted host to choose a Computer without changing App context", async () => {
  let requests = 0;
  const mounted = await prepareMount(
    false,
    undefined,
    undefined,
    undefined,
    [],
    undefined,
    () => {
      requests += 1;
      return Promise.resolve();
    },
  );
  try {
    const before = mounted.mount.root.context.get();
    await expect(
      mounted.mount.root.ui.requestComputerChoice(),
    ).resolves.toBeUndefined();
    expect(mounted.mount.root.context.get()).toEqual(before);
    expect(requests).toBe(1);
    mounted.mount.root.dispose();
    await expect(
      mounted.mount.root.ui.requestComputerChoice(),
    ).rejects.toMatchObject({ code: "DISCONNECTED" });
    expect(requests).toBe(1);
  } finally {
    mounted.mount.root.dispose();
    mounted.mount.host.dispose();
    mounted.restore();
  }
});

it("refuses a Computer chooser when the mounted host has none", async () => {
  const mounted = await prepareMount();
  try {
    await expect(
      mounted.mount.root.ui.requestComputerChoice(),
    ).rejects.toMatchObject({ code: "CAPABILITY_DENIED" });
  } finally {
    mounted.mount.root.dispose();
    mounted.mount.host.dispose();
    mounted.restore();
  }
});
