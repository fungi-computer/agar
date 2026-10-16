import { defineCapability } from "./capabilities.js";
import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
  rpcVoid,
} from "./internal/rpc-contract.js";
import * as z from "zod";
import type {
  CapabilityContract,
  CapabilityDirectory,
} from "./capabilities.js";

const identity = z.string().min(1).max(256);
const count = z.number().int().nonnegative();
const dollars = z.number().nonnegative();

/** The games supported by the on-box controller's current catalog. */
export const gameIdSchema = z.enum([
  "minecraft",
  "terraria",
  "factorio",
  "valheim",
  "project-zomboid",
]);
export type GameId = z.output<typeof gameIdSchema>;
export const gameServerSizeTierSchema = z.enum(["squad", "raid"]);
export type GameServerSizeTier = z.output<typeof gameServerSizeTierSchema>;
export const gameServerSizes = {
  minecraft: {
    squad: { memoryMiB: 2048, vcpuCount: 1 },
    raid: { memoryMiB: 4096, vcpuCount: 2 },
  },
  terraria: {
    squad: { memoryMiB: 2048, vcpuCount: 1 },
    raid: { memoryMiB: 4096, vcpuCount: 2 },
  },
  factorio: {
    squad: { memoryMiB: 3072, vcpuCount: 1 },
    raid: { memoryMiB: 6144, vcpuCount: 2 },
  },
  valheim: {
    squad: { memoryMiB: 4096, vcpuCount: 2 },
    raid: { memoryMiB: 6144, vcpuCount: 3 },
  },
  "project-zomboid": {
    squad: { memoryMiB: 8192, vcpuCount: 2 },
    raid: { memoryMiB: 12288, vcpuCount: 3 },
  },
} as const satisfies Record<
  GameId,
  Record<GameServerSizeTier, { memoryMiB: number; vcpuCount: number }>
>;
export const gameServerBillingModeSchema = z.enum(["insert-coin", "hardcore"]);
export type GameServerBillingMode = z.output<
  typeof gameServerBillingModeSchema
>;
export const gameServerPassIdSchema = z.enum(["booster-pack", "battle-pass"]);
export type GameServerPassId = z.output<typeof gameServerPassIdSchema>;
export const gameServerSizeSchema = z.strictObject({
  tier: gameServerSizeTierSchema,
  memoryMiB: z.number().int().positive(),
  vcpuCount: z.number().int().positive(),
});
export type GameServerSize = z.output<typeof gameServerSizeSchema>;
export const gameServerBackupSchema = z.strictObject({
  backupId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  createdAt: count,
  sizeBytes: count,
});
export type GameServerBackup = z.output<typeof gameServerBackupSchema>;
export const gameServerCatalogSchema = z.strictObject({
  games: z
    .array(
      z.strictObject({
        game: gameIdSchema,
        variants: z.array(identity),
        sizes: z.strictObject({
          squad: z.strictObject({
            size: gameServerSizeSchema,
            hourlyPriceUsd: dollars.positive().nullable(),
            monthlyCapUsd: dollars.positive().nullable(),
            hardcoreMonthlyPriceUsd: dollars.positive().nullable(),
          }),
          raid: z.strictObject({
            size: gameServerSizeSchema,
            hourlyPriceUsd: dollars.positive().nullable(),
            monthlyCapUsd: dollars.positive().nullable(),
            hardcoreMonthlyPriceUsd: dollars.positive().nullable(),
          }),
        }),
      }),
    )
    .length(5),
  pricing: z
    .strictObject({
      labels: z.strictObject({
        modes: z.strictObject({ insertCoin: identity, hardcore: identity }),
        sizes: z.strictObject({ squad: identity, raid: identity }),
        passes: z.strictObject({
          "booster-pack": identity,
          "battle-pass": identity,
        }),
      }),
      passes: z
        .array(
          z.strictObject({
            id: gameServerPassIdSchema,
            displayName: identity,
            monthlyPriceUsd: dollars,
            playerHours: count,
            serverLimit: count,
            eligibleGames: z.array(gameIdSchema),
            includesRaid: z.boolean(),
            includedWithPro: z.boolean(),
          }),
        )
        .length(2),
      alwaysOnMemoryCapMiB: count,
    })
    .nullable(),
  creditRemainingUsd: dollars,
});
export type GameServerCatalog = z.output<typeof gameServerCatalogSchema>;

