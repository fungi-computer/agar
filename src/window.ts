import type { Disposer } from "./store.js";

/** Consulted before the person closes the App's window; return (or
 * resolve) `true` to allow the close. */
export type BeforeAppClose = () => boolean | Promise<boolean>;

/**
 * Version of the navigation contract an App publishes. The host rejects any
 * other version, so a future shape can never be misread as this one.
 */
export const APP_NAVIGATION_CONTRACT_VERSION = 1 as const;

/** The longest page title a host shows beside the App's own name. */
export const APP_NAVIGATION_TITLE_MAX = 80;

/** The most crumbs one navigation report may carry. */
export const APP_NAVIGATION_CRUMBS_MAX = 8;
/** The most siblings one switcher crumb may offer. */
export const APP_NAVIGATION_SIBLINGS_MAX = 16;
/** The most primary header commands one report may carry. */
export const APP_NAVIGATION_PRIMARY_MAX = 3;
/** The most header status facts one report may carry. */
export const APP_NAVIGATION_STATUS_MAX = 4;
/** The most ⋯ menu commands one report may carry. */
export const APP_NAVIGATION_MENU_MAX = 12;
/** The longest crumb or command label a host shows. */
export const APP_NAVIGATION_LABEL_MAX = 80;

/** One place in the App's path; `siblings` makes it a switcher. */
export type AppCrumb = Readonly<{
  id: string;
  label: string;
  siblings?: readonly Readonly<{ id: string; label: string }>[];
}>;

/** A command the App offers in its window header; the App owns its effect. */
export type AppHeaderCommand = Readonly<{
  id: string;
  label: string;
  /** Supported icon-only presentation; label remains the accessible name. */
  icon?: "play";
  /** The Caps button a primary command wears; default `outline`. */
  variant?: "primary" | "outline" | "ghost";
  /** A menu command that removes or discards something. */
  tone?: "destructive";
  disabled?: boolean;
}>;

/** A quiet fact about the view, shown as muted text with a status bead. */
export type AppHeaderStatus = Readonly<{
  id: string;
  label: string;
  /** Show the bead alone, with label retained as accessible text and a hint. */
  presentation?: "bead";
  tone?: "neutral" | "info" | "warning" | "success" | "error";
}>;

/** The person used a crumb (or a switcher's sibling) or a header command. */
export type AppNavigationActivation =
  | Readonly<{ kind: "crumb"; crumbId: string; siblingId?: string }>
  | Readonly<{ kind: "action"; actionId: string }>;

/** Handles one activation; `true` when the App acted on it. */
export type AppNavigationActivationHandler = (
  activation: AppNavigationActivation,
) => boolean | Promise<boolean>;

/**
 * What the App's own router can do right now. The App owns its history; the
 * host only offers a Back affordance and relays the person's request.
 */
export type AppNavigationState = Readonly<{
  canGoBack: boolean;
  /** The current page's title, shown after the App name in window chrome. */
  title?: string;
  /** The App's path; the host shows it in place of the App name and title. */
  crumbs?: readonly AppCrumb[];
  /** The view's main commands, as buttons in the header. */
  primary?: readonly AppHeaderCommand[];
  /** Less common commands, behind the header's overflow menu. */
  menu?: readonly AppHeaderCommand[];
  /** Facts about the view, such as "Valid" or "Saved". Data only. */
  status?: readonly AppHeaderStatus[];
}>;

/** Go back one step in the App's own history; `true` when it moved. */
export type AppBackHandler = () => boolean | Promise<boolean>;

/** The App's half of the host navigation contract. */
export type HostNavigation = Readonly<{
  /** Report the latest navigation state; the newest report wins. */
  publish(state: AppNavigationState): Promise<void>;
  /** Own the host's Back requests; one owner at a time. */
  onBack(handler: AppBackHandler): Disposer;
  /** Own the host's crumb and command activations; one owner at a time. */
  onActivate(handler: AppNavigationActivationHandler): Disposer;
}>;

/** App-owned presentation policy consulted before a user closes its window. */
export type AppWindow = Readonly<{
  /** Register a close-guard handler; one owner at a time. Call the
   * returned Disposer to withdraw it. */
  onBeforeClose(handler: BeforeAppClose): Disposer;
  navigation: HostNavigation;
}>;

/**
 * Navigation for a root with no host chrome, such as a workbench fixture: it
 * accepts every report and never asks the App to go back.
 */
export const inertHostNavigation: HostNavigation = Object.freeze({
  publish: () => Promise.resolve(),
  onBack: () => () => undefined,
  onActivate: () => () => undefined,
});

/**
 * Whether an activation names something the App published now: a crumb (and
 * its sibling), or an enabled command. Every hop applies this rule against
 * its own latest copy of the report, so a stale shell cannot reach the App.
 */
export function navigationActivationAllowed(
  state: AppNavigationState,
  activation: AppNavigationActivation,
): boolean {
  if (activation.kind === "action") {
    const command = [...(state.primary ?? []), ...(state.menu ?? [])].find(
      (candidate) => candidate.id === activation.actionId,
    );
    return command !== undefined && command.disabled !== true;
  }
  const crumb = state.crumbs?.find(
    (candidate) => candidate.id === activation.crumbId,
  );
  if (crumb === undefined) return false;
  if (activation.siblingId === undefined) return true;
  return (
    crumb.siblings?.some((sibling) => sibling.id === activation.siblingId) ===
    true
  );
}
