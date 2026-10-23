import * as z from "zod";
import { defineCapability } from "./capabilities.js";
import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
  rpcVoid,
} from "./internal/rpc-contract.js";
import * as Schema from "effect/Schema";
import { mediaProviderDiagnosticSchema } from "./internal/media-diagnostic.js";
import type { MediaProviderDiagnostic } from "./errors.js";

export {
  mediaLibraryRequestSchema,
  mediaLibraryPathSchema,
  mediaLibraryResponseSchema,
} from "./media-library.js";
import type {
  CapabilityContract,
  CapabilityDirectory,
} from "./capabilities.js";
import { AppError } from "./errors.js";
import { ownedRpcValue } from "./internal/capabilities.js";

/**
 * The Media owner decides Team, Installation, Release, Grant and Computer
 * authority before issuing this handle. The App contributes only generation
 * settings and selected destination/references. The IDs in those selections
 * are not authority: the host revalidates every one against its current
 * admitted Computer scope when it accepts a generation.
 *
 * The owner intentionally returns completed metadata. Operation state,
 * provider identifiers and billing records remain owner facts. The exposed
 * request reference identifies a replay; it grants no authority.
 */
export type MediaGenerationInput = Readonly<{
  destination: Readonly<{ path: string }>;
  settings: MediaGenerationSelection;
}>;

/** The encodings a completed generation can be saved as. */
export type MediaOutputFormat = "png" | "jpeg" | "gif" | "webp" | "mp4";

/** Metadata for one completed generation: the saved destination, pixel
 * dimensions, format, model used, and its cost. */
export type MediaGenerationResult = Readonly<{
  bytes: number;
  costMilliunits: number;
  destination: Readonly<{ computerId: string; path: string }>;
  format: MediaOutputFormat;
  height: number;
  model: string;
  width: number;
}>;

/** The host's typed reason a generation failed: code, message, retry truth
 * and, when known, the stage that failed. */
export type MediaGenerationFailure = Schema.Schema.Type<
  typeof mediaGenerationFailureSchema
>;

/** A decoded Media failure; null stage means the host could not identify it. */
export class MediaGenerationError extends AppError {
  readonly stage: NonNullable<MediaGenerationFailure["stage"]> | null;
  /** Bounded provider facts only; never the original provider cause. */
  readonly provider: MediaProviderDiagnostic | undefined;

  constructor(failure: MediaGenerationFailure) {
    super(failure.message, {
      code: failure.code,
      retryable: failure.retryable,
    });
    this.stage = failure.stage ?? null;
    this.provider = failure.provider;
  }
}

/** Transport-safe result from the host-owned generation attempt. */
export type MediaGenerationOutcome =
  | Readonly<{ kind: "succeeded"; result: MediaGenerationResult }>
  | Readonly<{ kind: "failed"; failure: MediaGenerationFailure }>;

/** Live object-capability shape supplied by the host. */
export type MediaGenerationHandle = {
  /** Fetch the Computer scope, available models, and whether generation
   * is currently allowed. */
  describe(): Promise<
    Partial<Disposable> & {
      readonly computerId: string;
      readonly canGenerate: boolean;
      readonly models: readonly MediaModel[];
    }
  >;
  /** Begin a new generation attempt on the host and return its handle. */
  createAttempt(): Promise<MediaGenerationAttemptHandle>;
  /** Resume a previously started attempt identified by its reference. */
  restoreAttempt(
    reference: MediaGenerationReference,
  ): Promise<MediaGenerationAttemptHandle>;
  /** Tell the host to stop an in-flight or pending attempt. */
  cancelAttempt(reference: MediaGenerationReference): Promise<void>;
};

/** Host-supplied object-capability for one attempt, before Agar wraps it
 * into the typed MediaGenerationAttempt. */
export type MediaGenerationAttemptHandle = Partial<Disposable> & {
  /** Fetch this attempt's replay reference from the host. */
  reference(): Promise<MediaGenerationReference & Partial<Disposable>>;
  /** Ask the host to run generation for this attempt with the given
   * input. */
  generate(
    input: MediaGenerationInput,
  ): Promise<MediaGenerationOutcome & Partial<Disposable>>;
};

