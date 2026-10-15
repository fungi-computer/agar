import type { CapabilityDirectory } from "./capabilities.js";
import type { AppCommands } from "./commands.js";
import type { AppContext, AppIdentity, AppLifecycle } from "./lifecycle.js";
import type { ReadonlyStore } from "./store.js";
import type { HostUi } from "./ui.js";
import type { AppWindow } from "./window.js";

/** The App's live connection to its host: its admitted capabilities,
 * commands, context, theme, UI door and window, all torn down together
 * by `dispose`. Returned by `connectApp` and passed to `mountApp`. */
export type AppRoot = {
  readonly capabilities: CapabilityDirectory;
  readonly commands: AppCommands;
  readonly context: ReadonlyStore<AppContext>;
  /** End this App's connection to its host and release everything it owns. */
  dispose(): void;
  readonly identity: Readonly<AppIdentity>;
  readonly lifecycle: ReadonlyStore<AppLifecycle>;
  readonly theme: ReadonlyStore<string>;
  readonly ui: HostUi;
  readonly window: AppWindow;
};
