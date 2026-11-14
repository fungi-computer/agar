import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { computerList, type ComputerListing } from "./computer.js";
import { capabilityQuery, queryKeys } from "./query.js";
import { useComputerId } from "./react.js";
import type { AppRoot } from "./root.js";

/**
 * Dot-entries (`.fungi`, `.git`, `.bash_history`) are internal state, so a
 * Computer tree leaves them out the way file managers do. Files and folders the
 * person named stay.
 */
export function isHiddenEntry(entry: { name: string; type: string }): boolean {
  return entry.name.startsWith(".");
}

/** One scoped, hidden-entry-free directory page of the admitted Computer. */
export function directoryQuery(app: AppRoot | null, path: string, offset = 0) {
  return capabilityQuery(
    app,
    computerList,
    queryKeys.of(app, "tree", app?.capabilities.version ?? 0, path, offset),
    async (handle, signal) => {
      const listing = await handle.list({ path, offset, limit: 256 });
      signal.throwIfAborted();
      return {
        ...listing,
        entries: listing.entries.filter((entry) => !isHiddenEntry(entry)),
      };
    },
  );
}

/**
 * The part of a native tree model this module writes. It is structural so an
 * App passes its own tree library's model and agar depends on none.
 */
export type ComputerTreeModel = Readonly<{
  batch(operations: { type: "add"; path: string }[]): void;
  getItem(path: string): object | null | undefined;
  remove(path: string, options?: { recursive?: boolean }): void;
  resetPaths(paths: string[]): void;
}>;

/** What a tree remembers between listings so each page is merged once. */
export type ComputerTreeSyncState = Readonly<{
  known: Set<string>;
  projected: Map<string, readonly string[]>;
}>;

export function createComputerTreeSyncState(): ComputerTreeSyncState {
  return { known: new Set(), projected: new Map() };
}

/** Forget every listing and empty the model, so the next sync rebuilds it. */
export function resetComputerTree(
  model: ComputerTreeModel,
  state: ComputerTreeSyncState,
): void {
  state.known.clear();
  state.projected.clear();
  model.resetPaths([]);
}

/**
 * Project every loaded listing page into the native model: rows a re-read page
 * no longer lists are removed with their subtree, then the page is merged.
 */
export function syncComputerTree(
  model: ComputerTreeModel,
  listings: readonly {
    request: Readonly<{ path: string; offset: number }> | undefined;
    listing: ComputerListing;
  }[],
  state: ComputerTreeSyncState,
): void {
  if (listings.length === 0) resetComputerTree(model, state);
  for (const { request, listing } of listings) {
    const pageKey = `${request?.path ?? listing.path}:${String(request?.offset ?? 0)}`;
    const paths = listing.entries
      .filter((entry) => entry.type !== "symlink")
      .map((entry) => entryPath(listing.path, entry.name, entry.type));
    const previous = state.projected.get(pageKey) ?? [];
    state.projected.set(pageKey, paths);
    const retained = new Set([...state.projected.values()].flat());
    for (const path of previous) {
      if (retained.has(path)) continue;
      if (model.getItem(path)) model.remove(path, { recursive: true });
      for (const known of state.known) {
        if (known === path || (path.endsWith("/") && known.startsWith(path)))
          state.known.delete(known);
      }
    }
    mergeListing(model, listing, state.known);
  }
}

/** A tree path: directories end in a slash, as the native tree models spell them. */
export function entryPath(
  directory: string,
  name: string,
  type: string,
): string {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return `${prefix}${name}${type === "directory" ? "/" : ""}`;
}