/** One generation attempt: a stable reference plus the ability to run
 * (or retry) generation against it until disposed. */
export type MediaGenerationAttempt = Disposable & {
  readonly reference: MediaGenerationReference;
  /** Run generation for this attempt and return the saved result, or
   * throw MediaGenerationError on failure; an abort signal cancels it. */
  generate(
    input: MediaGenerationInput,
    options?: { readonly signal?: AbortSignal },
  ): Promise<MediaGenerationResult>;
};

/** The validated, App-facing handle returned by openMediaGeneration: the
 * Computer's model catalog plus the ability to start or resume
 * attempts. */
export type MediaGenerationSession = Readonly<{
  computerId: string;
  canGenerate: boolean;
  models: readonly MediaModel[];
  /** Start a fresh generation attempt scoped to this session's
   * Computer. */
  createAttempt(): Promise<MediaGenerationAttempt>;
  /** Resume an attempt from a reference returned earlier in this
   * session. */
  restoreAttempt(
    reference: MediaGenerationReference,
  ): Promise<MediaGenerationAttempt>;
}>;

/** One narrow Media capability: discover the retained catalog and generate. */

const text = (maximum: number) =>
  Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(maximum)),
  );
/** A replay identity, never an authorization capability. */
export const mediaGenerationReferenceSchema = Schema.Struct({
  requestId: text(256),
  computerId: text(256),
});
/** An opaque replay identity for one attempt; it identifies a request,
 * not an authorization to use it. */
export type MediaGenerationReference = Schema.Schema.Type<
  typeof mediaGenerationReferenceSchema
>;

const safeInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(
    Schema.makeFilter(Number.isSafeInteger, {
      message: "Expected a safe integer",
    }),
  ),
);
const positiveInteger = safeInteger.pipe(Schema.check(Schema.isGreaterThan(0)));
const nonNegativeInteger = safeInteger.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);

/** Video frame/reference role, interpreted by the host's model catalog. */
export const mediaVideoReferenceRoleSchema = Schema.Literals([
  "first-frame",
  "last-frame",
  "reference",
]);
/** One provider-independent frame/reference role. */
export type MediaVideoReferenceRole = Schema.Schema.Type<
  typeof mediaVideoReferenceRoleSchema
>;
/** A supported wire resolution. The host refines it against the chosen model. */
export const mediaVideoResolutionSchema = Schema.Literals([
  "480p",
  "720p",
  "768p",
  "1080p",
  "4k",
]);
/** Provider-independent resolution selector. */
export type MediaVideoResolution = Schema.Schema.Type<
  typeof mediaVideoResolutionSchema
>;
/** A supported wire aspect. The host refines it against the chosen model. */
export const mediaVideoAspectRatioSchema = Schema.Literals([
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "21:9",
  "9:21",
]);
/** Provider-independent requested aspect selector. */
export type MediaVideoAspectRatio = Schema.Schema.Type<
  typeof mediaVideoAspectRatioSchema
>;
const referenceSchema = Schema.Struct({
  path: text(4_096),
  role: Schema.optional(mediaVideoReferenceRoleSchema),
});
/** Path-only video reference. The host supplies Computer authority. */
export const mediaVideoReferenceSchema = Schema.Struct({
  /** Computer-relative image path. */
  path: text(4_096),
  /** First frame, last frame or reference-image mode. */
  role: mediaVideoReferenceRoleSchema,
});
/** One path-only video reference. */
export type MediaVideoReference = Schema.Schema.Type<
  typeof mediaVideoReferenceSchema
>;

const resultReferenceSchema = Schema.Struct({
  computerId: text(256),
  path: text(4_096),
});

const modelInputSchema = Schema.Struct({
  defaultHeight: positiveInteger,
  defaultSteps: Schema.NullOr(nonNegativeInteger),
  defaultWidth: positiveInteger,
  dimensions: Schema.Literals(["none", "own"]),
  maxDimension: Schema.NullOr(positiveInteger),
  maxReferences: nonNegativeInteger,
  maxSteps: Schema.NullOr(positiveInteger),
  referenceField: Schema.NullOr(text(256)),
  steps: Schema.Literals(["steps", "num_steps", "fixed"]),
  transport: Schema.Literals(["json", "multipart"]),
});

