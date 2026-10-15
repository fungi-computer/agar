import { newMessagePortRpcSession, RpcTarget } from "@fungi.computer/capnweb";
import { describe, expect, it } from "vitest";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import { createCapabilityDirectory } from "./internal/capabilities.js";
import {
  marketplaceBrowse,
  marketplacePurchase,
  type MarketplaceAcquisition,
  type MarketplaceBrowseInput,
  type MarketplaceBrowseResult,
} from "./marketplace.js";

const listing = {
  listingId: "listing_orchard",
  appId: "app_orchard",
  name: "Orchard",
  tagline: "Grow a tiny garden of agents.",
  description: "Plant agents.",
  category: "agents",
  icon: null,
  screenshots: [],
  price: { kind: "free" },
  seller: { kind: "creator", accountId: "team_seller", name: "Seller" },
  availability: "available",
  installed: false,
  featured: false,
} as const;

class MarketplaceOwner extends RpcTarget {
  readonly browsed: MarketplaceBrowseInput[] = [];
  constructor(
    readonly result: WhistleJsonValue,
    readonly acquisition: WhistleJsonValue,
  ) {
    super();
  }
  list(input: MarketplaceBrowseInput) {
    this.browsed.push(input);
    return Promise.resolve(this.result);
  }
  acquire() {
    return Promise.resolve(this.acquisition);
  }
}

function directory(owner: MarketplaceOwner) {
  const channel = new MessageChannel();
  const client = newMessagePortRpcSession(channel.port1);
  const peer = newMessagePortRpcSession(channel.port2, owner);
  const controller = createCapabilityDirectory([
    { handle: client, ...marketplaceBrowse },
    { handle: client, ...marketplacePurchase },
  ]);
  return {
    directory: controller.directory,
    close() {
      controller.disconnect();
      client[Symbol.dispose]();
      peer[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

describe("Marketplace capabilities", () => {
  it("names both capabilities in the platform grammar", () => {
    expect(marketplaceBrowse).toEqual({ id: "marketplace.browse", version: 1 });
    expect(marketplacePurchase).toEqual({
      id: "marketplace.purchase",
      version: 1,
    });
  });

  it("decodes the gallery and an acquisition at the SDK boundary", async () => {
    const result: MarketplaceBrowseResult = {
      listings: [listing],
      paid: false,
    };
    const acquisition: MarketplaceAcquisition = {
      kind: "installed",
      listingId: listing.listingId,
      appId: listing.appId,
    };
    const owner = new MarketplaceOwner(result, acquisition);
    const capabilities = directory(owner);
    expect(
      await capabilities.directory
        .require(marketplaceBrowse)
        .list({ query: "orch" }),
    ).toEqual(result);
    expect(owner.browsed).toEqual([{ query: "orch" }]);
    expect(
      await capabilities.directory.require(marketplacePurchase).acquire({
        listingId: listing.listingId,
        requestId: "r1",
      }),
    ).toEqual(acquisition);
    capabilities.close();
  });

  it("rejects a host reply outside the contract", async () => {
    const owner = new MarketplaceOwner(
      { listings: [{ ...listing, category: "weapons" }], paid: false },
      { kind: "checkout", listingId: "listing_x", url: "http://insecure.test" },
    );
    const capabilities = directory(owner);
    await expect(
      capabilities.directory.require(marketplaceBrowse).list({}),
    ).rejects.toThrow();
    await expect(
      capabilities.directory.require(marketplacePurchase).acquire({
        listingId: "listing_x",
        requestId: "r",
      }),
    ).rejects.toThrow();
    capabilities.close();
  });

  it("refuses entries without an App identity", async () => {
    const owner = new MarketplaceOwner(
      { listings: [{ ...listing, appId: null }], paid: false },
      null,
    );
    const capabilities = directory(owner);
    await expect(
      capabilities.directory.require(marketplaceBrowse).list({}),
    ).rejects.toThrow();
    capabilities.close();
  });
});
