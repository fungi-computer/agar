import type * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { AppError } from "../errors.js";
import {
  appErrorData,
  type AppErrorData,
  appErrorFromData,
} from "./app-error.js";

export type RpcResult<T> =
  | { readonly error: AppErrorData; readonly ok: false }
  | { readonly ok: true; readonly value: T };

type RpcResultOwner = { [Symbol.dispose]: () => void };

export const rpcSuccess = <T>(value: T): RpcResult<T> => ({ ok: true, value });

export const rpcFailure = <T = never>(cause: unknown): RpcResult<T> => ({
  error: appErrorData(cause),
  ok: false,
});

/**
 * Decodes one ordinary RPC response and releases its Cap'n Web result owner.
 * The bootstrap response is intentionally not passed here: it owns the live
 * capability handles retained by the published app root.
 */
export async function callRpc<T>(
  operation: PromiseLike<unknown>,
  parse: ReturnType<
    typeof Schema.decodeUnknownSync<Schema.Decoder<RpcResult<T>>>
  >,
): Promise<T> {
  let result: unknown;
  const disposed = new Set<RpcResultOwner>();
  try {
    result = await operation;
    return unwrapRpcResult(parse(result));
  } catch (cause) {
    if (isRpcResultOwner(cause)) disposeRpcResult(cause, disposed);
    if (cause instanceof AppError) throw cause;
    throw new AppError("The remote operation failed", {
      cause,
      code: "HOST_FAILURE",
      retryable: true,
    });
  } finally {
    if (result !== operation && isRpcResultOwner(result))
      disposeRpcResult(result, disposed);
  }
}

/**
 * Callers must first decode an unknown transport envelope with an
 * operation-specific schema. This function only exposes that trusted result.
 */
export function unwrapRpcResult<T>(result: RpcResult<T>): T {
  if (result.ok) return result.value;
  throw appErrorFromData(result.error);
}

function isRpcResultOwner<Value>(
  value: Value,
): value is Value & RpcResultOwner {
  return (
    Predicate.isObject(value) &&
    Symbol.dispose in value &&
    Predicate.isFunction(value[Symbol.dispose])
  );
}

function disposeRpcResult(
  value: RpcResultOwner,
  disposed: Set<RpcResultOwner>,
): void {
  if (disposed.has(value)) return;
  disposed.add(value);
  try {
    value[Symbol.dispose]();
  } catch (cause) {
    console.warn("RPC result disposal failed", cause);
  }
}
