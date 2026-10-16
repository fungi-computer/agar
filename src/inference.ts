import { defineCapability } from "./capabilities.js";
import {
  rpcFetchHandleSchema,
  rpcHandleSchema,
  rpcMethod,
} from "./internal/rpc-contract.js";
import * as z from "zod";
import * as Schema from "effect/Schema";
import type {
  CapabilityContract,
  CapabilityDirectory,
} from "./capabilities.js";
import { AppError } from "./errors.js";
import { reportCatchFailure } from "./failure.js";

/** One request lifetime. Closing it cancels only this generation, not other calls. */
export type AppInferenceRequest = {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  [Symbol.dispose](): void;
};

/** Live generation capability supplied by the host. */
export type AppInferenceHandle = {
  open(): Promise<AppInferenceRequest>;
};

export const llmGeneration: CapabilityContract<AppInferenceHandle> =
  defineCapability(
    "llm.generation",
    1,
    z.lazy(() => rpcHandleSchema({ open: rpcMethod(rpcFetchHandleSchema) })),
  );

const baseURL = "https://inference.fungi.invalid/v1";
const decodeResponse = Schema.decodeUnknownSync(Schema.instanceOf(Response));

/** OpenAI-compatible transport; no Agent, Session, host URL or credentials are exposed. */
export function createAppInferenceTransport(capabilities: CapabilityDirectory) {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== "https://inference.fungi.invalid" ||
      url.search !== "" ||
      !(
        (request.method === "GET" && url.pathname === "/v1/models") ||
        (request.method === "POST" && url.pathname === "/v1/chat/completions")
      )
    )
      throw new AppError("The inference request target is invalid", {
        code: "INVALID_ARGUMENT",
        retryable: false,
      });
    request.signal.throwIfAborted();
    let handle: AppInferenceRequest | undefined;
    let closed = false;
    let closing: Promise<void> | undefined;
    const close = () => {
      closed = true;
      if (closing !== undefined) return closing;
      request.signal.removeEventListener("abort", abort);
      const opened = handle;
      if (opened === undefined) return Promise.resolve();
      closing = (async () => {
        try {
          await opened.close();
        } finally {
          opened[Symbol.dispose]();
        }
      })();
      return closing;
    };
    // Cap'n Web carries Request/Response streams but not Request.signal. The
    // per-request object lifetime supplies cancellation across that boundary.
    let rejectAbort: (error: Error) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      void close().catch((cause: unknown) => {
        reportCatchFailure("inference.abort-close", cause);
      });
      rejectAbort(new DOMException("The operation was aborted", "AbortError"));
    };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      if (request.signal.aborted) abort();
      const opening = capabilities
        .require(llmGeneration)
        .open()
        .then(async (opened) => {
          handle = opened;
          if (closed) {
            await close();
            request.signal.throwIfAborted();
            throw new Error("Inference request is closed");
          }
          return opened;
        });
      const opened = await Promise.race([opening, aborted]);
      const response = decodeResponse(
        await Promise.race([opened.fetch(request), aborted]),
      );
      request.signal.throwIfAborted();
      if (response.body === null) {
        await close();
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const next = await Promise.race([reader.read(), aborted]);
              if (next.done) {
                controller.close();
                await close();
              } else controller.enqueue(next.value);
            } catch (error) {
              controller.error(
                request.signal.aborted ? request.signal.reason : error,
              );
              await close();
            }
          },
          async cancel(reason) {
            await Promise.all([reader.cancel(reason), close()]);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      await close().catch((cause: unknown) => {
        reportCatchFailure("inference.request-cleanup", cause);
      });
      request.signal.throwIfAborted();
      throw error;
    }
  };
  return { baseURL, fetch };
}
