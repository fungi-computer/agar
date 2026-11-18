// The one claim contract every App storage host runs: concurrent first
// writers settle on one value, the loser gets the winner's value, and no
// transport answers with a refusal status.
import { expect } from "vitest";
// The built package, never agar source: Hub and Oyster programs import this.
import type { AppStorageWire } from "@fungi.computer/agar/storage";

export type ClaimConformanceHost = Readonly<{
  /** Two handles for the same member and App, as two frames would hold. */
  first: AppStorageWire;
  second: AppStorageWire;
  /** The key under test; it must be declared with the `member` scope. */
  key: string;
  /** HTTP statuses the host's transport answered with, if it has one. */
  statuses?: () => readonly number[];
}>;

export async function expectClaimConformance(
  host: ClaimConformanceHost,
): Promise<void> {
  const [one, two] = await Promise.all([
    host.first.claim({
      key: host.key,
      scope: "member",
      value: { requestId: "first" },
    }),
    host.second.claim({
      key: host.key,
      scope: "member",
      value: { requestId: "second" },
    }),
  ]);
  expect(one.kind).toBe("accepted");
  expect(two.kind).toBe("accepted");
  if (one.kind !== "accepted" || two.kind !== "accepted") return;
  expect([one.value.claimed, two.value.claimed].sort()).toEqual([false, true]);
  const winner = one.value.claimed ? one.value : two.value;
  const loser = one.value.claimed ? two.value : one.value;
  expect(loser.value).toEqual(winner.value);
  expect(loser.revision).toBe(winner.revision);
  // A later claim keeps the stored value and changes nothing.
  const later = await host.first.claim({
    key: host.key,
    scope: "member",
    value: { requestId: "later" },
  });
  expect(later).toEqual({
    kind: "accepted",
    value: { ...winner, claimed: false },
  });
  const read = await host.second.read(host.key);
  expect(read).toMatchObject({
    kind: "accepted",
    value: { member: { value: winner.value, revision: winner.revision } },
  });
  for (const status of host.statuses?.() ?? [])
    expect(status).toBeLessThan(400);
}
