import { applyTheme, getTheme } from "@fungi.computer/stipe/theme";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createElement, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { connectApp } from "./connect.js";
import { AppError } from "./errors.js";
import type { AppRoot } from "./root.js";
import type { Disposer } from "./store.js";

/** The App connection state passed to `mountApp`'s `render` callback:
 * `live` once connected, or `connecting`/`standalone`/`ended` while there
 * is no usable App. */
export type AppMountState = Readonly<
  | { app: AppRoot; status: "live" }
  | { app: null; status: "connecting" | "standalone" | "ended" }
>;

/** Options passed to `mountApp`. */
export type AppMountOptions = Readonly<{
  /** App name used when reporting a failed host connection. */
  name: string;
  /** The caller owns the cache and its query policy. */
  queryClient?: QueryClient;
}>;

/** Own this page's React root, authenticated App connection and host theme. */
export function mountApp(
  element: HTMLElement,
  options: AppMountOptions,
  render: (state: AppMountState) => ReactNode,
): Disposer {
  element.style.isolation = "isolate";
  const root = createRoot(element);
  const controller = new AbortController();
  const themeRoot = element.ownerDocument.documentElement;
  const previousTheme = getTheme(themeRoot);
  let mounted: AppRoot | undefined;
  let releaseTheme: Disposer | undefined;
  let releaseLifecycle: Disposer | undefined;
  let themed = false;
  const publish = (state: AppMountState) => {
    const view = createElement(AppView, { state, render });
    root.render(
      options.queryClient
        ? createElement(
            QueryClientProvider,
            { client: options.queryClient },
            view,
          )
        : view,
    );
  };
  const releaseConnection = () => {
    releaseLifecycle?.();
    releaseLifecycle = undefined;
    releaseTheme?.();
    releaseTheme = undefined;
    const connection = mounted;
    mounted = undefined;
    connection?.dispose();
    if (themed) {
      if (previousTheme === null) themeRoot.removeAttribute("data-theme");
      else applyTheme(previousTheme, themeRoot);
      themed = false;
    }
  };
  const { referrer, defaultView } = element.ownerDocument;
  performance.mark("fungi.app-open.react-root-render-start");
  if (
    !defaultView ||
    defaultView.parent === defaultView ||
    !URL.canParse(referrer)
  ) {
    publish({ app: null, status: "standalone" });
  } else {
    publish({ app: null, status: "connecting" });
    void connectApp({
      expectedHostOrigin: new URL(referrer).origin,
      signal: controller.signal,
    })
      .then((app) => {
        if (controller.signal.aborted) {
          app.dispose();
          return;
        }
        mounted = app;
        const onLifecycle = () => {
          const state = app.lifecycle.get();
          if (
            state === "disposing" ||
            state === "disconnected" ||
            state === "disposed"
          ) {
            releaseConnection();
            publish({ app: null, status: "ended" });
            return true;
          }
          return false;
        };
        releaseLifecycle = app.lifecycle.subscribe(onLifecycle);
        if (onLifecycle()) return;
        themed = true;
        applyTheme(app.theme.get(), themeRoot);
        releaseTheme = app.theme.subscribe((theme) => {
          applyTheme(theme, themeRoot);
        });
        publish({ app, status: "live" });
      })
      .catch((cause: unknown) => {
        if (
          controller.signal.aborted &&
          cause instanceof AppError &&
          cause.code === "CANCELLED"
        )
          return;
        console.error(`${options.name} host connection failed`, cause);
        releaseConnection();
        if (!controller.signal.aborted) publish({ app: null, status: "ended" });
      });
  }
  return () => {
    if (controller.signal.aborted) return;
    controller.abort();
    root.unmount();
    releaseConnection();
  };
}

function AppView({
  state,
  render,
}: {
  state: AppMountState;
  render: (state: AppMountState) => ReactNode;
}): ReactNode {
  useLayoutEffect(() => {
    performance.mark("fungi.app-open.react-initial-commit");
  }, []);
  useLayoutEffect(() => {
    if (state.app) performance.mark("fungi.app-open.react-connected-commit");
  }, [state.app]);
  return render(state);
}
