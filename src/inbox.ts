import {
  memberInboxItemSchema,
  memberInboxDeltaItemSchema,
  memberInboxItemKey,
  type MemberInboxItem,
  type MemberInboxDeltaItem,
} from "@fungi.computer/puffball/inbox";
export {
  memberInboxItemSchema,
  memberInboxDeltaItemSchema,
  memberInboxSessionSchema,
  workflowReviewInboxItemSchema,
  workflowReviewKeySchema,
  memberInboxKey,
  memberInboxItemKey,
  type MemberInboxItem,
  type MemberInboxDeltaItem,
  type MemberInboxSession,
  type WorkflowReviewInboxItem,
  type WorkflowReviewKey,
} from "@fungi.computer/puffball/inbox";
import { sellerClosureNoticeSchema } from "@fungi.computer/puffball/seller-closure-notice";
import { artifactDispositionNoticeSchema } from "@fungi.computer/puffball/artifact-dispositions";
import type { AppAgentTransport } from "./agents.js";
import * as Schema from "effect/Schema";
import * as z from "zod";
import { reportCatchFailure } from "./failure.js";

/**
 * Client for one member's inbox feed. The host's member owner decides nothing
 * here either: this module keeps the rows it is sent, resumes from its member
 * cursor, and re-reads whenever a delta could have been missed. It never
 * polls.
 */

const time = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
);

/** A member Inbox page and its owner-issued continuation and revision. */
export const memberInboxPageSchema = Schema.Struct({
  items: Schema.Array(memberInboxItemSchema),
  next: Schema.NullOr(Schema.String),
  cursor: time,
});

/** A successful visit to an existing admitted Inbox Session. */
export const inboxVisitResultSchema = z.strictObject({
  visited: z.literal(true),
});

const decodePage = Schema.decodeUnknownSync(memberInboxPageSchema);
const decodeRows = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.Literal("rows"),
      from: time,
      to: time,
      items: Schema.Array(memberInboxDeltaItemSchema),
      more: Schema.Boolean,
    }),
  ),
);

/** Pages the first read loads; later rows arrive as deltas. */
export const memberInboxInitialPages = 5;

/** Minimal EventSource surface, so a capability fetch can carry the stream. */
export type InboxEventSource = {
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void;
  close(): void;
};

export type MemberInboxSnapshot = Readonly<{
  items: readonly MemberInboxItem[];
  status: "loading" | "live" | "error";
}>;

export type MemberInboxFeed = Readonly<{
  /** Record that the member opened a Session; the owner moves its row. */
  visit: (agentId: string, sessionId: string) => Promise<void>;
  /** Re-register the current Agent directory and reload rows after a new Agent. */
  refresh: () => Promise<void>;
  close: () => void;
}>;

/**
 * Load the member inbox, then follow its deltas. A delta that does not start
 * at this client's cursor means one was missed: the stream is reopened from
 * the cursor, and the owner replays every change after it. `reset` reloads.
 */
