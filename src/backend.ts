import * as z from "zod";
import { defineCapability } from "./capabilities.js";
import { parseJsonValue } from "@fungi.computer/whistle/wire";
import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
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
  rpcHandleSchema({
    request: rpcMethod(
      rpcDataSchema(z.unknown().transform((value) => parseJsonValue(value))),
    ),
  }),
);

/**
 * Call one of this App's declared, typed methods through its host. Unlike
 * `appBackend`, the host knows which method is called, so it can apply the
 * method's declared effect (for example, allow only `read` methods to a
 * visitor of a public App).
 */
export const appMethods: CapabilityContract<{
  /** Call the named method with JSON-encoded `input`; resolves with its JSON result. */
  call(method: string, input: string): Promise<WhistleJsonValue>;
}> = defineCapability(
  "app.methods",
  1,
  rpcHandleSchema({
    call: rpcMethod(
      rpcDataSchema(z.unknown().transform((value) => parseJsonValue(value))),
    ),
  }),
);

/** The admitting host overwrites this header from its authenticated principal.
 * App request bodies and incoming browser headers never supply this identity. */
export const appBackendActorHeader = "X-Agar-Actor-Id";

/** The admitting host overwrites this header with the Computer it has
 * verified the caller is admitted to use for this invocation, or omits it
 * when no Computer is bound to the call. App request bodies and incoming
 * browser headers never supply this identity: a backend that needs a
 * Computer scope must read it from here, never from its own request body. */
export const appBackendComputerHeader = "X-Agar-Computer-Id";

export { appBackendRefusalSchema } from "./backend-refusal.js";
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