/** Merge one server listing into the native model without repeating paths. */
export function mergeListing(
  model: ComputerTreeModel,
  result: ComputerListing,
  knownPaths: Set<string>,
): readonly string[] {
  const paths = result.entries
    .filter((entry) => entry.type !== "symlink")
    .map((entry) => entryPath(result.path, entry.name, entry.type));
  // The model also holds rows added outside a listing (a just-created file);
  // adding one again throws, so the model itself is the final word.
  const additions = paths.filter(
    (path) => !knownPaths.has(path) && !model.getItem(path),
  );
  if (additions.length > 0)
    model.batch(additions.map((path) => ({ type: "add", path })));
  knownPaths.add(result.path);
  for (const path of paths) knownPaths.add(path);
  return additions;
}

/** The directories to list so `path` is visible under `rootPath`, root first. */
export function revealParents(
  path: string,
  rootPath: string,
): readonly string[] {
  const root = rootPath === "/" ? "/" : rootPath.replace(/\/+$/, "");
  if (root !== "/" && path !== root && !path.startsWith(`${root}/`)) return [];
  const relative =
    root === "/"
      ? path.split("/").filter(Boolean)
      : path.slice(root.length).split("/").filter(Boolean);
  const parents = [root];
  let parent = root;
  for (const segment of relative.slice(0, -1)) {
    parent = `${parent === "/" ? "" : parent}/${segment}`;
    parents.push(parent);
  }
  return parents;
}

type PageRequest = Readonly<{ path: string; offset: number }>;

/**
 * Per-directory paging of the admitted Computer's listing: the root and the
 * parents of the active path load first, and `requestPage` adds a further page
 * of one directory. The result is reset when the Computer, root or granted
 * capabilities change.
 */
export function useComputerTreePages({
  app,
  rootPath,
  activePath,
}: {
  app: AppRoot;
  rootPath: string;
  activePath: string | null;
}) {
  const client = useQueryClient();
  const computerId = useComputerId(app);
  const subscribe = useCallback(
    (listener: () => void) => app.capabilities.subscribe(listener),
    [app],
  );
  const getVersion = useCallback(() => app.capabilities.version, [app]);
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  const scope = useMemo(
    () => ({ app, rootPath, computerId, version }),
    [app, rootPath, computerId, version],
  );
  const [selection, setSelection] = useState<{
    scope: typeof scope;
    activePath: string | null;
    path: string;
    pages: readonly PageRequest[];
  } | null>(null);
  const current = selection?.scope === scope ? selection : null;
  const parents = activePath ? revealParents(activePath, rootPath) : [];
  const focusedPath =
    current?.activePath === activePath
      ? current.path
      : (parents.at(-1) ?? rootPath);
  const requests = new Map<string, PageRequest>();
  for (const path of [rootPath, ...parents])
    requests.set(`${path}:0`, { path, offset: 0 });
  for (const request of current?.pages ?? [])
    requests.set(`${request.path}:${String(request.offset)}`, request);
  const pages = [...requests.values()];
  const key = (path: string, offset: number) =>
    queryKeys.of(app, "tree", version, path, offset);
  const snapshot = useQueries({
    queries: pages.map(({ path, offset }) => directoryQuery(app, path, offset)),
    combine: (results) => ({
      listings: results.flatMap((result, index) =>
        result.data ? [{ request: pages[index], listing: result.data }] : [],
      ),
      busy: results.some((result) => result.isFetching),
      failure: results.find((result) => result.error)?.error ?? null,
    }),
  });
  const requestPage = (path: string, offset: number) => {
    const directory = path.replace(/\/+$/, "") || "/";
    const pageKey = key(directory, offset);
    if (client.getQueryState(pageKey)?.status === "error") {
      void client.invalidateQueries({ queryKey: pageKey, exact: true });
    }
    setSelection((previous) => ({
      scope,
      activePath,
      path: directory,
      pages: [
        ...(previous?.scope === scope
          ? previous.pages.filter(
              (page) => page.path !== directory || page.offset !== offset,
            )
          : []),
        { path: directory, offset },
      ],
    }));
  };
  const reload = () => {
    void client.invalidateQueries({
      queryKey: queryKeys.of(app, "tree", version),
    });
  };
  return { scope, snapshot, focusedPath, requestPage, reload };
}
