import { defineCapability } from "./capabilities.js";
import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
  rpcVoid,
} from "./internal/rpc-contract.js";
import * as z from "zod";
import * as Schema from "effect/Schema";
import type {
  CapabilityContract,
  CapabilityDirectory,
} from "./capabilities.js";
import {
  readAppFile,
  writeAppFile,
  type AppFileRead,
  type AppFileWrite,
} from "./files.js";
import { reportCatchFailure } from "./failure.js";
import { AppError } from "./errors.js";

export const computerListingSchema = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.Literals(["file", "directory", "symlink"]),
      size: Schema.Number,
      modifiedAt: Schema.Number,
    }),
  ),
  nextOffset: Schema.NullOr(Schema.Number),
});

export type ComputerListing = Schema.Schema.Type<typeof computerListingSchema>;

export const computerList: CapabilityContract<{
  list(input: {
    path: string;
    limit: number;
    offset: number;
  }): Promise<ComputerListing>;
}> = defineCapability(
  "computer.list",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      list: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerListingSchema)(value),
            ),
        ),
      ),
    }),
  ),
);

export const computerRuntimeStateSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literals(["running", "sleeping", "starting"]),
  }),
  Schema.Struct({
    state: Schema.Literal("queued"),
    position: Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThan(0)),
    ),
  }),
]);
export type ComputerRuntimeState = Schema.Schema.Type<
  typeof computerRuntimeStateSchema
>;

export const computerInternetAccessSchema = Schema.Struct({
  enabled: Schema.Boolean,
  effective: Schema.Boolean,
  blockedBy: Schema.NullOr(Schema.Literals(["team", "global"])),
});
export type ComputerInternetAccess = Schema.Schema.Type<
  typeof computerInternetAccessSchema
>;

export const computerInstrumentSnapshotSchema = Schema.Struct({
  computerId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  runtime: computerRuntimeStateSchema,
  backends: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      kind: Schema.Literals(["platform-container", "on-box-vm", "local"]),
      status: Schema.Literals(["ready", "queued", "online", "offline"]),
      queuePosition: Schema.NullOr(
        Schema.Number.pipe(
          Schema.check(Schema.isInt()),
          Schema.check(Schema.isGreaterThan(0)),
        ),
      ),
      hostId: Schema.NullOr(Schema.String),
      hostLabel: Schema.NullOr(Schema.String),
      folderLabel: Schema.NullOr(Schema.String),
      detachable: Schema.Boolean,
    }),
  ),
  internet: computerInternetAccessSchema,
});
export type ComputerInstrumentSnapshot = Schema.Schema.Type<
  typeof computerInstrumentSnapshotSchema
>;

export const computerInstrumentRead: CapabilityContract<{
  read(): Promise<ComputerInstrumentSnapshot>;
}> = defineCapability(
  "computer.instrument.read",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      read: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerInstrumentSnapshotSchema)(value),
            ),
        ),
      ),
    }),
  ),
);

export const computerInstrumentControl: CapabilityContract<{
  start(): Promise<ComputerRuntimeState>;
  setInternetAccess(enabled: boolean): Promise<ComputerInternetAccess>;
  detachLocal(backendId: string): Promise<{ detached: boolean }>;
}> = defineCapability(
  "computer.instrument.control",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      start: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerRuntimeStateSchema)(value),
            ),
        ),
      ),
      setInternetAccess: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerInternetAccessSchema)(value),
            ),
        ),
      ),
      detachLocal: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(
                Schema.Struct({ detached: Schema.Boolean }),
              )(value),
            ),
        ),
      ),
    }),
  ),
);

export async function readComputerInstrument(
  capabilities: CapabilityDirectory,
): Promise<ComputerInstrumentSnapshot> {
  return Schema.decodeUnknownSync(computerInstrumentSnapshotSchema)(
    await capabilities.require(computerInstrumentRead).read(),
  );
}

export async function startInstrumentComputer(
  capabilities: CapabilityDirectory,
): Promise<ComputerRuntimeState> {
  return Schema.decodeUnknownSync(computerRuntimeStateSchema)(
    await capabilities.require(computerInstrumentControl).start(),
  );
}

export async function setInstrumentInternetAccess(
  capabilities: CapabilityDirectory,
  enabled: boolean,
): Promise<ComputerInternetAccess> {
  return Schema.decodeUnknownSync(computerInternetAccessSchema)(
    await capabilities
      .require(computerInstrumentControl)
      .setInternetAccess(enabled),
  );
}

