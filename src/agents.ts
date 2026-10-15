export {
  FungiAuthorSchema,
  FungiDelegationReplySchema,
  FungiMessageMetaSchema,
  messageAuthor,
  messageDelegationReply,
  authorMeta,
} from "./agent-message-meta.js";
export type {
  FungiAuthor,
  FungiDelegationReply,
  FungiMessageMeta,
  MessageMetaValue,
  AuthorMeta,
} from "./agent-message-meta.js";
import * as z from "zod";
import { defineCapability } from "./capabilities.js";
import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
  rpcFetchHandleSchema,
} from "./internal/rpc-contract.js";
import * as Schema from "effect/Schema";

import type {
  CapabilityContract,
  CapabilityDirectory,
} from "./capabilities.js";
import { AppError } from "./errors.js";
import { reportCatchFailure } from "./failure.js";

const boundedIdentity = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(256)),
);

/**
 * Validates the wire shape of an Agent record: its id, display name,
 * and which session operations (read, send, manage) this App may
 * perform on it.
 */
export const appAgentSchema = Schema.Struct({
  agentId: boundedIdentity,
  name: boundedIdentity,
  sessionOperations: Schema.Array(
    Schema.Literals(["agent.read", "agent.send", "agent.manage"]),
  ),
});

/**
 * An Agent record as decoded from the host: its id, display name, and
 * which session operations this App is permitted to perform on it.
 */
export type AppAgent = Schema.Schema.Type<typeof appAgentSchema>;

/** The admitted AGENTS.list projection, containing only ids and display names. */
export const appAgentListResultSchema = z.strictObject({
  agents: z.array(z.strictObject({ agentId: z.string(), name: z.string() })),
});

/** Computer provisioning is a Team creation choice, separate from Home policy. */
export const appAgentComputerSchema = Schema.Literals(["new", "none"]);
/** Validates Agent creation input: a name, a caller-chosen request id and an
 * optional Computer provisioning choice. */
export const appAgentCreateInputSchema = Schema.Struct({
  name: boundedIdentity,
  requestId: boundedIdentity,
  computer: Schema.optionalKey(appAgentComputerSchema),
});
/**
 * Input for creating a new Agent: its name, a caller-chosen request id
 * for idempotency, and whether to provision a new Computer for it.
 */
export type AppAgentCreateInput = Readonly<
  Schema.Schema.Type<typeof appAgentCreateInputSchema>
>;

const appAgentDirectorySchema = Schema.Array(appAgentSchema);
const decodeAgents = Schema.decodeUnknownSync(appAgentDirectorySchema, {
  onExcessProperty: "error",
});
const decodeAgentId = Schema.decodeUnknownSync(boundedIdentity);
const decodeResponse = Schema.decodeUnknownSync(Schema.instanceOf(Response));

/** Live object-capability shape received from Cap'n Web. */
export type AppAgentTransportHandle = {
  /** Send one request to the Agent's session endpoint. */
  fetch(request: Request): Promise<Response>;
  /** Release the underlying object capability. */
  close(): Promise<void>;
  /** Synchronously release local resources, for `using` disposal. */
  [Symbol.dispose](): void;
};

/** Capability handle for listing the Agents in a directory. */
export type AppAgentListHandle = {
  /** List the Agents visible to this App in the directory. */
  list(): Promise<readonly AppAgent[]>;
};
/** Capability handle for creating a new Agent in a directory. */
export type AppAgentCreateHandle = {
  /** Create a new Agent with the given name and request id. */
  create(input: AppAgentCreateInput): Promise<AppAgent>;
};
/**
 * Live capability handle for listing and creating Agents in a Team or
 * local-project directory, and opening transports to them.
 */
export type AppAgentDirectoryHandle = AppAgentListHandle &
  AppAgentCreateHandle & {
    /** Open a transport to the Agent identified by `agentId`. */
    open(input: { agentId: string }): Promise<AppAgentTransportHandle>;
    /** The member's inbox feed, limited to Agents this App may read. */
    openInbox(): Promise<AppAgentTransportHandle>;
  };

/** Capability to list the Agents visible to this App in read-only form. */
export const agentList: CapabilityContract<AppAgentListHandle> =
  defineCapability(
    "agent.list",
    1,
    rpcHandleSchema({
      list: rpcMethod(
        rpcDataSchema(z.unknown().transform((value) => decodeAgents(value))),
      ),
    }),
  );
/** Capability to create new Agents and open transports to them. */
export const agentManage: CapabilityContract<
  Pick<AppAgentDirectoryHandle, "create" | "open">
> = defineCapability(
  "agent.manage",
  1,
  rpcHandleSchema({
    open: rpcMethod(rpcFetchHandleSchema),
    create: rpcMethod(
      rpcDataSchema(
        z
          .unknown()
          .transform((value) =>
            Schema.decodeUnknownSync(appAgentSchema)(value),
          ),
      ),
    ),
  }),
);
/** Validates Agent rename input: the target Agent and its new display name. */
export const appAgentRenameInputSchema = Schema.Struct({
  agentId: boundedIdentity,
  name: boundedIdentity,
});
/**
 * Input for renaming an existing Agent: its id and the owner's chosen
 * replacement display name.
 */