/** Host-described video capabilities and costs. This is wire grammar, not a catalog. */
export const mediaVideoModelSchema = Schema.Struct({
  /** Smallest duration; the durations list owns exact membership. */
  minSeconds: positiveInteger,
  /** Largest duration. */
  maxSeconds: positiveInteger,
  /** Default whole seconds. */
  defaultSeconds: positiveInteger,
  /** Exact admitted duration values. */
  durations: Schema.Array(positiveInteger),
  /** Provider translation family. */
  provider: Schema.Literals(["seedance", "veo", "minimax"]),
  /** Resolution/aspect selectors and nominal dimensions. */
  formats: Schema.Array(
    Schema.Struct({
      /** Provider resolution selector. */
      resolution: mediaVideoResolutionSchema,
      /** Requested aspect selector. */
      aspectRatio: mediaVideoAspectRatioSchema,
      /** Nominal width, not measured MP4 dimensions. */
      width: positiveInteger,
      /** Nominal height, not measured MP4 dimensions. */
      height: positiveInteger,
    }),
  ),
  /** Default resolution. */
  defaultResolution: mediaVideoResolutionSchema,
  /** Default requested aspect. */
  defaultAspectRatio: mediaVideoAspectRatioSchema,
  /** Audio default, or null when the provider default is undocumented. */
  defaultGenerateAudio: Schema.NullOr(Schema.Boolean),
  /** Host/provider prompt bound. */
  maxPromptLength: positiveInteger,
  /** Roles admitted by this model. */
  referenceRoles: Schema.Array(mediaVideoReferenceRoleSchema),
  /** Maximum images in reference-image mode. */
  maxReferenceImages: nonNegativeInteger,
  /** Resolutions admitting reference-image mode. */
  referenceResolutions: Schema.Array(mediaVideoResolutionSchema),
  /** Host-described costs, where 1 USD is 100,000 milliunits. */
  prices: Schema.Array(
    Schema.Struct({
      /** Billed provider resolution. */
      resolution: mediaVideoResolutionSchema,
      /** Provider milliunits per silent output second. */
      silentMilliunitsPerSecond: positiveInteger,
      /** Provider milliunits per output second with audio. */
      audioMilliunitsPerSecond: positiveInteger,
    }),
  ),
});
/** Immutable host-described video metadata. */
export type MediaVideoModel = Schema.Schema.Type<typeof mediaVideoModelSchema>;

/** Validates one model row of the host's Media catalog. */
export const mediaModelSchema = Schema.Struct({
  id: text(256),
  input: modelInputSchema,
  kind: Schema.Literals(["image", "video"]),
  label: text(512),
  tier: Schema.Literals(["draft", "balanced", "premium", "max"]),
  outputFormats: Schema.Array(Schema.Literals(["png", "jpeg", "webp"])).pipe(
    Schema.check(Schema.isMaxLength(3)),
  ),
  sizes: Schema.NullOr(
    Schema.Array(
      Schema.String.pipe(Schema.check(Schema.isPattern(/^\d+x\d+$/u))),
    ),
  ),
  video: Schema.NullOr(mediaVideoModelSchema),
});

/** One generation model as the host describes it: identity, tier, input
 * limits and supported output formats. The host owns the catalog. */
export type MediaModel = Schema.Schema.Type<typeof mediaModelSchema>;

const modelsSchema = Schema.Array(mediaModelSchema);
const descriptionSchema = Schema.Struct({
  [Symbol.dispose]: Schema.optional(Schema.Unknown),
  computerId: text(256),
  models: modelsSchema,
  canGenerate: Schema.Boolean,
});
/** The most reference images one generation request may name. */
export const MAX_MEDIA_REFERENCES = 4;

/**
 * Validates the shape of an App's generation settings. Model-specific limits
 * (sizes, steps, durations, reference counts) and defaults are the host's:
 * it checks the selection against its catalog when it accepts a generation.
 */