export async function detachInstrumentLocalBackend(
  capabilities: CapabilityDirectory,
  backendId: string,
): Promise<{ detached: boolean }> {
  return Schema.decodeUnknownSync(Schema.Struct({ detached: Schema.Boolean }))(
    await capabilities
      .require(computerInstrumentControl)
      .detachLocal(backendId),
  );
}

export const computerPortsSchema = Schema.Struct({
  ports: Schema.Array(
    Schema.Struct({
      port: Schema.Number.pipe(
        Schema.check(Schema.isInt()),
        Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      ),
      previewUrl: Schema.NonEmptyString,
      /** Host-selected display mode; this metadata does not grant preview access. */
      openMode: Schema.Literals(["inline", "external-only"]),
      expiresAt: Schema.Number.pipe(
        Schema.check(Schema.isInt()),
        Schema.check(Schema.isGreaterThan(0)),
      ),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(64))),
});

export type ComputerPorts = Schema.Schema.Type<typeof computerPortsSchema>;
export const computerPortsResultSchema = Schema.Union([
  computerPortsSchema,
  Schema.Struct({ error: Schema.Literal("port_previews_not_configured") }),
]);
export type ComputerPortsResult = Schema.Schema.Type<
  typeof computerPortsResultSchema
>;

export type ComputerPortExposure = Readonly<{
  port: number;
  exposed: boolean;
}>;
export type ComputerPortRemoval = Readonly<{ port: number; removed: boolean }>;

export const computerPortExposureSchema = Schema.Struct({
  port: Schema.Number.annotate({
    message: "Use a port from 1 to 65535.",
  }).check(
    Schema.isInt({ message: "Use a port from 1 to 65535." }),
    Schema.isBetween(
      { minimum: 1, maximum: 65_535 },
      { message: "Use a port from 1 to 65535." },
    ),
  ),
  exposed: Schema.Boolean,
});
export const computerPortRemovalSchema = Schema.Struct({
  port: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  ),
  removed: Schema.Boolean,
});

/** The selected Computer's admitted preview URLs and port mutations. */
export const computerPorts: CapabilityContract<{
  list(): Promise<ComputerPortsResult>;
  expose(port: number): Promise<ComputerPortExposure>;
  unexpose(port: number): Promise<ComputerPortRemoval>;
}> = defineCapability(
  "computer.ports",
  2,
  z.lazy(() =>
    rpcHandleSchema({
      list: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerPortsResultSchema)(value),
            ),
        ),
      ),
      expose: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerPortExposureSchema)(value),
            ),
        ),
      ),
      unexpose: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerPortRemovalSchema)(value),
            ),
        ),
      ),
    }),
  ),
);

/** Decode exposed ports at the SDK boundary. */
export async function listComputerPorts(
  capabilities: CapabilityDirectory,
): Promise<ComputerPortsResult> {
  const result = Schema.decodeUnknownSync(computerPortsResultSchema)(
    await capabilities.require(computerPorts).list(),
  );
  if ("error" in result) return result;
  for (const { previewUrl, expiresAt } of result.ports) {
    const url = new URL(previewUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      expiresAt <= Date.now()
    )
      throw new Error("Computer preview URL is invalid");
  }
  return result;
}

/** Expose one port on the selected Computer under its App admission. */
export async function exposeComputerPort(
  capabilities: CapabilityDirectory,
  port: number,
): Promise<ComputerPortExposure> {
  return Schema.decodeUnknownSync(computerPortExposureSchema)(
    await capabilities.require(computerPorts).expose(port),
  );
}

/** Remove one exposed port from the selected Computer. */
export async function unexposeComputerPort(
  capabilities: CapabilityDirectory,
  port: number,
): Promise<ComputerPortRemoval> {
  return Schema.decodeUnknownSync(computerPortRemovalSchema)(
    await capabilities.require(computerPorts).unexpose(port),
  );
}

/**
 * `synced`: the exact observation that recorded this exit also confirmed
 * computerd's post-command pull landed. `pending`: that observation saw
 * the pull fail, or gave up waiting for it. `unknown`: this exit was
 * recorded with no pull evidence at all.
 */
export const computerProcessSyncSchema = Schema.Literals([
  "synced",
  "pending",
  "unknown",
]);

