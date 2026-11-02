import { describe, expect, mock, test } from "bun:test";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { messagesFor } from "@/shared/i18n";

/**
 * Routing regression pins for the /admin/places parent route.
 *
 * The parent registers the /admin/places/$placeId child, so it must yield
 * to <Outlet/> whenever a child matches — mirroring src/routes/admin.dishes.tsx.
 * Without that guard the new/edit child can never paint.
 *
 * SSR-only and deterministic: the route module's router dependency is stubbed
 * via mock.module before import and only Route.component renders — the loader
 * and beforeLoad never run. No DB, no network.
 */

let childMatches: ReadonlyArray<{ readonly id: string }> = [];

interface StubRoute {
  readonly component: () => ReactNode;
  readonly fullPath: string;
  readonly options: {
    readonly component: () => ReactNode;
  };
  readonly useSearch: () => {
    readonly kind: string;
    readonly page: number;
    readonly parentId: string;
    readonly query: string;
  };
  readonly useLoaderData: () => {
    readonly items: ReadonlyArray<never>;
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
  };
}

void mock.module("@tanstack/react-router", () => ({
  createFileRoute:
    (path: string) =>
    (options: { readonly component: () => ReactNode }): StubRoute => ({
      component: options.component,
      options: { component: options.component },
      fullPath: path,
      useSearch: () => ({ query: "", kind: "", parentId: "", page: 1 }),
      useLoaderData: () => ({ items: [], total: 0, page: 0, pageSize: 20 }),
    }),
  getRouteApi: () => ({ useSearch: () => ({ lang: "en" as const }) }),
  redirect: () => {
    throw new Error("redirect must not run in routing tests");
  },
  Link: (props: { readonly children?: ReactNode }) => createElement("a", null, props.children),
  Outlet: () => createElement("span", { "data-testid": "child-outlet" }, "child-outlet-marker"),
  useChildMatches: () => childMatches,
  useNavigate: () => () => undefined,
  useRouter: () => ({ invalidate: () => undefined }),
  // @tanstack/react-start's useServerFn links against isRedirect at import
  // time; the server functions themselves never execute in these tests.
  isRedirect: () => false,
}));

const { Route } = await import("@/routes/admin.places");

const renderRoute = (): string => {
  const component = Route.options.component;

  if (component === undefined) {
    throw new Error("admin.places route must define a component");
  }

  return renderToStaticMarkup(createElement(component));
};

describe("admin places parent routing", () => {
  test("no child match renders the listing, not the outlet", () => {
    childMatches = [];
    const html = renderRoute();
    const copy = messagesFor("en");

    expect(html).toContain(copy.adminPlaces);
    expect(html).toContain(copy.adminSearchPlaces);
    expect(html).not.toContain("child-outlet-marker");
  });

  test("child match renders the outlet instead of the listing", () => {
    childMatches = [{ id: "admin-places-$placeId" }];
    const html = renderRoute();
    const copy = messagesFor("en");

    expect(html).toContain("child-outlet-marker");
    expect(html).not.toContain(copy.adminSearchPlaces);
  });
});