export type AppAgentRenameInput = Readonly<
  Schema.Schema.Type<typeof appAgentRenameInputSchema>
>;
/** Capability handle for renaming an Agent the owner already created. */
export type AppAgentRenameHandle = {
  /** Rename an existing Agent and return its updated record. */
  rename(input: AppAgentRenameInput): Promise<AppAgent>;
};
/** Owner-only capability to rename an existing Agent; not every host grants it. */
export const agentRename: CapabilityContract<AppAgentRenameHandle> =
  defineCapability(
    "agent.rename",
    1,
    rpcHandleSchema({
      rename: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(appAgentSchema)(value),
            ),
        ),
      ),
    }),
  );
/** Rename an Agent through the host-granted owner-only capability. */
export async function renameAppAgent(
  capabilities: CapabilityDirectory,
  input: AppAgentRenameInput,
): Promise<AppAgent> {
  const request = Schema.decodeUnknownSync(appAgentRenameInputSchema)(input);
  const agent = await capabilities.require(agentRename).rename(request);
  return Schema.decodeUnknownSync(appAgentSchema)(agent);
}

/** One Agent's App-tool policy, as the owner-only policy capability reports it. */
export const appAgentToolPolicyStatusSchema = z.union([
  z.object({ status: z.literal("pending"), revision: z.string() }),
  z.object({ status: z.literal("approved"), revision: z.string() }),
]);
/** Whether an Agent's App tools are still pending the owner's approval. */
export type AppAgentToolPolicyStatus = z.infer<
  typeof appAgentToolPolicyStatusSchema
>;
/** The outcome of an owner's direct App-tool approval. */
export const appAgentToolPolicyResultSchema = z.union([
  appAgentToolPolicyStatusSchema,
  z.object({ error: z.string() }),
]);
/** The outcome of an owner's direct App-tool approval. */
export type AppAgentToolPolicyResult = z.infer<
  typeof appAgentToolPolicyResultSchema
>;
/** Capability handle for reading and approving an Agent's App-tool policy. */
export type AppAgentToolPolicyHandle = {
  /** This Agent's current policy status, or `null` for no such Agent. */
  status(input: { agentId: string }): Promise<AppAgentToolPolicyStatus | null>;
  /** Approve (or re-request) this Agent's App tools under a CAS revision. */
  approve(input: {
    agentId: string;
    level: "read" | "write";
    expectedRevision: string | null;
  }): Promise<AppAgentToolPolicyResult>;
};
/** Owner-only capability to read and approve an Agent's App-tool policy. */
export const agentToolPolicy: CapabilityContract<AppAgentToolPolicyHandle> =
  defineCapability(
    "agent.toolPolicy",
    1,
    rpcHandleSchema({
      status: rpcMethod(
        rpcDataSchema(z.union([appAgentToolPolicyStatusSchema, z.null()])),
      ),
      approve: rpcMethod(rpcDataSchema(appAgentToolPolicyResultSchema)),
    }),
  );

/**
 * Capability for read-only Agent sessions: open a transport to an
 * existing Agent, or read the member's inbox feed.
 */
export const agentSessionRead: CapabilityContract<
  Pick<AppAgentDirectoryHandle, "open" | "openInbox">
> = defineCapability(
  "agent.read",
  1,
  rpcHandleSchema({
    open: rpcMethod(rpcFetchHandleSchema),
    openInbox: rpcMethod(rpcFetchHandleSchema),
  }),
);
/**
 * Capability for read-write Agent sessions: open a transport to an
 * existing Agent and send to it, including the member's inbox feed.
 */
export const agentSessionWrite: CapabilityContract<
  Pick<AppAgentDirectoryHandle, "open" | "openInbox">
> = defineCapability(
  "agent.send",
  1,
  rpcHandleSchema({
    open: rpcMethod(rpcFetchHandleSchema),
    openInbox: rpcMethod(rpcFetchHandleSchema),
  }),
);

/** List the Agents in the host-granted Team or local-project scope. */
export async function listAppAgents(
  capabilities: CapabilityDirectory,
): Promise<readonly AppAgent[]> {
  return decodeAgents(await capabilities.require(agentList).list());
}

/** Create an Agent through the Team directory selected by the host. */
export async function createAppAgent(
  capabilities: CapabilityDirectory,
  input: AppAgentCreateInput,
): Promise<AppAgent> {
  const request = Schema.decodeUnknownSync(appAgentCreateInputSchema)(input);
  const agent = await capabilities.require(agentManage).create(request);
  return Schema.decodeUnknownSync(appAgentSchema)(agent);
}

/**
 * A Fetch-based transport to one Agent's session endpoint, scoped to
 * this App and safe to hand to an HTTP client adapter.
 */
