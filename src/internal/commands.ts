import * as Predicate from "effect/Predicate";
import { type RpcStub, RpcTarget } from "@fungi.computer/capnweb";

import type { AppCommandHandler, AppCommands } from "../commands.js";
import { WhistleActionError } from "@fungi.computer/whistle";
import { parseFailure } from "@fungi.computer/whistle/wire";
import type { Disposer } from "../store.js";
import type { LocalBinding, LocalBindingState } from "./browser-bridge.js";
import type {
  AppHostRpc,
  CommandHandlerRpc,
  CommandInvocationWire,
  CommandInvocationResultWire,
} from "./protocol.js";

import { AppError } from "../errors.js";
import { type RpcResult, callRpc, rpcFailure, rpcSuccess } from "./result.js";
import {
  appInvocation,
  parseCommand,
  parseCommandId,
  parseCommandInvocation,
  parseCommandResult,
  parseRegisteredCommandResult,
  parseVoidResult,
} from "./schemas.js";

export type AppCommandsController = {
  readonly commands: AppCommands;
  dispose(): void;
};

type CommandRegistration = {
  commandId: string | undefined;
  readonly definition: ReturnType<typeof parseCommand>;
  readonly handler: AppCommandHandler;
  readonly target: CommandHandlerTarget;
};

type RegistrationLease = {
  commit(commandId: string): void;
  release(): void;
  readonly target: CommandHandlerTarget;
};

class CommandHandlerTarget extends RpcTarget implements CommandHandlerRpc {
  #active = true;
  readonly #handler: AppCommandHandler;
  readonly #requests = new Map<string, AbortController>();

  constructor(handler: AppCommandHandler) {
    super();
    this.#handler = handler;
  }

  cancel(requestId: string) {
    try {
      this.#requests.get(parseCommandId(requestId))?.abort();
      return Promise.resolve(rpcSuccess(undefined));
    } catch (cause) {
      return Promise.resolve(rpcFailure<undefined>(cause));
    }
  }

