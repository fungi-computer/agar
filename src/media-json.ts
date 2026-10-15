import { mediaRequestIds, mediaRequestIdSchema } from "./media-request-id.js";
import { AppError } from "./errors.js";
import {
  mediaModelSchema,
  mediaGenerationInputWireSchema,
  mediaGenerationSelectionSchema,
  mediaGenerationFailureSchema,
  mediaGenerationResultSchema,
  parseMediaGenerationInput,
  mediaGenerationReferenceSchema,
  type MediaGenerationHandle,
  type MediaGenerationAttemptHandle,
  type MediaGenerationReference,
  type MediaGenerationInput,
  type MediaGenerationOutcome,
  type MediaModel,
} from "./media.js";
import * as Schema from "effect/Schema";
import { pendingSchema, type Pending } from "./backend-definition.js";
import { RpcTarget as TransportRpcTarget } from "@fungi.computer/capnweb";

// Live RPC targets remain opaque in public declarations, as Agar host grants do.
const RpcTarget: new () => object = TransportRpcTarget;

export { mediaGenerationReferenceSchema } from "./media.js";

/** Page-local generic JSON method caller. Signals never enter JSON or RPC. */
export type MediaGenerationJsonCaller = (
  method: string,
  input?: Schema.Json,
  options?: { readonly signal?: AbortSignal },
) => Promise<Schema.Json | undefined>;

/** Plain JSON catalog reply, decoded with Agar's Media model grammar. */
export const mediaGenerationDescriptionSchema = Schema.Struct({
  /** Fixed Computer identity supplied by the host. */
  computerId: mediaGenerationReferenceSchema.fields.computerId,
  /** Whether the admitted host permits generation. */
  canGenerate: Schema.Boolean,
  /** Models supplied by the host catalog owner. */
  models: Schema.Array(mediaModelSchema),
});

/** A generation call carries paths and a replay ID; the host supplies authority. */
export const mediaGenerationJsonRequestSchema = Schema.Struct({
  /** Canonical replay identity reused for polling and restoration. */
  requestId: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter(
        (value) => mediaRequestIdSchema.safeParse(value).success,
      ),
    ),
  ),
  ...mediaGenerationInputWireSchema.fields,
  /** Agar-owned image and video selection, including path references. */
  settings: mediaGenerationSelectionSchema,
});

/** Plain JSON generation input for an admitted capability's generate method. */
export type MediaGenerationJsonRequest = Schema.Schema.Type<
  typeof mediaGenerationJsonRequestSchema
>;

/** A typed completion or refusal; no live attempt handles cross this boundary. */
export const mediaGenerationJsonOutcomeSchema = Schema.Union([
  Schema.Struct({
    /** Completed generation. */
    kind: Schema.Literal("succeeded"),
    /** Retained and saved host result. */
    result: mediaGenerationResultSchema,
  }),
  Schema.Struct({
    /** Refused or failed generation. */
    kind: Schema.Literal("failed"),
    /** Sanitized failure with truthful retry semantics. */
    failure: mediaGenerationFailureSchema,
  }),
]);

/** Generate may also report Agar's canonical, bounded Pending result. */
export const mediaGenerationJsonReplySchema = Schema.Union([
  mediaGenerationJsonOutcomeSchema,
  Schema.declare(
    (value): value is Pending => pendingSchema.safeParse(value).success,
  ),
]);

/** JSON generation reply, including the shared Pending owner. */
export type MediaGenerationJsonReply = Schema.Schema.Type<
  typeof mediaGenerationJsonReplySchema
>;

/** Catalog and permission snapshot for the handle's fixed Computer. */
export type MediaGenerationDescription = Readonly<{
  /** Fixed Computer identity. */
  computerId: string;
  /** Host-described permission to start generation. */
  canGenerate: boolean;
  /** The host's catalog, decoded with Agar's Media wire grammar. */
  models: readonly MediaModel[];
}>;