export type AppAgentTransport = Readonly<{
  /** Private location used only by Shiitake's existing HTTP client adapter. */
  baseUrl: string;
  /** Send a request to the Agent's session endpoint. */
  fetch: typeof globalThis.fetch;
  /** Close the transport and release the underlying Agent connection. */
  close: () => Promise<void>;
}>;

/** Keep read and write handles separate while owning their shared connection lifetime. */
async function openOperationHandles(
  openRead: () => Promise<AppAgentTransportHandle>,
  openWrite: () => Promise<AppAgentTransportHandle>,
) {
  const read = await openRead();
  let write: Promise<AppAgentTransportHandle> | undefined;
  let closing: Promise<void> | undefined;
  const ensureOpen = () => {
    if (closing)
      throw new AppError("The Agent connection is closed", {
        code: "DISCONNECTED",
        retryable: true,
      });
  };
  const closeHandle = async (handle: AppAgentTransportHandle) => {
    try {
      await handle.close();
    } finally {
      handle[Symbol.dispose]();
    }
  };
  return {
    fetch: async (request: Request): Promise<Response> => {
      ensureOpen();
      const handle =
        request.method === "GET" ||
        request.method === "HEAD" ||
        openRead === openWrite
          ? read
          : await (write ??= openWrite());
      ensureOpen();
      return decodeResponse(await handle.fetch(request));
    },
    close: (): Promise<void> => {
      if (!closing) {
        closing = Promise.all([
          closeHandle(read),
          ...(write ? [write.then(closeHandle)] : []),
        ]).then(() => undefined);
        void closing.catch((cause: unknown) => {
          reportCatchFailure("agents.close", cause);
        });
      }
      return closing;
    },
  };
}

const transportBaseUrl = "https://agent-session.fungi.invalid";

/**
 * Adapt one live object capability to Fetch without exposing the parent's
 * authenticated URL or credentials to the isolated App.
 */
export async function openAppAgent(
  capabilities: CapabilityDirectory,
  input: { agentId: string },
): Promise<AppAgentTransport> {
  const agentId = decodeAgentId(input.agentId);
  // Shiitake uses this address as Session identity; reopening the same Agent
  // must share a key without aliasing another Agent's identically named Session.
  const agentPath = `/agents/id-${encodeURIComponent(agentId)}`;
  const baseUrl = `${transportBaseUrl}${agentPath}`;
  const directory = capabilities.has(agentSessionRead)
    ? capabilities.require(agentSessionRead)
    : capabilities.has(agentSessionWrite)
      ? capabilities.require(agentSessionWrite)
      : capabilities.require(agentManage);
  const openRead = () => directory.open({ agentId });
  const openWrite = capabilities.has(agentSessionRead)
    ? () =>
        (capabilities.has(agentSessionWrite)
          ? capabilities.require(agentSessionWrite)
          : capabilities.require(agentManage)
        ).open({ agentId })
    : openRead;
  const handles = await openOperationHandles(openRead, openWrite);

  const fetch: typeof globalThis.fetch = async (requestInput, init) => {
    const request = new Request(requestInput, init);
    const target = new URL(request.url);
    if (
      target.origin !== transportBaseUrl ||
      !target.pathname.startsWith(`${agentPath}/`)
    )
      throw new AppError("The Agent request target is invalid", {
        code: "INVALID_ARGUMENT",
        retryable: false,
      });
    // The capability already owns Agent selection. Preserve its ordinary
    // /sessions and /acp routes while removing the local identity prefix.
    target.pathname = target.pathname.slice(agentPath.length);
    return handles.fetch(new Request(target, request));
  };

  return Object.freeze({ baseUrl, fetch, close: handles.close });
}

const inboxBaseUrl = `${transportBaseUrl}/member`;

/**
 * Open the member's inbox feed through the host. The Hub owns the feed and
 * filters it to the Agents this App may read; the App never sees the URL.
 */
export async function openAppInbox(
  capabilities: CapabilityDirectory,
): Promise<AppAgentTransport> {
  const contract = capabilities.has(agentSessionRead)
    ? agentSessionRead
    : agentSessionWrite;
  const openRead = () => capabilities.require(contract).openInbox();
  const openWrite = capabilities.has(agentSessionRead)
    ? () => capabilities.require(agentSessionWrite).openInbox()
    : openRead;
  const handles = await openOperationHandles(openRead, openWrite);
  const fetch: typeof globalThis.fetch = async (requestInput, init) => {
    const request = new Request(requestInput, init);
    const target = new URL(request.url);
    if (
      target.origin !== transportBaseUrl ||
      !target.pathname.startsWith("/member/inbox")
    )
      throw new AppError("The inbox request target is invalid", {
        code: "INVALID_ARGUMENT",
        retryable: false,
      });
    target.pathname = target.pathname.slice("/member".length);
    return handles.fetch(new Request(target, request));
  };
  return Object.freeze({ baseUrl: inboxBaseUrl, fetch, close: handles.close });
}
