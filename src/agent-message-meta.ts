import * as z from "zod";

/** Who a Session line came from, as the admitting host authenticated them. */
export const FungiAuthorSchema = z.lazy(() =>
  z.strictObject({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(128),
    /**
     * Present only when the author is another Agent the host admitted a
     * delegated send or reply from; a line's text never sets it. Human and
     * host/system authors carry no kind.
     */
    kind: z.literal("agent").optional(),
  }),
);
/** Who a Session line came from, as the admitting host authenticated them. */
export type FungiAuthor = z.infer<typeof FungiAuthorSchema>;

const identifier = z.lazy(() => z.string().min(1).max(256));

/**
 * A delegated Agent's reply as the admitting host authenticated it against the
 * mail it sent. `commandId` is the replying Session's accepted command, the
 * same id as the sender's `agents.send` receipt.
 */
export const FungiDelegationReplySchema = z.lazy(() =>
  z.strictObject({
    agentId: identifier,
    sessionId: identifier,
    commandId: identifier,
    /** The exact settlement outcome; failures are never collapsed. */
    outcome: z.enum([
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "outcome_unknown",
    ]),
    /** Bounded, single-line terminal diagnostic for work that did not complete. */
    diagnostic: z.string().min(1).max(200).optional(),
    /** Open items of the replying Session that now wait on the recipient. */
    waitingOnYou: z
      .array(
        z.strictObject({
          itemId: identifier,
          kind: z.string().min(1).max(64),
          summary: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(8)
      .optional(),
  }),
);
/** A delegated Agent's reply as the admitting host authenticated it. */
export type FungiDelegationReply = z.infer<typeof FungiDelegationReplySchema>;

/**
 * The metadata the host attaches to every prompt and operator line it admits.
 * Shiitake stores it opaquely; the host writes it and Apps read it.
 */
export const FungiMessageMetaSchema = z.strictObject({
  author: FungiAuthorSchema.optional(),
  /** Original caller identity when the host translates its request into an owner key. */
  sourceRequestId: identifier.optional(),
  /** Host-admitted delegation path and its inherited abuse bound. */
  delegation: z
    .strictObject({
      ancestors: z.array(identifier).max(8),
      maxDepth: z.number().int().min(1).max(8),
      /** The sender asked to steer the recipient's running turn, not queue behind it. */
      steer: z.literal(true).optional(),
      /**
       * Present only on a line the host admitted as an authenticated reply;
       * a line's text never sets it.
       */
      reply: FungiDelegationReplySchema.optional(),
    })
    .optional(),
});
/** The metadata the host attaches to every prompt and operator line it admits. */
export type FungiMessageMeta = z.infer<typeof FungiMessageMetaSchema>;

/** Any JSON value, as Shiitake returns a message's metadata. */
export type MessageMetaValue =
  | string
  | number
  | boolean
  | null
  | readonly MessageMetaValue[]
  | Readonly<{ [key: string]: MessageMetaValue }>;

/** The author a message's metadata names; none for anything else. */
export function messageAuthor(
  meta: MessageMetaValue | undefined,
): FungiAuthor | undefined {
  const parsed = FungiMessageMetaSchema.safeParse(meta);
  return parsed.success ? parsed.data.author : undefined;
}

/**
 * The authenticated delegation reply a message's metadata carries; none for
 * any other line, including text that merely looks like a reply.
 */
export function messageDelegationReply(
  meta: MessageMetaValue | undefined,
): FungiDelegationReply | undefined {
  const parsed = FungiMessageMetaSchema.safeParse(meta);
  return parsed.success ? parsed.data.delegation?.reply : undefined;
}

/** The metadata the host attaches for one authenticated author, as JSON. */
export type AuthorMeta = Readonly<{
  author: Readonly<{
    [K in keyof FungiAuthor]: Exclude<FungiAuthor[K], undefined>;
  }>;
}>;

/** The metadata the host attaches for one authenticated author. */
export function authorMeta(author: FungiAuthor): AuthorMeta {
  const { id, name, kind } = author;
  return kind === undefined
    ? { author: { id, name } }
    : { author: { id, name, kind } };
}
