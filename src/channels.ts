import * as z from "zod";
import { defineCapability } from "./capabilities.js";
import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
} from "./internal/rpc-contract.js";

const identity = z.string().min(1).max(256);
const handoffVersion = z.number().int().nonnegative();
/** The one versioned reply owner of a channel conversation. */
export const handoffSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("agent"), version: handoffVersion }),
  z.strictObject({
    state: z.literal("requested"),
    version: handoffVersion,
    reason: z.string().max(4000),
    at: z.number().int().nonnegative(),
  }),
  z.strictObject({
    state: z.literal("person"),
    version: handoffVersion,
    memberId: identity,
    memberName: z.string().min(1).max(128),
    since: z.number().int().nonnegative(),
  }),
]);
export type Handoff = z.output<typeof handoffSchema>;
/** An addressed website binding; no visitor credentials or site keys. */
export const appWebsiteSchema = z.strictObject({
  bindingId: identity,
  agentId: identity,
  origins: z.array(z.string().min(1).max(2048)).min(1).max(16),
  lifecycle: z.enum(["active", "suspended"]),
});
/** Owner-projected takeover state for one website conversation. */
export const appWebsiteConversationSchema = z.strictObject({
  sessionId: identity,
  label: z.string().max(4096),
  lastEventAt: z.number().int().nonnegative(),
  needsYou: z
    .strictObject({
      at: z.number().int().nonnegative(),
      reason: z.string().max(4000),
    })
    .nullable(),
  held: z.boolean(),
  heldByYou: z.boolean(),
  heldByName: z.string().min(1).max(128).nullable(),
  holdVersion: z.number().int().nonnegative(),
});
/** The binding is selected by its owner, never by an Agent identity. */
export const appWebsiteSelectionSchema = z.strictObject({
  bindingId: identity,
});
/** An exact conversation under that binding. */
export const appWebsiteConversationSelectionSchema =
  appWebsiteSelectionSchema.extend({
    sessionId: identity,
  });
/** An idempotent member reply through the takeover owner, not Session.prompt. */
export const appWebsiteReplySchema =
  appWebsiteConversationSelectionSchema.extend({
    requestId: z.string().min(1).max(128),
    text: z.string().trim().min(1).max(4000),
  });
/** Take over or hand back only the handoff version the member observed. */
export const handoffChangeSchema = z.strictObject({
  expectedVersion: handoffVersion,
  confirm: z.boolean(),
});
export const appWebsiteHoldSchema =
  appWebsiteConversationSelectionSchema.extend(handoffChangeSchema.shape);
/** Dismiss only an Agent's unanswered request for a person. */
export const appWebsiteDismissSchema =
  appWebsiteConversationSelectionSchema.extend({
    expectedVersion: handoffVersion,
  });
/** The bounded website directory returned by the channel owner. */
export const appWebsitePageSchema = z.strictObject({
  websites: z.array(appWebsiteSchema).max(1000),
});
/** At most 100 recent conversations projected by the App host. */
export const appWebsiteConversationPageSchema = z.strictObject({
  conversations: z.array(appWebsiteConversationSchema).max(100),
});
export type AppWebsiteConversation = z.output<
  typeof appWebsiteConversationSchema
>;
/** Read-only channel data admitted to a member's App installation. */
export type AppChannelsReadHandle = {
  list(): Promise<z.output<typeof appWebsitePageSchema>>;
  conversations(
    input: z.output<typeof appWebsiteSelectionSchema>,
  ): Promise<z.output<typeof appWebsiteConversationPageSchema>>;
};
/** Takeover actions keep the authenticated member and live grant on the host. */
export type AppChannelsManageHandle = {
  hold(
    input: z.output<typeof appWebsiteHoldSchema>,
  ): Promise<AppWebsiteConversation>;
  release(
    input: z.output<typeof appWebsiteHoldSchema>,
  ): Promise<AppWebsiteConversation>;
  dismiss(
    input: z.output<typeof appWebsiteDismissSchema>,
  ): Promise<AppWebsiteConversation>;
  reply(
    input: z.output<typeof appWebsiteReplySchema>,
  ): Promise<Readonly<{ status: "sent" }>>;
};
const conversationResult = z.strictObject({
  conversation: appWebsiteConversationSchema,
});
/** Response to a successful member takeover action. */
export const appWebsiteActionResponseSchema = conversationResult;
/** A successful reply is recorded without starting an Agent turn. */
export const appWebsiteReplyResponseSchema = z.strictObject({
  status: z.literal("sent"),
});
/** Reading website conversations is never an automatic default-App grant. */
export const channelsRead = defineCapability<AppChannelsReadHandle>(
  "channels.read",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      list: rpcMethod(rpcDataSchema(appWebsitePageSchema)),
      conversations: rpcMethod(rpcDataSchema(appWebsiteConversationPageSchema)),
    }),
  ),
);
/** Member-only takeover; separate consent from read-only channel access. */
export const channelsPersonalManage = defineCapability<AppChannelsManageHandle>(
  "channels.personal.manage",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      hold: rpcMethod(rpcDataSchema(appWebsiteConversationSchema)),
      release: rpcMethod(rpcDataSchema(appWebsiteConversationSchema)),
      dismiss: rpcMethod(rpcDataSchema(appWebsiteConversationSchema)),
      reply: rpcMethod(rpcDataSchema(appWebsiteReplyResponseSchema)),
    }),
  ),
);