/** A process owned by the selected Computer's durable process inventory. */
export const computerProcessSchema = Schema.Struct({
  port: Schema.NullOr(computerPortExposureSchema.fields.port),
  id: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  cwd: Schema.NullOr(Schema.String),
  startedAt: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  state: Schema.Literals(["running", "exited", "uncertain"]),
  exitCode: Schema.NullOr(Schema.Number.pipe(Schema.check(Schema.isInt()))),
  sync: computerProcessSyncSchema,
  endedAt: Schema.NullOr(
    Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
});

export const computerProcessesSchema = Schema.Struct({
  processes: Schema.Array(computerProcessSchema),
});
export const computerProcessKillSchema = Schema.Struct({
  process: computerProcessSchema,
  signalled: Schema.Boolean,
});

export type ComputerProcess = Schema.Schema.Type<typeof computerProcessSchema>;
export type ComputerProcessSync = Schema.Schema.Type<
  typeof computerProcessSyncSchema
>;
export type ComputerProcesses = Schema.Schema.Type<
  typeof computerProcessesSchema
>;

/** Stable UI request identity is distinct from the host-only native scope. */
export const computerProcessStartSchema = Schema.Struct({
  requestId: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256))),
  command: Schema.NonEmptyString.pipe(
    Schema.check(Schema.isMaxLength(16 * 1024)),
  ),
  cwd: Schema.optionalKey(Schema.String),
  port: Schema.optionalKey(computerPortExposureSchema.fields.port),
});
export type ComputerProcessStart = Schema.Schema.Type<
  typeof computerProcessStartSchema
>;

/** Read the authoritative process inventory from the selected Computer. */
export const computerProcesses: CapabilityContract<{
  start(input: ComputerProcessStart): Promise<ComputerProcess>;
  list(): Promise<ComputerProcesses>;
  kill(
    id: string,
  ): Promise<Schema.Schema.Type<typeof computerProcessKillSchema>>;
}> = defineCapability(
  "computer.processes",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      start: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerProcessSchema)(value),
            ),
        ),
      ),
      list: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerProcessesSchema)(value),
            ),
        ),
      ),
      kill: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerProcessKillSchema)(value),
            ),
        ),
      ),
    }),
  ),
);

/** Decode the Computer owner's process inventory at the App boundary. */
export async function listComputerProcesses(
  capabilities: CapabilityDirectory,
): Promise<ComputerProcesses> {
  return Schema.decodeUnknownSync(computerProcessesSchema)(
    await capabilities.require(computerProcesses).list(),
  );
}

/** Stop one process owned by the selected Computer. */
export async function killComputerProcess(
  capabilities: CapabilityDirectory,
  id: string,
) {
  return Schema.decodeUnknownSync(computerProcessKillSchema)(
    await capabilities.require(computerProcesses).kill(id),
  );
}

export const computerReadFile: CapabilityContract<{
  open(input: { path: string }): Promise<AppFileRead>;
}> = defineCapability(
  "computer.readFile",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      open: rpcMethod(
        rpcHandleSchema({
          response: rpcMethod(z.instanceof(Response)),
          close: rpcVoid,
        }),
      ),
    }),
  ),
);

/** The caller receives native file bytes; HTTP details stay in the SDK adapter. */
export async function readComputerFile(
  capabilities: CapabilityDirectory,
  input: { path: string },
  options: { signal?: AbortSignal },
): Promise<File> {
  return await readAppFile(
    await capabilities.require(computerReadFile).open(input),
    { ...options, name: input.path.split("/").at(-1) ?? "file" },
  );
}

/** Decode listing data at the SDK boundary, before the App consumes it. */
export async function listComputerFiles(
  capabilities: CapabilityDirectory,
  input: { path: string; limit: number; offset: number },
): Promise<ComputerListing> {
  return Schema.decodeUnknownSync(computerListingSchema)(
    await capabilities.require(computerList).list(input),
  );
}

export const computerWriteFile: CapabilityContract<{
  open(input: { path: string }): Promise<AppFileWrite>;
  mkdir(input: { path: string }): Promise<void>;
  replace(
    input: ComputerFileReplacementInput,
  ): Promise<ComputerFileReplacementOutcome>;
}> = defineCapability(
  "computer.writeFile",
  3,
  z.lazy(() =>
    rpcHandleSchema({
      open: rpcMethod(rpcHandleSchema({ write: rpcVoid, close: rpcVoid })),
      mkdir: rpcVoid,
      replace: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(computerFileReplacementOutcomeSchema)(
                value,
              ),
            ),
        ),
      ),
    }),
  ),
);

export type ComputerFileReplacementInput = Readonly<{
  path: string;
  expectedContent: string;
  content: string;
}>;

const computerFileReplacementOutcomeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("replaced"),
    path: Schema.NonEmptyString,
    bytes: Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
  Schema.Struct({ kind: Schema.Literal("conflict") }),
]);
export type ComputerFileReplacementOutcome = Schema.Schema.Type<
  typeof computerFileReplacementOutcomeSchema
>;