export const gameServerStateSchema = z.strictObject({
  serverId: identity,
  teamId: identity,
  name: identity,
  game: gameIdSchema,
  variant: identity,
  size: gameServerSizeSchema,
  billingMode: gameServerBillingModeSchema,
  passId: gameServerPassIdSchema.nullable(),
  tunnelStatus: z.enum(["configured", "not_configured"]),
  desiredState: z.enum(["running", "stopped"]),
  phase: z.enum(["stopped", "starting", "awake", "sleeping", "failed"]),
  players: count,
  maxPlayers: count.nullable(),
  connections: z
    .array(
      z.strictObject({
        purpose: identity,
        protocol: z.enum(["tcp", "udp"]),
        host: identity,
        port: z.number().int().min(1).max(65_535),
      }),
    )
    .max(16),
  version: z.number().int().positive(),
  createdAt: count,
  updatedAt: count,
});
export type GameServerState = z.output<typeof gameServerStateSchema>;
export const gameServerSchema = gameServerStateSchema.extend({
  monthToDateCostUsd: dollars,
  teamMonthToDateCostUsd: dollars,
});
export type GameServer = z.output<typeof gameServerSchema>;

/** Passwords are write-only and never appear in GameServer or catalog responses. */
export type GameServerCreate = Readonly<{
  name: string;
  variant: string;
  requestId: string;
  sizeTier: GameServerSizeTier;
  billingMode: z.output<typeof gameServerBillingModeSchema>;
  passId: z.output<typeof gameServerPassIdSchema> | null;
}> &
  (
    | {
        game: "minecraft";
        settings: { eulaAcceptedByOperator: true; onlineMode?: boolean };
      }
    | { game: "terraria" | "factorio"; settings: Record<string, never> }
    | { game: "valheim"; settings: { password: string } }
    | { game: "project-zomboid"; settings: { adminPassword: string } }
  );
export type GameServerAction = Readonly<{
  serverId: string;
  requestId: string;
}>;
export const gameServerPageSchema = z.strictObject({
  servers: z.array(gameServerSchema).max(100),
  nextOffset: count.nullable(),
  teamMonthToDateCostUsd: dollars,
});
export type GameServerPage = z.output<typeof gameServerPageSchema>;
export const gameServerErrorCodeSchema = z.enum([
  "denied",
  "not_found",
  "conflict",
  "credit_exhausted",
  "pricing_not_configured",
  "pass_not_included",
  "pass_not_active",
  "pass_game_not_eligible",
  "pass_size_not_eligible",
  "pass_server_limit",
  "pass_mode_incompatible",
  "always_on_capacity",
  "capacity",
  "tunnel_unavailable",
  "unsupported_variant",
  "unavailable",
]);
export type GameServerErrorCode = z.output<typeof gameServerErrorCodeSchema>;

/** Versioned command delivered from the Team projection outbox to the box. */
export const gameServerHostCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("create"),
    schemaVersion: z.literal(1),
    teamId: identity,
    serverId: identity,
    version: z.number().int().positive(),
    game: gameIdSchema,
    variant: identity,
    sizeTier: gameServerSizeTierSchema,
    billingMode: gameServerBillingModeSchema,
    passId: gameServerPassIdSchema.nullable(),
    settings: z.union([
      z.strictObject({
        eulaAcceptedByOperator: z.literal(true),
        onlineMode: z.boolean().optional(),
      }),
      z.strictObject({ password: z.string().min(5).max(128) }),
      z.strictObject({ adminPassword: z.string().min(8).max(128) }),
      z.strictObject({}),
    ]),
  }),
  ...(["start", "stop", "delete", "backup-now"] as const).map((kind) =>
    z.strictObject({
      kind: z.literal(kind),
      schemaVersion: z.literal(1),
      teamId: identity,
      serverId: identity,
      version: z.number().int().positive(),
    }),
  ),
  z.strictObject({
    kind: z.literal("restore"),
    schemaVersion: z.literal(1),
    teamId: identity,
    serverId: identity,
    version: z.number().int().positive(),
    backupId: gameServerBackupSchema.shape.backupId,
  }),
]);
export type GameServerHostCommand = z.output<
  typeof gameServerHostCommandSchema
