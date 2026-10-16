import * as z from "zod";
import { defineCapability } from "./capabilities.js";
import {
  rpcDataSchema,
  rpcHandleSchema,
  rpcMethod,
} from "./internal/rpc-contract.js";
import * as Schema from "effect/Schema";

import type { CapabilityContract } from "./capabilities.js";

/** Gallery shelves, in display order. */
export const marketplaceCategories = [
  "agents",
  "creative",
  "developer",
  "games",
  "productivity",
] as const;
export const marketplaceCategorySchema = Schema.Literals(marketplaceCategories);
export type MarketplaceCategory = Schema.Schema.Type<
  typeof marketplaceCategorySchema
>;

const text = (maximum: number) =>
  Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(maximum)),
  );

export const marketplacePriceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("free") }),
  Schema.Struct({
    kind: Schema.Literal("one-time"),
    currency: Schema.Literal("usd"),
    amountMinor: Schema.Number.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThan(0)),
    ),
  }),
]);
export type MarketplacePrice = Schema.Schema.Type<
  typeof marketplacePriceSchema
>;

/**
 * One gallery entry as the viewing Team sees it. `availability` says what
 * acquiring it means: `included` Apps already ship with every Team,
 * `coming-soon` entries are not yet installable. `installed` is the Team's
 * current state, not an authority.
 */
export const marketplaceListingSchema = Schema.Struct({
  listingId: text(128),
  appId: text(128),
  name: text(60),
  tagline: text(140),
  description: text(4_000),
  category: marketplaceCategorySchema,
  icon: Schema.NullOr(text(400_000)),
  screenshots: Schema.Array(
    Schema.Struct({ src: text(400_000), alt: text(160) }),
  ).pipe(Schema.check(Schema.isMaxLength(6))),
  price: marketplacePriceSchema,
  seller: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("platform"),
      accountId: text(128),
      name: text(80),
    }),
    Schema.Struct({
      kind: Schema.Literal("creator"),
      accountId: text(128),
      name: text(80),
    }),
  ]),
  availability: Schema.Literals(["available", "included", "coming-soon"]),
  installed: Schema.Boolean,
  featured: Schema.Boolean,
});
export type MarketplaceListing = Schema.Schema.Type<
  typeof marketplaceListingSchema
>;

export const marketplaceBrowseResultSchema = Schema.Struct({
  listings: Schema.Array(marketplaceListingSchema).pipe(
    Schema.check(Schema.isMaxLength(200)),
  ),
  paid: Schema.Boolean,
});
export type MarketplaceBrowseResult = Schema.Schema.Type<
  typeof marketplaceBrowseResultSchema
>;

/** One catalog family: an ordinary App listing. */
export const decodeMarketplaceBrowseResult = Schema.decodeUnknownSync(
  marketplaceBrowseResultSchema,
);

export const marketplaceAcquisitionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("installed"),
    listingId: text(128),
    appId: text(128),
  }),
  Schema.Struct({ kind: Schema.Literal("included"), listingId: text(128) }),
  Schema.Struct({
    kind: Schema.Literal("checkout"),
    listingId: text(128),
    url: Schema.String.pipe(
      Schema.check(
        Schema.makeFilter((value: string) => value.startsWith("https://")),
      ),
    ),
  }),
]);
export type MarketplaceAcquisition = Schema.Schema.Type<
  typeof marketplaceAcquisitionSchema
>;

export type MarketplaceBrowseInput = Readonly<{
  query?: string;
  category?: MarketplaceCategory | null;
}>;

/** Read the Marketplace gallery as the Team that mounted this App. */
export const marketplaceBrowse: CapabilityContract<{
  list(input: MarketplaceBrowseInput): Promise<MarketplaceBrowseResult>;
}> = defineCapability(
  "marketplace.browse",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      list: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) => decodeMarketplaceBrowseResult(value)),
        ),
      ),
    }),
  ),
);

/**
 * Acquire a listing for the mounting Team. Free listings install at once;
 * paid listings return a hosted Checkout URL and install after payment.
 * The host re-checks Team authority and entitlement on every call.
 */
export const marketplacePurchase: CapabilityContract<{
  acquire(
    input: Readonly<{ listingId: string; requestId: string }>,
  ): Promise<MarketplaceAcquisition>;
}> = defineCapability(
  "marketplace.purchase",
  1,
  z.lazy(() =>
    rpcHandleSchema({
      acquire: rpcMethod(
        rpcDataSchema(
          z
            .unknown()
            .transform((value) =>
              Schema.decodeUnknownSync(marketplaceAcquisitionSchema)(value),
            ),
        ),
      ),
    }),
  ),
);

/** Anonymous discovery only; acquisition and launch still require Team admission. */
export async function browsePublicMarketplace(
  hubOrigin: string,
  category: MarketplaceCategory,
  request: typeof fetch = fetch,
): Promise<readonly MarketplaceListing[]> {
  const url = new URL("/api/public/marketplace/listings", hubOrigin);
  url.searchParams.set("category", category);
  const response = await request(url, {
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Marketplace is unavailable");
  const page = Schema.decodeUnknownSync(
    Schema.Struct({
      listings: Schema.Array(marketplaceListingSchema).pipe(
        Schema.check(Schema.isMaxLength(48)),
      ),
    }),
  )(await response.json());
  return page.listings;
}