/** Page-side Agar handle over an admitted generic JSON method caller. */
export class MediaGeneration
  extends RpcTarget
  implements MediaGenerationHandle
{
  readonly #signal: AbortSignal | undefined;
  readonly #computerId: string;
  readonly #call: MediaGenerationJsonCaller;
  readonly #activeRequests = new Map<string, Set<AbortController>>();
  constructor(
    call: MediaGenerationJsonCaller,
    computerId: string,
    signal?: AbortSignal,
  ) {
    super();
    this.#computerId = computerId;
    this.#call = call;
    this.#signal = signal;
  }

  /** Describe this handle's fixed Computer through the admitted JSON method. */
  async describe(): Promise<MediaGenerationDescription> {
    const description = decodeJson(
      mediaGenerationDescriptionSchema,
      await this.#call("describe", undefined, {
        signal: accessSignal(this.#signal),
      }),
    );
    if (description.computerId !== this.#computerId)
      throw new AppError("Media generation unavailable", {
        code: "IDENTITY",
        retryable: false,
      });
    return description;
  }

  /** Issue a canonical replay identity for a new generation attempt. */
  createAttempt() {
    return Promise.resolve(
      this.#createAttempt(mediaRequestIds.request.generate()),
    );
  }

  /** Resume the original Computer and canonical request without issuing a new ID. */
  restoreAttempt(reference: MediaGenerationReference) {
    const parsed = Schema.decodeUnknownSync(mediaGenerationReferenceSchema)(
      reference,
    );
    const requestId = mediaRequestIds.request.parse(parsed.requestId);
    if (!requestId.ok || parsed.computerId !== this.#computerId)
      throw new AppError(
        "Media restore requires the original Computer and request",
        {
          code: "IDENTITY",
          retryable: false,
        },
      );
    return Promise.resolve(this.#createAttempt(requestId.value));
  }

  /** Abort every active browser request belonging to this attempt. */
  cancelAttempt(reference: MediaGenerationReference): Promise<void> {
    const parsed = Schema.decodeUnknownSync(mediaGenerationReferenceSchema)(
      reference,
    );
    const requestId = mediaRequestIds.request.parse(parsed.requestId);
    if (!requestId.ok || parsed.computerId !== this.#computerId)
      throw new AppError(
        "Media cancellation requires the original Computer and request",
        {
          code: "IDENTITY",
          retryable: false,
        },
      );
    for (const controller of this.#activeRequests.get(requestId.value) ?? [])
      controller.abort();
    return this.#call("cancelAttempt", parsed, {
      signal: accessSignal(this.#signal),
    }).then((value) => {
      decodeJson(Schema.Union([Schema.Null, Schema.Undefined]), value);
    });
  }

  #createAttempt(requestId: string): MediaGenerationAttempt {
    return new MediaGenerationAttempt(
      this.#call,
      this.#computerId,
      this.#signal,
      requestId,
      this.#activeRequests,
    );
  }
}

/** One replayable host-issued Media attempt, sharing cancellation with its handle. */
export class MediaGenerationAttempt
  extends RpcTarget
  implements MediaGenerationAttemptHandle
{
  readonly #computerId: string;
  readonly #signal: AbortSignal | undefined;
  readonly #requestId: string;
  readonly #call: MediaGenerationJsonCaller;
  readonly #activeRequests: Map<string, Set<AbortController>>;
  constructor(
    call: MediaGenerationJsonCaller,
    computerId: string,
    signal: AbortSignal | undefined,
    requestId: string,
    activeRequests: Map<string, Set<AbortController>>,
  ) {
    super();
    this.#computerId = computerId;
    this.#call = call;
    this.#signal = signal;
    this.#requestId = requestId;
    this.#activeRequests = activeRequests;
  }

  /** Return the stable Computer and request identity for replay. */
  reference(): Promise<MediaGenerationReference> {
    return Promise.resolve({
      requestId: this.#requestId,
      computerId: this.#computerId,
    });
  }

  /** Save through the admitted host; poll pending work with the same replay identity. */
  async generate(input: MediaGenerationInput): Promise<MediaGenerationOutcome> {
    const controller = new AbortController();
    let active = this.#activeRequests.get(this.#requestId);
    if (active === undefined) {
      active = new Set();
      this.#activeRequests.set(this.#requestId, active);
    }
    active.add(controller);
    const signal =
      this.#signal === undefined
        ? controller.signal
        : AbortSignal.any([this.#signal, controller.signal]);
    try {
      signal.throwIfAborted();
      const request = Schema.decodeUnknownSync(Schema.Json)(
        decodeJson(mediaGenerationJsonRequestSchema, {
          requestId: this.#requestId,
          ...parseMediaGenerationInput(input),
        }),
      );
      const post = async () => {
        signal.throwIfAborted();
        const reply = await this.#call("generate", request, { signal });
        signal.throwIfAborted();
        return decodeJson(mediaGenerationJsonReplySchema, reply);
      };
      let response = await post();
      const deadline = Date.now() + backgroundGenerationMs;
      while (response.kind === "pending" && Date.now() < deadline) {
        await abortableDelay(response.retryAfterMs, signal);
        response = await post();
      }
      if (response.kind === "pending")
        return {
          kind: "failed",
          failure: {
            message:
              "Media generation is still running; restore this request later to save it.",
            code: "HOST_FAILURE",
            retryable: true,
          },
        };
      return response;
    } finally {
      active.delete(controller);
      if (active.size === 0) this.#activeRequests.delete(this.#requestId);
    }
  }
}

/** How long the browser keeps checking one background (video) generation. */
const backgroundGenerationMs = 25 * 60_000;
function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Media generation was cancelled"),
        );
      },
      { once: true },
    );
  });
}

function decodeJson<T>(schema: Schema.Codec<T>, value: unknown): T {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(
      value,
    );
  } catch (cause) {
    throw new AppError("The Media JSON method returned malformed data", {
      cause,
      code: "PROTOCOL",
      retryable: false,
    });
  }
}

const idleAccessSignal = new AbortController().signal;
const accessSignal = (signal: AbortSignal | undefined): AbortSignal =>
  signal ?? idleAccessSignal;
