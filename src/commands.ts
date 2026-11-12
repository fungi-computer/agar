import { parseJsonValue } from "@fungi.computer/whistle/wire";
import type { Disposer } from "./store.js";
import type {
  WhistleCommand,
  WhistleCommandDefinition,
  WhistleExecutionInput,
  WhistleExecutionOrigin,
  WhistleJsonValue,
} from "@fungi.computer/whistle";

/** Semantic command metadata supplied by an App and owned by Whistle. */
export type AppCommand = WhistleCommandDefinition;

/** One invocation's semantic input; host correlation IDs are private. */
export type AppCommandHandler = (
  invocation: AppCommandInvocation,
) => Promise<WhistleJsonValue | undefined> | WhistleJsonValue | undefined;

/** One command invocation's semantic input, passed to its handler. */
export type AppCommandInvocation = {
  readonly arguments?: WhistleJsonValue;
  readonly origin: WhistleExecutionOrigin;
  readonly signal: AbortSignal;
};

/**
 * Registers a command with the authenticated host for this page session.
 * The promise resolves only after the host accepts the registration.
 */
export type AppCommands = {
  /** Register one command and its handler with the host; resolves once
   * the host accepts it. Call the returned Disposer to unregister. */
  register(command: AppCommand, handler: AppCommandHandler): Promise<Disposer>;
};

/**
 * Each command id's last registration, settled and released if its catalog was.
 * The host keeps one registration per id from the moment `register` is called,
 * so a replacement catalog must wait for the one it replaces to finish
 * releasing; otherwise the host refuses the id and the command is lost.
 */
const lastRegistration = new WeakMap<AppCommands, Map<string, Promise<void>>>();

/**
 * Register one App's Whistle catalog with its host. An App defines each
 * command once, contributes the same catalog to its own composer runtime for
 * slash commands, and registers it here so the shell projects it into the
 * palette, menus, keys and the agent view. Availability is read once at
 * registration; register again to publish a change.
 *
 * @param commands - The App's host command door, `app.commands`.
 * @param catalog - The App's Whistle commands, handlers included.
 * @returns Release every registration made by this call.
 */
export function registerCatalog(
  commands: AppCommands,
  catalog: readonly WhistleCommand<never>[],
): Disposer {
  let released = false;
  const releases: Disposer[] = [];
  for (const command of catalog) {
    const { availability, handler, ...metadata } = command;
    const run: WhistleCommand["handler"] = handler;
    const definition: AppCommand =
      availability === undefined
        ? metadata
        : { ...metadata, availability: availability() };
    const tails =
      lastRegistration.get(commands) ?? new Map<string, Promise<void>>();
    lastRegistration.set(commands, tails);
    const previous = tails.get(command.id);
    const start = () =>
      commands.register(
        definition,
        async ({ arguments: args, origin, signal }) => {
          const input: WhistleExecutionInput =
            args === undefined
              ? { origin, signal }
              : { arguments: args, origin, signal };
          const result = await run(input);
          return result === undefined ? undefined : parseJsonValue(result);
        },
      );
    const settled = (previous ? previous.then(start) : start()).then(
      (release) => {
        if (released) release();
        else releases.push(release);
      },
      (cause: unknown) => {
        console.warn(`App command ${command.id} was not registered`, cause);
      },
    );
    tails.set(command.id, settled);
    void settled.finally(() => {
      if (tails.get(command.id) === settled) tails.delete(command.id);
    });
  }
  return () => {
    if (released) return;
    released = true;
    for (const release of releases.splice(0)) release();
  };
}
