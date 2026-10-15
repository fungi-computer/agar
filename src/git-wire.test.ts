import { expect, test } from "vitest";
import {
  parseReceivePack,
  readPacketLines,
  refusalReport,
} from "./git-wire.js";

const pkt = (line: string) =>
  (line.length + 4).toString(16).padStart(4, "0") + line;
test("receive-pack refuses the whole command section when a signed command is unsupported", () => {
  const bytes = new TextEncoder().encode(
    pkt("push-cert\0report-status\n") +
      pkt(`${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\n`) +
      "0000",
  );
  expect(parseReceivePack(bytes)).toEqual({
    kind: "invalid",
    reason: "push-cert",
  });
});

test("whole-push refusal keeps classic side-band packets within the Git wire bound", () => {
  const updates = Array.from({ length: 256 }, (_, n) => ({
    ref: `refs/heads/${"branch".repeat(120)}-${String(n)}`,
    before: "0".repeat(40),
    after: "a".repeat(40),
  }));
  const report = refusalReport(
    {
      allowed: false,
      refused: [
        {
          ref: updates.at(0)?.ref ?? "refs/heads/missing",
          message: "open a Change",
        },
      ],
    },
    updates,
    ["side-band"],
  );
  const packets = readPacketLines(report, false);
  expect(packets.length).toBeGreaterThan(1);
  expect(
    packets.every((packet) => packet[0] === 1 && packet.length + 4 <= 1000),
  ).toBe(true);
});

test("receive-pack reads the commands after a shallow repository's graft boundaries", () => {
  // `git push` from a `--depth 1` clone sends its shallow boundary first.
  const base = "1c6479119653aa6e5c5b5fca1999a8f8419a3588";
  const head = "fabfc10d53d96040182a47c0e0d3a4a4b1e0c111";
  const bytes = new TextEncoder().encode(
    pkt(`shallow ${base}\n`) +
      pkt(
        `${base} ${head} refs/heads/storyboard-drafts\0 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.47.3\n`,
      ) +
      "0000PACK",
  );
  expect(parseReceivePack(bytes)).toEqual({
    kind: "ok",
    updates: [
      { before: base, after: head, ref: "refs/heads/storyboard-drafts" },
    ],
    capabilities: [
      "report-status-v2",
      "side-band-64k",
      "quiet",
      "object-format=sha1",
      "agent=git/2.47.3",
    ],
  });
});

test("receive-pack refuses shallow boundaries without a command", () => {
  const bytes = new TextEncoder().encode(
    pkt(`shallow ${"a".repeat(40)}\n`) + "0000",
  );
  expect(parseReceivePack(bytes)).toEqual({
    kind: "invalid",
    reason: "unparsable",
  });
});

test("receive-pack refuses a shallow boundary after the first command", () => {
  const bytes = new TextEncoder().encode(
    pkt(
      `${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\0report-status\n`,
    ) +
      pkt(`shallow ${"b".repeat(40)}\n`) +
      "0000",
  );
  expect(parseReceivePack(bytes)).toEqual({
    kind: "invalid",
    reason: "unparsable",
  });
});

test("receive-pack reads a lone flush as git's pre-flight probe for a chunked push", () => {
  expect(parseReceivePack(new TextEncoder().encode("0000"))).toEqual({
    kind: "probe",
  });
  expect(parseReceivePack(new TextEncoder().encode("0000PACK"))).toEqual({
    kind: "invalid",
    reason: "unparsable",
  });
});