>;

/** Signed host observation; sequence and version reject stale or replayed reports. */
export const gameServerHostReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hostId: identity,
  teamId: identity,
  serverId: identity,
  version: z.number().int().positive(),
  sequence: count,
  observedAt: count,
  phase: gameServerStateSchema.shape.phase,
  players: count,
  maxPlayers: count.nullable(),
  connections: gameServerStateSchema.shape.connections,
  tunnelStatus: gameServerStateSchema.shape.tunnelStatus,
  backups: z.array(gameServerBackupSchema).max(100),
  runtime: z
    .strictObject({
      runtimeId: z.string().min(1).max(128),
      startedAt: count,
      ended: z.boolean(),
    })
    .nullable(),
});
export type GameServerHostReport = z.output<typeof gameServerHostReportSchema>;

/** A public or App game-server request refused by the Team decision. */
export class GameServerRequestError extends Error {
  constructor(
    readonly code: GameServerErrorCode,
    readonly status: number,
  ) {
    super(`Game-server request refused: ${code}`);
    this.name = "GameServerRequestError";
  }
}

/** Ordinary App capability, granted by the Team to any declared App. */
export type GameServersHandle = {
  list(input?: { limit?: number; offset?: number }): Promise<GameServerPage>;
  catalog(): Promise<GameServerCatalog>;
  create(input: GameServerCreate): Promise<GameServer>;
  status(serverId: string): Promise<GameServer>;
  start(input: GameServerAction): Promise<GameServer>;
  stop(input: GameServerAction): Promise<GameServer>;
  delete(input: GameServerAction): Promise<void>;
  backups(serverId: string): Promise<readonly GameServerBackup[]>;
  backupNow(input: GameServerAction): Promise<void>;
  restore(input: GameServerAction & { backupId: string }): Promise<GameServer>;
};
export const gamesServers: CapabilityContract<GameServersHandle> =
  defineCapability(
    "games:servers",
    1,
    z.lazy(() =>
      rpcHandleSchema({
        list: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => gameServerPageSchema.parse(value)),
          ),
        ),
        catalog: rpcMethod(
          rpcDataSchema(
            z
              .unknown()
              .transform((value) => gameServerCatalogSchema.parse(value)),
          ),
        ),
        create: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => gameServerSchema.parse(value)),
          ),
        ),
        status: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => gameServerSchema.parse(value)),
          ),
        ),
        start: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => gameServerSchema.parse(value)),
          ),
        ),
        stop: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => gameServerSchema.parse(value)),
          ),
        ),
        restore: rpcMethod(
          rpcDataSchema(
            z.unknown().transform((value) => gameServerSchema.parse(value)),
          ),
        ),
        backups: rpcMethod(
          rpcDataSchema(
            z
              .unknown()
              .transform((value) =>
                z.array(gameServerBackupSchema).parse(value),
              ),
          ),
        ),
        delete: rpcVoid,
        backupNow: rpcVoid,
      }),
    ),
  );

/** Decode the host's listing at the App boundary. */
export async function listGameServers(
  capabilities: CapabilityDirectory,
  input?: { limit?: number; offset?: number },
): Promise<GameServerPage> {
  const page = await capabilities.require(gamesServers).list(input);
  return gameServerPageSchema.parse(page);
}
