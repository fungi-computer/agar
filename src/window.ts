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

/**
 * What the App's own router can do right now. The App owns its history; the
 * host only offers a Back affordance and relays the person's request.
 */
export type AppNavigationState = Readonly<{
  canGoBack: boolean;
  /** The current page's title, shown after the App name in window chrome. */
  title?: string;
}>;

/** Go back one step in the App's own history; `true` when it moved. */
export type AppBackHandler = () => boolean | Promise<boolean>;

/** The App's half of the host navigation contract. */
export type HostNavigation = Readonly<{
  /** Report the latest navigation state; the newest report wins. */
  publish(state: AppNavigationState): Promise<void>;
  /** Own the host's Back requests; one owner at a time. */
  onBack(handler: AppBackHandler): Disposer;
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
});
