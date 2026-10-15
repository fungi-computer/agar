import type { WorkflowReviewInboxItem } from "./inbox.js";
import { describe, expect, it, vi } from "vitest";
import * as Schema from "effect/Schema";

import {
  watchMemberInbox,
  memberInboxPageSchema,
  inboxVisitResultSchema,
  type InboxEventSource,
  type MemberInboxDeltaItem,
  type MemberInboxSnapshot,
} from "./inbox.js";

type Listener = (event: MessageEvent<string>) => void;
type FeedEvent =
  | Readonly<{
      kind: "rows";
      from: number;
      to: number;
      items: readonly MemberInboxDeltaItem[];
      more: boolean;
    }>
  | Readonly<{ kind: "reset"; cursor: number }>;

class FakeEvents implements InboxEventSource {
  readonly listeners = new Map<string, Listener>();
  closed = false;
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: FeedEvent) {
    this.listeners.get(type)?.(
      new MessageEvent(type, { data: JSON.stringify(data) }),
    );
  }
}

const row = (sessionId: string, state: "running" | "done", at: number) => ({
  agentId: "agent-a",
  sessionId,
  title: sessionId,
  createdAt: 1,
  lastActivityAt: at,
  state,
});

it("decodes the existing Inbox page continuation and visit acknowledgement", () => {
  const decodePage = Schema.decodeUnknownSync(memberInboxPageSchema);
  for (const next of [null, "owner-continuation"]) {
    const page = { items: [row("existing", "done", 2)], next, cursor: 3 };
    expect(decodePage(page)).toEqual(page);
  }
  for (const cursor of [-1, 1.5])
    expect(() => decodePage({ items: [], next: null, cursor })).toThrow();
  expect(() => decodePage({ error: "not_granted" })).toThrow();
  expect(inboxVisitResultSchema.parse({ visited: true })).toEqual({
    visited: true,
  });
  for (const reply of [
    null,
    undefined,
    { visited: false },
    { error: "not_granted" },
    { visited: true, extra: true },
  ])
    expect(inboxVisitResultSchema.safeParse(reply).success).toBe(false);
});

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(pages: unknown[]) {
  const sources: FakeEvents[] = [];
  const snapshots: MemberInboxSnapshot[] = [];
  const requests: string[] = [];
  const feed = watchMemberInbox({
    baseUrl: "https://hub.test/api/teams/t",
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/visits"))
        return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(Response.json(pages.shift()));
    },
    openEvents: (url) => {
      const source = new FakeEvents(url);
      sources.push(source);
      return source;
    },
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { feed, sources, snapshots, requests };
}

describe("member inbox feed", () => {
  it("loads a Workflow review beside Sessions without inventing an Agent identity", async () => {
    const review: WorkflowReviewInboxItem = {
      kind: "workflow-review",
      key: { runId: "run-review", nodeId: "look", iteration: "panel/0" },
      installationId: "workflows-installation",
      workflowId: "storyboard",
      workflowTitle: "Storyboard",
      reviewTitle: "Keep this panel?",
      reviewers: "runner",
      show: ["First panel", { file: "storyboards/run-review/panel.png" }],
      choices: ["keep", "redo"],
      openedAt: 100,
      expiresAt: 60_100,
      state: "pending",
    };
    const session = row("conversation", "running", 2);
    const { feed, snapshots, sources } = harness([
      { items: [session, review], next: null, cursor: 3 },
    ]);
    await flush();
    expect(snapshots.at(-1)).toEqual({
      status: "live",
      items: [session, review],
    });
    const rawGraphReview: WorkflowReviewInboxItem = {
      ...review,
      key: { ...review.key, iteration: "panel/1" },
      workflowId: null,
    };
    sources[0]?.emit("rows", {
      kind: "rows",
      from: 3,
      to: 4,
      more: false,
      items: [{ ...review, state: "answered" }, rawGraphReview],
    });
    expect(snapshots.at(-1)?.items).toEqual([
      session,
      { ...review, state: "answered" },
      rawGraphReview,
    ]);
    sources[0]?.emit("rows", {
      kind: "rows",
      from: 4,
      to: 5,
      more: false,
      items: [{ ...review, state: "closed" }],
    });
    expect(snapshots.at(-1)?.items).toEqual([
      session,
      { ...review, state: "closed" },
      rawGraphReview,
    ]);
    feed.close();
  });

  it("loads, follows deltas from its cursor and repairs a missed delta", async () => {
    const { feed, sources, snapshots } = harness([
      { items: [row("a", "running", 1)], next: null, cursor: 3 },
    ]);
    await flush();
    expect(snapshots.at(-1)).toMatchObject({ status: "live" });
    expect(sources[0]?.url).toBe(
      "https://hub.test/api/teams/t/inbox/events?after=3",
    );
    sources[0]?.emit("rows", {
      kind: "rows",
      from: 3,
      to: 4,
      items: [row("a", "done", 2)],
      more: false,
    });
    expect(snapshots.at(-1)?.items).toEqual([row("a", "done", 2)]);

    // Delta 4→5 is lost; 5→6 arrives. The client reopens after 4.
    sources[0]?.emit("rows", {
      kind: "rows",
      from: 5,
      to: 6,
      items: [row("b", "running", 3)],
      more: false,
    });
    expect(sources[0]?.closed).toBe(true);
    expect(sources[1]?.url).toBe(
      "https://hub.test/api/teams/t/inbox/events?after=4",
    );
    expect(snapshots.at(-1)?.items).toHaveLength(1);
    sources[1]?.emit("rows", {
      kind: "rows",
      from: 4,
      to: 6,
      items: [row("c", "done", 4), row("b", "running", 3)],
      more: false,
    });
    expect(snapshots.at(-1)?.items).toEqual([
      row("a", "done", 2),
      row("c", "done", 4),
      row("b", "running", 3),
    ]);
    feed.close();
    expect(sources[1]?.closed).toBe(true);
  });

  it("reloads its first page on reset and records visits with the owner", async () => {
    const { feed, sources, snapshots, requests } = harness([
      { items: [row("a", "done", 1)], next: null, cursor: 9 },
      { items: [row("z", "done", 5)], next: null, cursor: 2 },
    ]);
    await flush();
    sources[0]?.emit("reset", { kind: "reset", cursor: 2 });
    await flush();
    expect(snapshots.at(-1)?.items).toEqual([row("z", "done", 5)]);
    expect(sources[1]?.url).toContain("after=2");
    await feed.visit("agent-a", "z");
    expect(requests).toContain(
      "POST https://hub.test/api/teams/t/inbox/visits",
    );
    feed.close();
  });

  it("drops a Session when its owner publishes a deletion delta", async () => {
    const { feed, sources, snapshots } = harness([
      { items: [row("gone", "done", 2)], next: null, cursor: 4 },
    ]);
    await flush();
    sources[0]?.emit("rows", {
      kind: "rows",
      from: 4,
      to: 5,
      items: [{ agentId: "agent-a", sessionId: "gone", deleted: true }],
      more: false,
    });
    expect(snapshots.at(-1)?.items).toEqual([]);
    feed.close();
  });

  it("refreshes the Agent directory snapshot and resumes its feed", async () => {
    const { feed, sources, snapshots, requests } = harness([
      { items: [], next: null, cursor: 2 },
      { items: [row("first-session", "running", 3)], next: null, cursor: 3 },
    ]);
    await flush();
    await feed.refresh();
    await flush();
    expect(
      requests.filter((request) => request.startsWith("GET ")),
    ).toHaveLength(2);
    expect(sources[0]?.closed).toBe(true);
    expect(sources[1]?.url).toContain("after=3");
    expect(snapshots.at(-1)?.items).toEqual([
      row("first-session", "running", 3),
    ]);
    feed.close();
  });

  it("does not report a pending refresh rejected after its feed closes", async () => {
    let rejectRequest: ((cause: Error) => void) | undefined;
    const pending = new Promise<Response>((_, reject) => {
      rejectRequest = reject;
    });
    const snapshots: MemberInboxSnapshot[] = [];
    const failureLog = vi
      .spyOn(globalThis.console, "error")
      .mockImplementation(() => undefined);
    const feed = watchMemberInbox({
      baseUrl: "https://hub.test/api/teams/t",
      fetch: () => pending,
      openEvents: (url) => new FakeEvents(url),
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    try {
      feed.close();
      if (!rejectRequest) throw new Error("Inbox request did not start");
      rejectRequest(new Error("Navigation canceled the pending request"));
      await flush();
      expect(snapshots.map(({ status }) => status)).toEqual(["loading"]);
      expect(failureLog).not.toHaveBeenCalled();
    } finally {
      feed.close();
      failureLog.mockRestore();
    }
  });

  it("continues to report a failed refresh while its feed is active", async () => {
    const snapshots: MemberInboxSnapshot[] = [];
    const failureLog = vi
      .spyOn(globalThis.console, "error")
      .mockImplementation(() => undefined);
    const feed = watchMemberInbox({
      baseUrl: "https://hub.test/api/teams/t",
      fetch: () => Promise.reject(new Error("Inbox request failed")),
      openEvents: (url) => new FakeEvents(url),
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    try {
      await flush();
      expect(snapshots.map(({ status }) => status)).toEqual([
        "loading",
        "error",
      ]);
      expect(failureLog).toHaveBeenCalledWith(
        JSON.stringify({
          source: "agar",
          operation: "inbox.refresh",
          failureKind: "Error",
        }),
        expect.anything(),
      );
    } finally {
      feed.close();
      failureLog.mockRestore();
    }
  });
});

it("invalidates Working on disconnect and rereads the owner before reconnecting", async () => {
  const { feed, sources, snapshots } = harness([
    { items: [row("a", "running", 1)], next: null, cursor: 1 },
    { items: [row("a", "done", 2)], next: null, cursor: 2 },
  ]);
  await flush();
  sources[0]?.listeners.get("error")?.(new MessageEvent("error"));
  expect(snapshots.at(-1)?.status).toBe("error");
  sources[0]?.listeners.get("open")?.(new MessageEvent("open"));
  await flush();
  expect(snapshots.at(-1)).toEqual({
    status: "live",
    items: [row("a", "done", 2)],
  });
  feed.close();
});
