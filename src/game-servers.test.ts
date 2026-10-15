import { expect, it } from "vitest";
import { gameServerSizes } from "./game-servers.js";

it("offers Project Zomboid Squad as its default 8 GB size", () => {
  expect(gameServerSizes["project-zomboid"].squad).toEqual({
    memoryMiB: 8_192,
    vcpuCount: 2,
  });
});
