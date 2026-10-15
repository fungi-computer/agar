import { expect, it, vi } from "vitest";
import { createGillClient, type RowV1 } from "@fungi.computer/gills";
import { decodeGillRefusal, defineAppGill } from "./gills.js";

it("offers the declared placement picker without reading when a required parameter is missing", async () => {
  const read = vi.fn(() => Promise.resolve(null));
  const view = defineAppGill({
    id: "files",
    title: "Recent Files",
    source: "documents.recent",
    limit: 10,
    params: [
      { key: "computer", label: "Computer", kind: "computer", required: true },
    ],
    input: ({ limit }) => ({ limit }),
    rows: () => ({
      viewId: "files",
      title: "Recent Files",
      state: "empty",
      rows: [],
    }),
  });
  const reply = await view.call({ id: "files" }, read);
  expect(reply).toMatchObject({
    state: "error",
    reason: "params_required",
    recovery: { kind: "configure", param: "computer" },
  });
  expect(read).not.toHaveBeenCalled();
});

it("shortens status text to the reply budget while retaining every row, navigation and cursor", async () => {
  const rows: RowV1[] = Array.from({ length: 200 }, (_, index) => ({
    id: String(index),
    title: "File",
    status: { label: "界".repeat(4096), tone: "warning" },
    open: { params: [{ key: "path", value: `/file-${String(index)}` }] },
  }));
  const view = defineAppGill({
    id: "files",
    title: "Files",
    source: "readFiles",
    limit: 200,
    input: ({ limit }) => ({ limit }),
    rows: () => ({
      viewId: "files",
      title: "Files",
      state: "full",
      rows,
      next: "source-next",
    }),
  });
  const reply = await view.call({ id: "files" }, () => Promise.resolve(null));
  if (!("rows" in reply) || reply.state !== "full")
    throw new Error("Expected the source page");
  expect(reply.rows).toHaveLength(200);
  expect(reply.rows.map((row) => row.open)).toEqual(
    rows.map((row) => row.open),
  );
  expect(reply.rows[0]?.status?.tone).toBe("warning");
  expect(reply.next).toBe("source-next");
  expect(
    new TextEncoder().encode(JSON.stringify(reply)).byteLength,
  ).toBeLessThanOrEqual(240 * 1024);
});

it("turns only the strict isolation refusal into a permanent Gill state", async () => {
  const client = (response: Response) =>
    createGillClient({
      decodeRefusal: decodeGillRefusal,
      endpoint: "https://hub.example.test/gills",
      declaration: { id: "inbox", title: "Inbox" },
      fetch: () => Promise.resolve(response),
    });
  expect(
    await client(
      Response.json(
        {
          error: "App execution unavailable",
          reason: "exec_isolation_required",
        },
        { status: 503 },
      ),
    ).request({ viewId: "inbox" }),
  ).toEqual({
    viewId: "inbox",
    title: "Inbox",
    state: "error",
    rows: [],
    reason: "exec_isolation_required",
    error: "Inbox isn't available on this preview.",
  });
  for (const body of [
    { error: "App execution unavailable", reason: "artifact_unavailable" },
    { error: "App execution unavailable", reason: "unknown" },
    {
      error: "App execution unavailable",
      reason: "exec_isolation_required",
      stack: "private",
    },
  ])
    await expect(
      client(Response.json(body, { status: 503 })).request({ viewId: "inbox" }),
    ).rejects.toThrow("HTTP 503");
});
