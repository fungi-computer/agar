import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  createWhistle,
  type WhistleContribution,
  type WhistleRuntime,
} from "@fungi.computer/whistle";
import { registerCatalog } from "./commands.js";
import { AppError } from "./errors.js";
import type { AppBackHandler, HostNavigation } from "./window.js";

import type { AppContext } from "./lifecycle.js";
import type { AppStatusActionHandler, AppStatusItem } from "./ui.js";
import type { AppRoot } from "./root.js";
import type { ReadonlyStore } from "./store.js";

export { mountApp } from "./react-mount.js";
export type { AppMountOptions, AppMountState } from "./react-mount.js";

/** Read an SDK snapshot and release its subscription when the store changes. */
export function useStore<T>(
  store: ReadonlyStore<T> | undefined,
): T | undefined {
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => undefined),
    [store],
  );
  const snapshot = useCallback(() => store?.get(), [store]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Read the App's live context (focus, visibility, Computer selection, any
 * pending open request), or null while there is no connected App. */
export function useAppContext(
  app: AppRoot | null | undefined,
): AppContext | null {
  return useStore(app?.context) ?? null;
}

/** Read the id of the Computer currently selected for this App, or null
 * when no App is connected or no Computer is selected yet. */
export function useComputerId(app: AppRoot | null | undefined): string | null {
  return useAppContext(app)?.computerId ?? null;
}

/**
 * Keep this window's status bar items current in the host while mounted, and
 * hear the person use them. Items compare by value; the bar clears on unmount.
 */
export function useWindowStatus(
  app: Pick<AppRoot, "ui"> | null | undefined,
  items: readonly AppStatusItem[],
  onAction?: AppStatusActionHandler,
  /** Hear a report the host refused, so the App can say so. */
  onReportFailure?: (cause: unknown) => void,
): void {
  const latest = useRef(items);
  latest.current = items;
  const handler = useRef(onAction);
  handler.current = onAction;
  const failed = useRef(onReportFailure);
  failed.current = onReportFailure;
  const key = JSON.stringify(items);
  const listening = onAction !== undefined;
  useEffect(() => {
    if (!app) return;
    void app.ui.reportStatus(latest.current).catch((cause: unknown) => {
      if (failed.current) failed.current(cause);
      else console.error("Window status report failed", cause);
    });
  }, [app, key]);
  useEffect(() => {
    if (!app || !listening) return;
    return app.ui.onStatusAction(
      (action) => handler.current?.(action) ?? false,
    );
  }, [app, listening]);
  useEffect(
    () => () => {
      void app?.ui.reportStatus([]).catch((cause: unknown) => {
        console.error("Window status report failed", cause);
      });
    },
    [app],
  );
}

/**
 * Own one catalog's local slash runtime and host registrations. Memoize `build`
 * with useCallback; changing it replaces the catalog and its availability.
 */
export function useAppCommandCatalog(
  app: AppRoot | null | undefined,
  { sourceId, namespace }: Pick<WhistleContribution, "sourceId" | "namespace">,
  build: () => WhistleContribution["commands"],
): WhistleRuntime {
  const runtime = useMemo(() => createWhistle(), []);
  const catalog = useMemo(build, [build]);
  useEffect(() => {
    const lease = runtime.contribute({
      sourceId,
      namespace,
      commands: catalog,
    });
    return () => {
      lease.dispose();
    };
  }, [runtime, sourceId, namespace, catalog]);
  useEffect(
    () => (app ? registerCatalog(app.commands, catalog) : undefined),
    [app, catalog],
  );
  return runtime;
}

/** What an App's router can do now, and how it goes back. */
export type HostNavigationOptions = Readonly<{
  canGoBack: boolean;
  /** The current page's title, shown after the App name in window chrome. */
  title?: string | undefined;
  onBack: AppBackHandler;
}>;

/**
 * Publish an App's navigation state to its host and own the host's Back
 * requests while mounted. Pass `app?.window.navigation`; with no connected
 * App it does nothing. Unmounting withdraws Back from the host chrome.
 */
export function useHostNavigation(
  navigation: HostNavigation | null | undefined,
  { canGoBack, title, onBack }: HostNavigationOptions,
): void {
  const latestBack = useRef(onBack);
  useEffect(() => {
    latestBack.current = onBack;
  }, [onBack]);

  useEffect(() => {
    if (!navigation) return undefined;
    const release = navigation.onBack(() => latestBack.current());
    return () => {
      release();
      report(navigation, { canGoBack: false });
    };
  }, [navigation]);

  // Each change replaces the last report; only unmount withdraws Back.
  useEffect(() => {
    if (!navigation) return;
    report(
      navigation,
      title === undefined ? { canGoBack } : { canGoBack, title },
    );
  }, [navigation, canGoBack, title]);
}

function report(
  navigation: HostNavigation,
  state: Parameters<HostNavigation["publish"]>[0],
): void {
  navigation.publish(state).catch((cause: unknown) => {
    // A closing App has no host left to tell; anything else is a real fault.
    if (cause instanceof AppError && cause.code === "DISCONNECTED") return;
    console.warn("App navigation report failed", cause);
  });
}