  dispose(): void {
    if (!this.#active) return;
    this.#active = false;
    for (const controller of this.#requests.values()) controller.abort();
    this.#requests.clear();
  }

  async invoke(value: CommandInvocationWire) {
    try {
      if (!this.#active)
        throw new AppError("The command is disposed", {
          code: "DISCONNECTED",
          retryable: true,
        });
      const invocation = parseCommandInvocation(value);
      if (this.#requests.has(invocation.requestId)) {
        throw new AppError("Duplicate command request", {
          code: "PROTOCOL",
          retryable: false,
        });
      }
      if (this.#requests.size >= 64) {
        throw new AppError("Too many command requests", {
          code: "HOST_FAILURE",
          retryable: true,
        });
      }
      const controller = new AbortController();
      this.#requests.set(invocation.requestId, controller);
      try {
        const result = await this.#handler(
          appInvocation(invocation, controller.signal),
        );
        const parsed = parseCommandResult(result);
        return rpcSuccess<CommandInvocationResultWire>(
          parsed === undefined
            ? { status: "handled" }
            : { status: "handled", result: parsed },
        );
      } finally {
        this.#requests.delete(invocation.requestId);
      }
    } catch (cause) {
      if (cause instanceof WhistleActionError) {
        try {
          const failureInput = {
            code: cause.code,
            message: cause.message,
            details: cause.details,
          };
          const failure = parseFailure(failureInput);
          return rpcSuccess<CommandInvocationResultWire>({
            status: "failed",
            error: failure,
          });
        } catch (failureCause) {
          return rpcFailure<CommandInvocationResultWire>(failureCause);
        }
      }
      return rpcFailure<CommandInvocationResultWire>(cause);
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/**
 * Project the committed commands' single-chord bindings for the iframe's App
 * layer. `<leader>` sequences belong to the shell, which reaches them through
 * the reserved chord, so they are not matched here.
 */
function localBindings(
  registrations: ReadonlyMap<string, CommandRegistration>,
): readonly LocalBinding[] {
  const bindings: LocalBinding[] = [];
  for (const registration of registrations.values()) {
    const { definition, handler } = registration;
    if (registration.commandId === undefined) continue;
    // An unavailable command still owns its chord, so the browser default
    // (e.g. Save Page) does not run in its place.
    const available = definition.availability?.status !== "unavailable";
    for (const key of definition.projections?.bindings?.values ?? []) {
      if (key.trim().includes(" ") || key.startsWith("<")) continue;
      bindings.push({
        key,
        run: () => {
          if (!available) return;
          void Promise.resolve()
            .then(() =>
              handler({
                origin: "keyboard",
                signal: new AbortController().signal,
              }),
            )
            .catch((cause: unknown) => {
              console.warn("App key command failed", cause);
            });
        },
      });
    }
  }
  return bindings;
}

export function createAppCommands(
  remote: RpcStub<AppHostRpc>,
  assertConnected: () => void,
  onFatal: () => void,
  bindings?: LocalBindingState,
): AppCommandsController {
  const registrations = new Map<string, CommandRegistration>();
  let disposed = false;
  const publishBindings = (): void => {
    bindings?.update(disposed ? [] : localBindings(registrations));
  };

  const reportFatal = (cause: unknown): void => {
    try {
      onFatal();
    } catch (callbackError) {
      console.warn("App command failure callback failed", callbackError, cause);
    }
  };

  const supervise = (operation: () => PromiseLike<RpcResult<void>>): void => {
    try {
      void callRpc(operation(), parseVoidResult).catch((cause: unknown) => {
        reportFatal(cause);
      });
    } catch (cause) {
      console.warn("App command RPC supervision failed", cause);
      reportFatal(cause);
    }
  };

  const unregister = (id: string): void => {
    const registration = registrations.get(id);
    if (!registration) return;
    registrations.delete(id);
    registration.target.dispose();
    publishBindings();
    const commandId = registration.commandId;
    if (!disposed && commandId !== undefined) {
      supervise(() => remote.unregisterCommand(commandId));
    }
  };

  const commands = createCommandApi(
    remote,
    assertConnected,
    registrations,
    () => disposed,
    unregister,
    publishBindings,
  );
  return {
    commands,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const registration of registrations.values())
        registration.target[Symbol.dispose]();
      registrations.clear();
      publishBindings();
    },
  };
}

function claimRegistration(
  registrations: Map<string, CommandRegistration>,
  definition: ReturnType<typeof parseCommand>,
  handler: AppCommandHandler,
  target: CommandHandlerTarget,
): RegistrationLease {
  const id = definition.id;
  if (registrations.size >= 128 || registrations.has(id)) {
    target.dispose();
    throw new AppError("Command registration is unavailable", {
      code: "INVALID_ARGUMENT",
      retryable: false,
    });
  }
  const registration: CommandRegistration = {
    commandId: undefined,
    definition,
    handler,
    target,
  };
  registrations.set(id, registration);
  let released = false;
  return {
    commit(commandId) {
      if (released) return;
      registration.commandId = commandId;
    },
    release() {
      if (released) return;
      released = true;
      if (registrations.get(id) === registration) registrations.delete(id);
      target.dispose();
    },
    target,
  };
}

function createCommandApi(
  remote: RpcStub<AppHostRpc>,
  assertConnected: () => void,
  registrations: Map<string, CommandRegistration>,
  isDisposed: () => boolean,
  unregister: (id: string) => void,
  committed: () => void,
): AppCommands {
  return Object.freeze({
    async register(
      command: Parameters<AppCommands["register"]>[0],
      handler: AppCommandHandler,
    ): Promise<Disposer> {
      assertConnected();
      if (!Predicate.isFunction(handler)) {
        throw new AppError("Command handler must be a function", {
          code: "INVALID_ARGUMENT",
          retryable: false,
        });
      }
      const definition = parseCommand(command);
      const target = new CommandHandlerTarget(handler);
      const lease = claimRegistration(
        registrations,
        definition,
        handler,
        target,
      );
      try {
        const registration = await registerRemoteCommand(
          remote,
          definition,
          lease.target,
        );
        if (isDisposed()) {
          await rejectDisposedRegistration(
            remote,
            registration.commandId,
            target,
          );
        }
        lease.commit(registration.commandId);
        committed();
      } catch (cause) {
        lease.release();
        throw cause;
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unregister(definition.id);
      };
    },
  });
}

async function registerRemoteCommand(
  remote: RpcStub<AppHostRpc>,
  definition: ReturnType<typeof parseCommand>,
  target: CommandHandlerTarget,
) {
  return callRpc(
    remote.registerCommand(definition, target),
    parseRegisteredCommandResult,
  );
}

async function rejectDisposedRegistration(
  remote: RpcStub<AppHostRpc>,
  commandId: string,
  target: CommandHandlerTarget,
): Promise<never> {
  target.dispose();
  await callRpc(remote.unregisterCommand(commandId), parseVoidResult);
  throw new AppError("The command controller is disposed", {
    code: "DISCONNECTED",
    retryable: true,
  });
}