export const mediaGenerationSelectionSchema = Schema.Struct({
  model: text(256),
  prompt: text(2_048),
  width: positiveInteger.pipe(Schema.check(Schema.isLessThanOrEqualTo(5_040))),
  height: positiveInteger.pipe(Schema.check(Schema.isLessThanOrEqualTo(5_040))),
  steps: Schema.optional(positiveInteger),
  durationSeconds: Schema.optional(positiveInteger),
  resolution: Schema.optional(mediaVideoResolutionSchema),
  aspectRatio: Schema.optional(mediaVideoAspectRatioSchema),
  generateAudio: Schema.optional(Schema.Boolean),
  references: Schema.optional(
    Schema.Array(referenceSchema).pipe(
      Schema.check(Schema.isMaxLength(MAX_MEDIA_REFERENCES)),
    ),
  ),
});
/** An App's generation settings: model, prompt, size and optional steps,
 * duration and Computer-relative reference paths. */
export type MediaGenerationSelection = Schema.Schema.Type<
  typeof mediaGenerationSelectionSchema
>;

/** Path-only video selection. Model defaults and combination refinements remain host-owned. */
export const mediaVideoSelectionSchema = Schema.Struct({
  /** Host catalog model identifier. */
  model: text(256),
  /** Host-bounded prompt. */
  prompt: text(2_048),
  /** Optional provider resolution selector. */
  resolution: Schema.optional(mediaVideoResolutionSchema),
  /** Optional requested aspect selector. */
  aspectRatio: Schema.optional(mediaVideoAspectRatioSchema),
  /** Whole seconds, 4 through 15; the host checks exact model membership. */
  durationSeconds: Schema.optional(
    positiveInteger.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(4)),
      Schema.check(Schema.isLessThanOrEqualTo(15)),
    ),
  ),
  /** Explicit audio choice. The host owns omitted defaults. */
  generateAudio: Schema.optional(Schema.Boolean),
  /** At most four paths with explicit frame/reference roles. */
  references: Schema.optional(
    Schema.Array(mediaVideoReferenceSchema).pipe(
      Schema.check(Schema.isMaxLength(MAX_MEDIA_REFERENCES)),
    ),
  ),
});
/** App-selected video parameters without host authority or output-path claims. */
export type MediaVideoSelection = Schema.Schema.Type<
  typeof mediaVideoSelectionSchema
>;

/** Public diagnostic stages a host may name when a generation fails. */
export const mediaFailureStages = [
  "admission",
  "generation-authorization",
  "settings",
  "estimate",
  "billing",
  "operation",
  "provider",
  "normalization",
  "artifact",
  "destination-authorization",
  "destination-write",
] as const;

/** Validates a generation input envelope; settings are parsed separately. */
export const mediaGenerationInputWireSchema = Schema.Struct({
  destination: Schema.Struct({ path: text(4_096) }),
  settings: Schema.Unknown,
});

/** Completed image or video metadata saved to a host-admitted destination. */
export const mediaGenerationResultSchema = Schema.Struct({
  // Cap'n Web decorates returned object envelopes with a disposal owner.
  [Symbol.dispose]: Schema.optional(Schema.Unknown),
  bytes: positiveInteger,
  costMilliunits: nonNegativeInteger,
  destination: resultReferenceSchema,
  format: Schema.Literals(["png", "jpeg", "gif", "webp", "mp4"]),
  height: positiveInteger,
  model: text(256),
  width: positiveInteger,
});
/** Completed native MEDIA video result, with a host-admitted destination. */
export const mediaVideoResultSchema = Schema.Struct({
  ...mediaGenerationResultSchema.fields,
  /** Bounded fetched video encoding. */
  format: Schema.Literal("mp4"),
});
/** Completed video metadata. */
export type MediaVideoResult = Schema.Schema.Type<
  typeof mediaVideoResultSchema
