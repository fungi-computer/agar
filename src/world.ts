/** Public MCP world-seat vocabulary, independent of any engine or host. */
export const worldToolNames = Object.freeze({
  observe: "world_observe",
  command: "world_command",
  explain: "world_explain",
  say: "world_say",
  snapshot: "world_snapshot",
  advance: "world_advance",
} as const);

export const worldMcpManifest = Object.freeze({
  id: "world-mcp-v1",
  module: "world",
  tools: Object.freeze(
    Object.fromEntries(
      Object.entries(worldToolNames).map(([operation, name]) => [
        name,
        operation,
      ]),
    ),
  ),
});
