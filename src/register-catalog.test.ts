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
});