>;
/** Validates the typed failure a host reports for a generation attempt. */
export const mediaGenerationFailureSchema = Schema.Struct({
  message: text(512),
  stage: Schema.optional(Schema.Literals(mediaFailureStages)),
  /** Safe provider facts decoded by the one canonical Media grammar. */
  provider: Schema.optional(mediaProviderDiagnosticSchema),
  code: Schema.Literals([
    "CANCELLED",
    "CAPABILITY_DENIED",
    "CAPABILITY_REVOKED",
    "DISCONNECTED",
    "HOST_FAILURE",
    "IDENTITY",
    "INSUFFICIENT_CREDIT",
    "INVALID_ARGUMENT",
    "PROTOCOL",
    "SAFETY_FILTER_REFUSED",
    "TIMEOUT",
  ]),
  retryable: Schema.Boolean,
});
const outcomeSchema = Schema.Union([
  Schema.Struct({
    [Symbol.dispose]: Schema.optional(Schema.Unknown),
    kind: Schema.Literal("succeeded"),
    result: mediaGenerationResultSchema,
  }),
  Schema.Struct({
    [Symbol.dispose]: Schema.optional(Schema.Unknown),
    kind: Schema.Literal("failed"),
    failure: mediaGenerationFailureSchema,
  }),
]);

const mediaAttemptHandleSchema = rpcHandleSchema({
  reference: rpcMethod(
    rpcDataSchema(
      z
        .unknown()
        .transform((value) =>
          Schema.decodeUnknownSync(mediaGenerationReferenceSchema)(value),
        ),
    ),
  ),
  generate: rpcMethod(
    rpcDataSchema(
      z.unknown().transform((value) => {
        const outcome = Schema.decodeUnknownSync(outcomeSchema, {
          onExcessProperty: "error",
        })(value);
        return outcome.kind === "succeeded"
          ? {
              kind: outcome.kind,
              result: {
                bytes: outcome.result.bytes,
                costMilliunits: outcome.result.costMilliunits,
                destination: outcome.result.destination,
                format: outcome.result.format,
                height: outcome.result.height,
                model: outcome.result.model,
                width: outcome.result.width,
              },
            }
          : { kind: outcome.kind, failure: outcome.failure };
      }),
    ),
  ),
});

/** Capability contract for generating Media (images or video). Apps
 * declare it to request access; openMediaGeneration uses it to obtain
 * the host's handle. */
export const mediaGeneration: CapabilityContract<MediaGenerationHandle> =
  defineCapability(
    "media.generation",
    5,
    z.lazy(() =>
      rpcHandleSchema({
        describe: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => {
              const { computerId, canGenerate, models } =
                Schema.decodeUnknownSync(descriptionSchema, {
                  onExcessProperty: "error",
                })(value);
              return { computerId, canGenerate, models };
            }),
          ),
        ),
        createAttempt: rpcMethod(mediaAttemptHandleSchema),
        restoreAttempt: rpcMethod(mediaAttemptHandleSchema),
        cancelAttempt: rpcVoid,
      }),
    ),
  );

/** Parse a value received from the host and turn schema failures into the
 * transport-safe Agar error used by the other capability helpers. */
function decode<T>(schema: Schema.Codec<T>, value: T): T {
  try {
    return Schema.decodeUnknownSync(schema, {
      onExcessProperty: "error",
    })(value);
  } catch (cause) {
    throw new AppError("The Media capability returned malformed data", {
      cause,
      code: "PROTOCOL",
      retryable: false,
    });
  }
}

function capabilityFailure(cause: unknown): AppError {
  if (cause instanceof AppError) return cause;
  return new AppError("The Media capability failed", {
    cause,
    code: "HOST_FAILURE",
    retryable: true,
  });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new AppError("Media generation was cancelled", {
    code: "CANCELLED",
    retryable: false,
  });
}

