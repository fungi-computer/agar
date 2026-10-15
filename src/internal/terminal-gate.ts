import { AppError } from "../errors.js";

/** Private per-epoch terminal ownership; never exposed through the SDK. */
export type TerminalGate = {
  failBeforePublication(error: AppError): void;
  graceful(): Promise<void>;
  isPublished(): boolean;
  publish(): boolean;
  release(): void;
  unexpected(): void;
};

export type TerminalGateOptions = {
  readonly dispose: () => void;
  readonly onDisconnect: () => Promise<void>;
  readonly reject: (error: AppError) => void;
  readonly release: () => void;
};

/** Owns every terminal side effect for one published mount epoch. */
class MountTerminal implements TerminalGate {
  #disconnect: Promise<void> | undefined;
  #published = false;
  #settled = false;

  constructor(private readonly options: TerminalGateOptions) {}

  failBeforePublication(error: AppError): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#disposeAnd((options) => {
      options.reject(error);
    });
  }

  graceful(): Promise<void> {
    if (!this.#claimPublished()) return Promise.resolve();
    return this.#disconnectAndDispose();
  }

  isPublished(): boolean {
    return this.#published;
  }

  publish(): boolean {
    if (this.#settled || this.#published) return false;
    this.#published = true;
    return true;
  }

  release(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#warned(this.options.release, "App host mount release failed");
  }

  unexpected(): void {
    if (this.#settled) return;
    if (!this.#published) {
      this.#settled = true;
      this.#disposeAnd((options) => {
        options.reject(
          new AppError("The app host disconnected", {
            code: "DISCONNECTED",
            retryable: true,
          }),
        );
      });
      return;
    }
    // Claim before scheduling effects. A later break cannot re-enter this path.
    this.#settled = true;
    void this.#disconnectAndDispose();
  }

  #claimPublished(): boolean {
    if (this.#settled || !this.#published) return false;
    this.#settled = true;
    return true;
  }

  #disconnectAndDispose(): Promise<void> {
    if (!this.#disconnect) {
      this.#disconnect = Promise.resolve()
        .then(this.options.onDisconnect)
        .catch((cause: unknown) => {
          console.warn("App host disconnect callback failed", cause);
        })
        .finally(() => {
          this.#warned(
            this.options.dispose,
            "App host terminal cleanup failed",
          );
        });
    }
    return this.#disconnect;
  }

  #disposeAnd(after: (options: TerminalGateOptions) => void): void {
    try {
      this.#warned(this.options.dispose, "App host terminal cleanup failed");
    } finally {
      after(this.options);
    }
  }

  #warned(effect: () => void, message: string): void {
    try {
      effect();
    } catch (cause) {
      console.warn(message, cause);
    }
  }
}

export function createTerminalGate(options: TerminalGateOptions): TerminalGate {
  return new MountTerminal(options);
}