export async function replaceComputerFileIfUnchanged(
  capabilities: CapabilityDirectory,
  input: ComputerFileReplacementInput,
  options: { signal?: AbortSignal },
): Promise<Readonly<{ path: string; bytes: number }>> {
  options.signal?.throwIfAborted();
  const result = await capabilities.require(computerWriteFile).replace(input);
  if (result.kind === "conflict")
    throw new AppError("Computer file changed since it was opened", {
      code: "CONFLICT",
      retryable: false,
    });
  return { path: result.path, bytes: result.bytes };
}

export type ComputerTerminalSize = Readonly<{ cols: number; rows: number }>;

/** Display facts supplied by the admitted Computer, separate from shell bytes. */
export const computerTerminalInformationSchema = Schema.Struct({
  computerName: Schema.NonEmptyString.pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
  teamName: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256))),
  modelDoor: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256))),
  uptimeSeconds: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  version: Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(64))),
});
export type ComputerTerminalInformation = Schema.Schema.Type<
  typeof computerTerminalInformationSchema
>;

/** The host keeps the PTY socket and exposes only its two flow-controlled streams. */
export type AppComputerTerminal = Disposable & {
  information(): Promise<ComputerTerminalInformation>;
  output(): Promise<ReadableStream<Uint8Array>>;
  input(): Promise<WritableStream<Uint8Array>>;
  resize(size: ComputerTerminalSize): Promise<void>;
  close(): Promise<void>;
};

export type ComputerTerminal = Readonly<{
  information: ComputerTerminalInformation;
  output: ReadableStream<Uint8Array>;
  input: WritableStream<Uint8Array>;
  resize(size: ComputerTerminalSize): Promise<void>;
  close(): Promise<void>;
}>;

export const computerTerminal: CapabilityContract<{
  open(size: ComputerTerminalSize): Promise<AppComputerTerminal>;
}> = defineCapability(
  "computer.terminal",
  2,
  z.lazy(() =>
    rpcHandleSchema({
      open: rpcMethod(
        rpcHandleSchema({
          information: rpcMethod(
            rpcDataSchema(
              z
                .unknown()
                .transform((value) =>
                  Schema.decodeUnknownSync(computerTerminalInformationSchema)(
                    value,
                  ),
                ),
            ),
          ),
          output: rpcMethod(
            z.instanceof(ReadableStream).transform((stream) =>
              stream.pipeThrough(
                new TransformStream<unknown, Uint8Array>({
                  transform(chunk, controller) {
                    controller.enqueue(z.instanceof(Uint8Array).parse(chunk));
                  },
                }),
              ),
            ),
          ),
          input: rpcMethod(z.instanceof(WritableStream)),
          resize: rpcVoid,
          close: rpcVoid,
        }),
      ),
    }),
  ),
);

/** Open one host-owned terminal and bind its lifetime to the mounted App. */
export async function openComputerTerminal(
  capabilities: CapabilityDirectory,
  size: ComputerTerminalSize,
  options: { signal?: AbortSignal } = {},
): Promise<ComputerTerminal> {
  options.signal?.throwIfAborted();
  const terminal = await capabilities.require(computerTerminal).open(size);
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing !== undefined) return closing;
    options.signal?.removeEventListener("abort", abort);
    closing = Promise.resolve().then(async () => {
      try {
        await terminal.close();
      } finally {
        terminal[Symbol.dispose]();
      }
    });
    return closing;
  };
  const abort = () => {
    void close().catch((cause: unknown) => {
      reportCatchFailure("computer.terminal.abort-close", cause);
    });
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const [output, input, information] = await Promise.all([
      terminal.output(),
      terminal.input(),
      terminal.information(),
    ]);
    options.signal?.throwIfAborted();
    const outputStream: ReadableStream<Uint8Array> = output;
    const inputStream: WritableStream<Uint8Array> = input;
    return {
      information: Schema.decodeUnknownSync(computerTerminalInformationSchema)(
        information,
      ),
      output: outputStream,
      input: inputStream,
      resize: async (nextSize) => {
        options.signal?.throwIfAborted();
        if (closing !== undefined)
          throw new Error("Computer terminal is closed");
        await terminal.resize(nextSize);
      },
      close,
    };
  } catch (error) {
    await close().catch((cause: unknown) => {
      reportCatchFailure("computer.terminal.open-cleanup", cause);
    });
    throw error;
  }
}

/** Native file stream crosses RPC; neither File subclass nor an editable URL crosses. */
export async function writeComputerFile(
  capabilities: CapabilityDirectory,
  input: { path: string; content: Blob },
  options: { signal?: AbortSignal },
): Promise<void> {
  await writeAppFile(
    await capabilities.require(computerWriteFile).open({ path: input.path }),
    input.content,
    options,
  );
}
