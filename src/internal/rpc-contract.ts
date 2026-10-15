import * as z from "zod";
import { AppError } from "../errors.js";
import { disposeRpcValue } from "./capabilities.js";

/** Cap'n Web stubs are callable proxies, not records. Select only owner methods
 * and bind their receiver before the maintained function schemas wrap them. */
export function rpcHandleSchema<S extends z.ZodRawShape>(methods: S) {
  const methodsSchema = z.object(methods);
  const receiverSchema = z.instanceof(Object);
  const receivedMethodsSchema = z.object(
    Object.fromEntries(
      Object.keys(methods).map((name) => [name, z.unknown().optional()]),
    ),
  );
  return z.unknown().transform((value) => {
    const receiver = receiverSchema.parse(value);
    // A record view lets the object parser read a callable native stub without
    // enumerating, copying or changing that stub. Methods retain its receiver.
    const view: unknown = Object.create(receiver);
    const received = receivedMethodsSchema.parse(view);
    const boundMethods = Object.fromEntries(
      Object.entries(received).map(([name, method]) => [
        name,
        z.function().parse(method).bind(receiver),
      ]),
    );
    return {
      ...methodsSchema.parse(boundMethods),
      /** Release the underlying RPC stub; call once the handle is done with. */
      [Symbol.dispose]() {
        disposeRpcValue(value);
      },
    };
  });
}

/** Copy an owned data result through its domain decoder, then release the RPC
 * envelope. Live resources use their own handle schemas instead. */
export function rpcDataSchema<T>(result: z.ZodType<T>) {
  return z.unknown().transform((value) => {
    try {
      return result.parse(value);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("The capability returned malformed data", {
        cause,
        code: "PROTOCOL",
        retryable: false,
      });
    } finally {
      disposeRpcValue(value);
    }
  });
}

/** Wrap an RPC method's result schema into a Zod function schema: the
 * decoded value resolves on success, and a malformed result is rethrown
 * as a PROTOCOL AppError after releasing the raw RPC envelope. */
export function rpcMethod<T>(result: z.ZodType<T>) {
  return z.function({
    output: z.promise(
      z.unknown().transform((value) => {
        try {
          return result.parse(value);
        } catch (cause) {
          disposeRpcValue(value);
          if (cause instanceof AppError) throw cause;
          throw new AppError("The capability returned a malformed result", {
            cause,
            code: "PROTOCOL",
            retryable: false,
          });
        }
      }),
    ),
  });
}

/** A method that decodes and releases an empty RPC result. */
export const rpcVoid = rpcMethod(rpcDataSchema(z.void()));

/** A per-request Fetch capability keeps Response bodies live until consumed. */
export const rpcFetchHandleSchema = rpcHandleSchema({
  fetch: rpcMethod(z.instanceof(Response)),
  close: rpcVoid,
});
