import * as z from "zod";
import { defineCapability } from "./capabilities.js";
import { parseJsonValue } from "@fungi.computer/whistle/wire";
import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
  rpcVoid,
} from "./internal/rpc-contract.js";
import type { CapabilityContract } from "./capabilities.js";
import type { WhistleJsonValue } from "@fungi.computer/whistle";

/** Invoke this App's admitted backend. The App defines its JSON request/result. */
export const appBackend: CapabilityContract<{
  /** Send one JSON-encoded request to this App's admitted backend and
   * resolve with its decoded JSON result; the App's own backend defines
   * what `input` must contain. */
  request(input: string): Promise<WhistleJsonValue>;
}> = defineCapability(
  "app.backend",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      request: rpcMethod(
        rpcDataSchema(z.unknown().transform((value) => parseJsonValue(value))),
      ),
    }),
  ),
);

/**
 * Call one of this App's declared, typed methods through its host. Unlike
 * `appBackend`, the host knows which method is called, so it can apply the
 * method's declared effect.
 */
export const appMethods: CapabilityContract<{
  /** Call the named method with JSON-encoded `input`; resolves with its JSON result. */
  call(method: string, input: string): Promise<WhistleJsonValue>;
}> = defineCapability(
  "app.methods",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      call: rpcMethod(
        rpcDataSchema(z.unknown().transform((value) => parseJsonValue(value))),
      ),
    }),
  ),
);

/** One host-held socket to this App's Region. The host keeps the socket and
 * its credentials; the App sees bounded text frames only. */
export type AppRegionConnection = Disposable & {
  /** The Region's frames to this connection; ends when either side closes. */
  messages(): Promise<ReadableStream<string>>;
  /** Send one bounded text frame to the Region. */
  send(data: string): Promise<void>;
  /** Close this connection; the host closes its socket. */
  close(): Promise<void>;
};

/** Connect to this App's Region through the admitting host. */
export const appRegion: CapabilityContract<{
  /** Open one admitted connection; every call is a fresh host admission. */
  connect(): Promise<AppRegionConnection>;
}> = defineCapability(
  "app.region",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      connect: rpcMethod(
        rpcHandleSchema({
          messages: rpcMethod(
            z.instanceof(ReadableStream).transform((stream) =>
              stream.pipeThrough(
                new TransformStream<unknown, string>({
                  transform(chunk, controller) {
                    controller.enqueue(z.string().parse(chunk));
                  },
                }),
              ),
            ),
          ),
          send: rpcVoid,
          close: rpcVoid,
        }),
      ),
    }),
  ),
);

export {
  appBackendRefusalSchema,
  appFailureReasons,
  appFailureWhereSchema,
  type AppFailureReason,
  type AppFailureWhere,
} from "./backend-refusal.js";
export {
  AppMethodRefusal,
  appMethodRefusalCodes,
  appMethodRefusalStatus,
  appMethodRefusedReplySchema,
  appMethodReplySchema,
  maxAppMethodRefusalMessage,
  type AppMethodRefusalCode,
  type AppMethodRefusedReply,
  type AppMethodReply,
} from "./method-refusal.js";