export function watchMemberInbox(
  options: Readonly<{
    /** Base that serves `/inbox`, `/inbox/events` and `/inbox/visits`. */
    baseUrl: string;
    fetch: typeof globalThis.fetch;
    openEvents: (url: string) => InboxEventSource;
    onChange: (snapshot: MemberInboxSnapshot) => void;
  }>,
): MemberInboxFeed {
  const items = new Map<string, MemberInboxItem>();
  let cursor = 0;
  let closed = false;
  let events: InboxEventSource | undefined;
  let generation = 0;

  const emit = (status: MemberInboxSnapshot["status"]) => {
    if (!closed) options.onChange({ items: [...items.values()], status });
  };
  const upsert = (list: readonly MemberInboxDeltaItem[]) => {
    for (const item of list) {
      const key = memberInboxItemKey(item);
      if ("deleted" in item) items.delete(key);
      else items.set(key, item);
    }
  };

  const follow = () => {
    events?.close();
    const current = ++generation;
    const source = options.openEvents(
      `${options.baseUrl}/inbox/events?after=${String(cursor)}`,
    );
    events = source;
    let disconnected = false;
    source.addEventListener("error", () => {
      if (closed || current !== generation) return;
      disconnected = true;
      reportCatchFailure(
        "inbox.observe",
        new Error("Member inbox stream disconnected"),
      );
      emit("error");
    });
    source.addEventListener("open", () => {
      if (closed || current !== generation || !disconnected) return;
      // A transport reconnect is not an owner refresh. Read before claiming live.
      void load();
    });
    source.addEventListener("rows", (event) => {
      if (closed || current !== generation) return;
      let delta: ReturnType<typeof decodeRows>;
      try {
        delta = decodeRows(event.data);
      } catch (cause) {
        reportCatchFailure("inbox.decode-event", cause);
        emit("loading");
        follow();
        return;
      }
      if (delta.from !== cursor) {
        // A missed delta: resume from what this client actually holds.
        emit("loading");
        follow();
        return;
      }
      upsert(delta.items);
      cursor = delta.to;
      emit("live");
    });
    source.addEventListener("reset", () => {
      if (closed || current !== generation) return;
      void load();
    });
  };

  const load = async () => {
    const current = ++generation;
    events?.close();
    events = undefined;
    emit("loading");
    try {
      items.clear();
      let after: string | null = null;
      let first = true;
      for (let page = 0; page < memberInboxInitialPages; page += 1) {
        const query: string =
          after === null ? "" : `?after=${encodeURIComponent(after)}`;
        const response = await options.fetch(
          `${options.baseUrl}/inbox${query}`,
          {
            cache: "no-store",
          },
        );
        if (!response.ok) throw new Error("Inbox unavailable");
        const read = decodePage(await response.json());
        if (closed || current !== generation) return;
        // Deltas resume after the first page's cursor; later pages only add.
        if (first) cursor = read.cursor;
        first = false;
        upsert(read.items);
        after = read.next;
        if (after === null) break;
      }
      emit("live");
      follow();
    } catch (cause) {
      if (closed || current !== generation) return;
      reportCatchFailure("inbox.refresh", cause);
      emit("error");
    }
  };

  void load();
  return Object.freeze({
    refresh: () => (closed ? Promise.resolve() : load()),
    visit: async (agentId: string, sessionId: string) => {
      const response = await options.fetch(`${options.baseUrl}/inbox/visits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, sessionId }),
      });
      if (!response.ok && response.status !== 404)
        throw new Error("Visit was not recorded");
    },
    close: () => {
      closed = true;
      generation += 1;
      events?.close();
    },
  });
}

const decodeTeamNotices = Schema.decodeUnknownSync(
  Schema.Struct({
    items: Schema.Array(
      Schema.Union([
        Schema.Struct({
          ...artifactDispositionNoticeSchema.fields,
          reason: Schema.optional(
            artifactDispositionNoticeSchema.fields.reason,
          ),
          createdAt: time,
        }),
        Schema.Struct({ ...sellerClosureNoticeSchema.fields, createdAt: time }),
      ]),
    ).pipe(Schema.check(Schema.isMaxLength(100))),
    next: Schema.NullOr(
      Schema.String.pipe(Schema.check(Schema.isMaxLength(1024))),
    ),
  }),
  { onExcessProperty: "error" },
);

/** Shared Team notices use the same member-admitted inbox transport as Session reads. */
export async function readTeamInboxNoticePage(
  transport: Pick<AppAgentTransport, "baseUrl" | "fetch">,
  after: string | null = null,
) {
  const url = new URL(`${transport.baseUrl}/inbox/notices`);
  if (after !== null) url.searchParams.set("after", after);
  const response = await transport.fetch(url);
  if (!response.ok) throw new Error("Team notices unavailable");
  return decodeTeamNotices(await response.json());
}
