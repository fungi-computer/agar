import { describe, expect, it, vi } from "vitest";

import { registerCatalog, type AppCommandHandler } from "./commands.js";
import type { AppCommands } from "./commands.js";

describe("registerCatalog", () => {
  it("LAW: one catalog registers each command's metadata and routes its handler", async () => {
    const registered = new Map<string, AppCommandHandler>();
    const definitions: unknown[] = [];
    const released: string[] = [];
    const commands: AppCommands = {
      register: (definition, handler) => {
        definitions.push(definition);
        registered.set(definition.id, handler);
        return Promise.resolve(() => {
          released.push(definition.id);
        });
      },
    };
    const clear = vi.fn(() => "cleared");
    const release = registerCatalog(commands, [
      {
        id: "clear",
        title: "Clear prompt",
        category: "Prompt",
        projections: { slash: { aliases: ["clear"] }, palette: {} },
        availability: () => ({ status: "unavailable", reason: "Empty" }),
        handler: clear,
      },
    ]);
    await vi.waitFor(() => {
      expect(registered.size).toBe(1);
    });
    expect(definitions).toEqual([
      {
        id: "clear",
        title: "Clear prompt",
        category: "Prompt",
        projections: { slash: { aliases: ["clear"] }, palette: {} },
        availability: { status: "unavailable", reason: "Empty" },
      },
    ]);
    const signal = new AbortController().signal;
    await expect(
      registered.get("clear")?.({ origin: "palette", signal }),
    ).resolves.toBe("cleared");
    expect(clear).toHaveBeenCalledWith({ origin: "palette", signal });
    release();
    release();
    expect(released).toEqual(["clear"]);
  });
  it("rejects a non-JSON command result at the host boundary", async () => {
    let registered: AppCommandHandler | undefined;
    registerCatalog(
      {
        register: (_definition, handler) => {
          registered = handler;
          return Promise.resolve(() => undefined);
        },
      },
      [
        {
          id: "invalid-result",
          title: "Invalid result",
          category: "Test",
          handler: () => new Map([["key", "value"]]),
        },
      ],
    );
    await expect(
      registered?.({
        origin: "programmatic",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });
  it("LAW: a replacement catalog registered before the first settles still registers", async () => {
    // The host owns an id from the call to `register` until its disposer runs,
    // and answers a duplicate with "Command registration is unavailable".
    const owned = new Set<string>();
    const live = new Set<string>();
    const commands: AppCommands = {
      register: async (definition) => {
        if (owned.has(definition.id))
          throw new Error("Command registration is unavailable");
        owned.add(definition.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        live.add(definition.id);
        return () => {
          owned.delete(definition.id);
          live.delete(definition.id);
        };
      },
    };
    const catalog = [
      { id: "save", title: "Save", category: "File", handler: () => undefined },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = registerCatalog(commands, catalog);
    first();
    const second = registerCatalog(commands, catalog);
    await vi.waitFor(() => {
      expect(live.has("save")).toBe(true);
    });
    expect(warn).not.toHaveBeenCalled();
    second();
    expect(live.size).toBe(0);
    warn.mockRestore();
  });
});