/** Decode and normalize a typed input envelope; storage parses the envelope first. */
export function parseMediaGenerationInput(
  input: Schema.Schema.Type<typeof mediaGenerationInputWireSchema>,
): MediaGenerationInput {
  let parsed: Schema.Schema.Type<typeof mediaGenerationInputWireSchema>;
  try {
    parsed = Schema.decodeUnknownSync(mediaGenerationInputWireSchema, {
      onExcessProperty: "error",
    })(input);
  } catch (cause) {
    throw new AppError("Media generation input is invalid", {
      cause,
      code: "INVALID_ARGUMENT",
      retryable: false,
    });
  }

  let settings: MediaGenerationSelection;
  try {
    settings = normalizeSelection(
      Schema.decodeUnknownSync(mediaGenerationSelectionSchema, {
        onExcessProperty: "error",
      })(parsed.settings),
    );
  } catch (cause) {
    throw new AppError("Media generation settings are invalid", {
      cause,
      code: "INVALID_ARGUMENT",
      retryable: false,
    });
  }
  const destination = { path: parsed.destination.path.trim() };
  if (destination.path.length === 0)
    throw new AppError("Media generation destination is invalid", {
      code: "INVALID_ARGUMENT",
      retryable: false,
    });
  return Object.freeze({
    destination: Object.freeze(destination),
    settings,
  });
}

/** A selection being assembled before it is frozen. */
type SelectionDraft = {
  -readonly [K in keyof MediaGenerationSelection]: MediaGenerationSelection[K];
};

/** Trim the text fields the host compares; blank text is invalid. */
function normalizeSelection(
  selection: MediaGenerationSelection,
): MediaGenerationSelection {
  const trimmed = (value: string, name: string) => {
    const result = value.trim();
    if (result.length === 0) throw new Error(`${name} must not be blank`);
    return result;
  };
  const normalized: SelectionDraft = {
    model: trimmed(selection.model, "model"),
    prompt: trimmed(selection.prompt, "prompt"),
    width: selection.width,
    height: selection.height,
  };
  if (selection.steps !== undefined) normalized.steps = selection.steps;
  if (selection.durationSeconds !== undefined)
    normalized.durationSeconds = selection.durationSeconds;
  if (selection.resolution !== undefined)
    normalized.resolution = selection.resolution;
  if (selection.aspectRatio !== undefined)
    normalized.aspectRatio = selection.aspectRatio;
  if (selection.generateAudio !== undefined)
    normalized.generateAudio = selection.generateAudio;
  if (selection.references !== undefined)
    normalized.references = Object.freeze(
      selection.references.map((reference) =>
        Object.freeze({
          ...reference,
          path: trimmed(reference.path, "reference"),
        }),
      ),
    );
  return Object.freeze(normalized);
}

/** The host owns the catalog; Agar checks only its shape and identity. */
function parseModels(value: readonly MediaModel[]): readonly MediaModel[] {
  const models = decode(modelsSchema, value);
  const seen = new Set<string>();
  for (const model of models) {
    if (seen.has(model.id))
      throw new AppError("The Media capability repeated a model", {
        code: "PROTOCOL",
        retryable: false,
      });
    seen.add(model.id);
  }
  return Object.freeze(models.map((model) => Object.freeze(model)));
}

function parseResult(
  value: MediaGenerationResult,
  request: MediaGenerationInput,
  computerId: string,
): MediaGenerationResult {
  const result = decode(mediaGenerationResultSchema, value);
  if (
    result.model !== request.settings.model ||
    result.destination.computerId !== computerId ||
    result.destination.path !== request.destination.path ||
    result.width !== request.settings.width ||
    result.height !== request.settings.height
  )
    throw new AppError("The Media capability returned an unrelated result", {
      code: "PROTOCOL",
      retryable: false,
    });
  return Object.freeze({
    bytes: result.bytes,
    costMilliunits: result.costMilliunits,
    destination: Object.freeze({ ...result.destination }),
    format: result.format,
    height: result.height,
    model: result.model,
    width: result.width,
  });
}

