import { disposeRpcValue } from "./internal/capabilities.js";
import * as Schema from "effect/Schema";
import { reportCatchFailure } from "./failure.js";
import { AppError } from "./errors.js";

const decodeTooLarge = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Literal("too_large") })),
);

/** A parent-owned read. Closing it aborts the parent HTTP operation. */
export type AppFileRead = Disposable & {
  /** Resolve with the underlying Response once it is available. */
  response(): Promise<Response>;
  /** Release the parent's open read, aborting it if still in flight. */
  close(): Promise<void>;
};

/** Native Response crosses RPC; File is constructed only in the receiving App. */
export async function readAppFile(
  read: AppFileRead,
  options: { name: string; signal?: AbortSignal },
): Promise<File> {
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= read.close());
  const abort = () => {
    // The finalizer awaits this same close; the event callback cannot await it.
    void close().catch((cause: unknown) => {
      reportCatchFailure("files.read.abort-close", cause);
    });
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    const result = await read.response();
    try {
      const response = Schema.decodeUnknownSync(Schema.instanceOf(Response))(
        result,
      );
      if (response.status === 413) {
        const failure = decodeTooLarge(await response.text());
        throw new AppError("App file exceeds the read bound", {
          code: failure._tag === "Some" ? "FILE_TOO_LARGE" : "PROTOCOL",
          retryable: false,
        });
      }
      if (!response.ok)
        throw new Error(`App file unavailable (${String(response.status)})`);
      const blob = await response.blob();
      options.signal?.throwIfAborted();
      return new File([blob], options.name, {
        type: blob.type,
        lastModified: 0,
      });
    } finally {
      disposeRpcValue(result);
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    try {
      await close();
    } finally {
      read[Symbol.dispose]();
    }
  }
}

/** A parent-owned upload; close requests transport abort, never promises rollback. */
export type AppFileWrite = Disposable & {
  /** Stream the upload's content to the parent-owned destination. */
  write(content: ReadableStream<Uint8Array>): Promise<void>;
  /** Request that the parent abort or finalize the upload transport. */
  close(): Promise<void>;
};

/** Stream a Blob's bytes to a parent-owned upload. Aborting `signal` closes
 * the upload early; a close failure after a successful write is reported,
 * never thrown, since it cannot change an already-acknowledged commit. */
export async function writeAppFile(
  write: AppFileWrite,
  content: Blob,
  options: { signal?: AbortSignal },
): Promise<void> {
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= write.close());
  const abort = () => {
    void close().catch((cause: unknown) => {
      reportCatchFailure("files.write.abort-close", cause);
    });
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    await write.write(content.stream());
  } finally {
    options.signal?.removeEventListener("abort", abort);
    // Cleanup cannot change an acknowledged commit or replace the primary write error.
    try {
      await close();
    } catch (cause) {
      reportCatchFailure("files.write.remote-close", cause);
    }
    try {
      write[Symbol.dispose]();
    } catch (cause) {
      reportCatchFailure("files.write.local-dispose", cause);
    }
  }
}
