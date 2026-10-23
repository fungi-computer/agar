import { reportCatchFailure } from "./failure.js";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import type { AppRoot } from "./root.js";

/**
 * WHY: the iframe owns one authenticated page epoch; this door validates the
 * host before handing transport ownership to the internal session (2026-08-27).
 */
import { AppError } from "./errors.js";
import { connectAppPort } from "./internal/app-session.js";
import {
  APP_CONNECT_TYPE,
  APP_PROTOCOL_VERSION,
  APP_READY_TYPE,
} from "./internal/protocol.js";
import { parseConnect } from "./internal/schemas.js";

/** Options for connecting this iframe page to its authenticated host. */
export type ConnectAppOptions = {
  /** The parent is the host. Serve the App with CSP `frame-ancestors` pinned
   * to its allowed host so an unrelated site cannot become its parent. */
  readonly host: "parent";
  /** Cancels a pending connection attempt. */
  readonly signal?: AbortSignal;
};

let liveConnection = false;

/** Owns the pending handshake and its one-way transition into a live epoch. */
class PendingAppConnection {
  readonly #appWindow: typeof globalThis & Window;
  #port: MessagePort | undefined;
  #settled = false;
  #readyRetry: ReturnType<typeof setInterval> | undefined;
  #deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly options: ConnectAppOptions) {
    this.#appWindow = globalThis.window;
  }

  start(): Promise<AppRoot> {
    performance.mark("fungi.app-open.agar-connect-start");
    const error = this.#startError();
    if (error) return Promise.reject(error);
    liveConnection = true;
    return this.#awaitConnection();
  }

  #awaitConnection(): Promise<AppRoot> {
    return new Promise<AppRoot>((resolve, reject) => {
      const finish = (error?: AppError, root?: AppRoot): void => {
        this.#finish(error, root, onMessage, onAbort, resolve, reject);
      };
      const onAbort = (): void => {
        finish(cancelled());
      };
      const onMessage = (event: MessageEvent<unknown>): void => {
        this.#onMessage(event, finish, onMessage);
      };
      this.#appWindow.addEventListener("message", onMessage);
      this.options.signal?.addEventListener("abort", onAbort, { once: true });
      const notify = () => {
        try {
          performance.mark("fungi.app-open.agar-ready-sent");
          this.#appWindow.parent.postMessage(
            { protocolVersion: APP_PROTOCOL_VERSION, type: APP_READY_TYPE },
            "*",
          );
        } catch (cause) {
          reportCatchFailure("connect.notify-host", cause);
          finish(notifyError(cause));
        }
      };
      // A remounted document can announce itself before its host sees load.
      // Retry only the handshake, never an admitted App operation.
      this.#readyRetry = setInterval(notify, 200);
      this.#deadline = setTimeout(() => {
        finish(disconnected());
      }, 10_000);
      notify();
    });
  }

  #finish(
    error: AppError | undefined,
    root: AppRoot | undefined,
    onMessage: (event: MessageEvent<unknown>) => void,
    onAbort: () => void,
    resolve: (root: AppRoot) => void,
    reject: (error: AppError) => void,
  ): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#stopReady();
    this.#appWindow.removeEventListener("message", onMessage);
    this.options.signal?.removeEventListener("abort", onAbort);
    if (error || !root) {
      this.#port?.close();
      liveConnection = false;
      reject(error ?? disconnected());
      return;
    }
    resolve(root);
  }

  #onMessage(
    event: MessageEvent<unknown>,
    finish: (error?: AppError, root?: AppRoot) => void,
    onMessage: (event: MessageEvent<unknown>) => void,
  ): void {
    if (!isConnectMessage(event.data)) return;
    performance.mark("fungi.app-open.agar-connect-received");
    if (
      event.source !== this.#appWindow.parent ||
      expectedOrigin(event.origin) === undefined
    ) {
      finish(identityError());
      return;
    }
    const message = parseConnection(event, finish);
    if (!message) return;
    const port = event.ports.length === 1 ? event.ports[0] : undefined;
    if (!port) {
      finish(protocolError("The app host did not transfer exactly one port"));
      return;
    }
    this.#port = port;
    this.#stopReady();
    this.#appWindow.removeEventListener("message", onMessage);
    void connectAppPort({
      epoch: message.epoch,
      isActive: () => !this.#settled,
      onDisposed: () => {
        liveConnection = false;
      },
      port,
      window: this.#appWindow,
    }).then(
      (root) => {
        performance.mark("fungi.app-open.agar-root-ready");
        finish(undefined, root);
      },
      (cause: unknown) => {
        finish(connectionError(cause));
      },
    );
  }

  #stopReady(): void {
    clearInterval(this.#readyRetry);
    clearTimeout(this.#deadline);
    this.#readyRetry = undefined;
    this.#deadline = undefined;
  }

  #startError(): AppError | undefined {
    if (this.options.signal?.aborted) return cancelled();
    if (liveConnection)
      return new AppError("An app connection is already live", {
        code: "IDENTITY",
        retryable: false,
      });
    if (
      Predicate.isUndefined(globalThis.window) ||
      this.#appWindow.parent === this.#appWindow
    )
      return new AppError("The app host is unavailable", {
        code: "DISCONNECTED",
        retryable: true,
      });
    return undefined;
  }
}

/** Connects this iframe page to its authenticated host. */
export function connectApp(options: ConnectAppOptions): Promise<AppRoot> {
  return new PendingAppConnection(options).start();
}

function cancelled(): AppError {
  return new AppError("App connection was cancelled", {
    code: "CANCELLED",
    retryable: false,
  });
}

function connectionError(cause: unknown): AppError {
  return cause instanceof AppError
    ? cause
    : new AppError("Unable to connect to the app host", {
        cause,
        code: "PROTOCOL",
        retryable: false,
      });
}

function disconnected(): AppError {
  return new AppError("The app host disconnected", {
    code: "DISCONNECTED",
    retryable: true,
  });
}

function expectedOrigin(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const origin = new URL(value).origin;
  return origin === value ? origin : undefined;
}

function identityError(): AppError {
  return new AppError("The app connection identity is invalid", {
    code: "IDENTITY",
    retryable: false,
  });
}

const isConnectMessage = Schema.is(
  Schema.Struct({ type: Schema.Literal(APP_CONNECT_TYPE) }),
);

function notifyError(cause: unknown): AppError {
  return new AppError("Unable to notify the app host", {
    cause,
    code: "DISCONNECTED",
    retryable: true,
  });
}

function parseConnection(
  event: MessageEvent<unknown>,
  finish: (error?: AppError, root?: AppRoot) => void,
) {
  try {
    return parseConnect(event.data);
  } catch (cause) {
    reportCatchFailure("connect.decode-message", cause);
    finish(
      cause instanceof AppError
        ? cause
        : new AppError("Malformed app connection", {
            cause,
            code: "PROTOCOL",
            retryable: false,
          }),
    );
    return undefined;
  }
}

function protocolError(message: string): AppError {
  return new AppError(message, { code: "PROTOCOL", retryable: false });
}