/** Discover the exact retained model catalog surfaced by the owner. */
export async function openMediaGeneration(
  capabilities: CapabilityDirectory,
): Promise<MediaGenerationSession> {
  try {
    const handle = capabilities.require(mediaGeneration);
    {
      using response = ownedRpcValue(await handle.describe());
      const description = decode(descriptionSchema, response.value);
      const computerId = description.computerId.trim();
      if (computerId.length === 0)
        throw new AppError("The Media capability returned no Computer", {
          code: "PROTOCOL",
          retryable: false,
        });
      const models = parseModels(description.models);
      const wrapAttempt = async (
        remote: MediaGenerationAttemptHandle,
      ): Promise<MediaGenerationAttempt> => {
        const owner = ownedRpcValue(remote);
        let reference: MediaGenerationReference;
        try {
          {
            using response = ownedRpcValue(await remote.reference());
            const parsed = decode(
              Schema.Struct({
                ...mediaGenerationReferenceSchema.fields,
                [Symbol.dispose]: Schema.optional(Schema.Unknown),
              }),
              response.value,
            );
            reference = {
              requestId: parsed.requestId,
              computerId: parsed.computerId,
            };
            if (reference.computerId !== computerId)
              throw new AppError("Media attempt belongs to another Computer", {
                code: "IDENTITY",
                retryable: false,
              });
          }
        } catch (cause) {
          owner[Symbol.dispose]();
          throw capabilityFailure(cause);
        }
        let disposed = false;
        return {
          reference: Object.freeze(reference),
          async generate(input, options = {}) {
            if (disposed)
              throw new AppError("Media generation attempt is closed", {
                code: "CAPABILITY_DENIED",
                retryable: false,
              });
            throwIfCancelled(options.signal);
            const request = parseMediaGenerationInput(input);
            const signal = options.signal;
            let onAbort: (() => void) | undefined;
            let cancellation: Promise<void> | undefined;
            const requestCancellation = () => {
              cancellation ??= handle.cancelAttempt(reference);
              return cancellation;
            };
            try {
              const generation = remote.generate(request);
              const response =
                signal === undefined
                  ? await generation
                  : await Promise.race([
                      generation,
                      new Promise<never>((_resolve, reject) => {
                        onAbort = () => {
                          void requestCancellation().then(() => {
                            reject(
                              new AppError("Media generation was cancelled", {
                                code: "CANCELLED",
                                retryable: false,
                              }),
                            );
                          }, reject);
                        };
                        signal.addEventListener("abort", onAbort, {
                          once: true,
                        });
                        if (signal.aborted) onAbort();
                      }),
                    ]);
              if (signal?.aborted) {
                await requestCancellation();
                throwIfCancelled(signal);
              }
              throwIfCancelled(signal);
              {
                using owned = ownedRpcValue(response);
                const outcome = decode(outcomeSchema, owned.value);
                if (outcome.kind === "failed")
                  throw new MediaGenerationError(outcome.failure);
                return parseResult(outcome.result, request, computerId);
              }
            } catch (cause) {
              if (signal?.aborted) {
                await requestCancellation();
                throwIfCancelled(signal);
              }
              throw capabilityFailure(cause);
            } finally {
              if (onAbort !== undefined)
                signal?.removeEventListener("abort", onAbort);
            }
          },
          [Symbol.dispose]() {
            if (disposed) return;
            disposed = true;
            owner[Symbol.dispose]();
          },
        };
      };
      return Object.freeze({
        computerId,
        canGenerate: description.canGenerate,
        models,
        /** Start a fresh attempt scoped to this session's Computer. */
        async createAttempt() {
          return wrapAttempt(await handle.createAttempt());
        },
        /** Resume an attempt using a reference returned earlier in this
         * session; the reference must match this session's Computer. */
        async restoreAttempt(reference: MediaGenerationReference) {
          const parsed = decode(mediaGenerationReferenceSchema, reference);
          if (parsed.computerId !== computerId)
            throw new AppError(
              "Select the original Computer to retry this generation",
              {
                code: "IDENTITY",
                retryable: false,
              },
            );
          const attempt = await wrapAttempt(
            await handle.restoreAttempt(parsed),
          );
          if (attempt.reference.requestId !== parsed.requestId) {
            attempt[Symbol.dispose]();
            throw new AppError("Media restore changed the request identity", {
              code: "PROTOCOL",
              retryable: false,
            });
          }
          return attempt;
        },
      });
    }
  } catch (cause) {
    throw capabilityFailure(cause);
  }
}
