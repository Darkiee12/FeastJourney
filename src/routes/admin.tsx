import { Link, Outlet, createFileRoute, getRouteApi } from "@tanstack/react-router";

import { messagesFor } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

/**
 * Feast Lab shell: the capability-gated sections already live in the
 * primary navbar (`__root.tsx`, driven by the shared `adminNavEntries`
 * source of truth in components/admin/ui), so this shell renders no second
 * nav bar — just the workspace container and the active section. Every
 * admin route still enforces its own server authorization; the menu is
 * never a security boundary.
 *
 * Catalog section nav (Dishes | Places): a local secondary nav until the
 * coordinator extends the shared `adminNavEntries` union in
 * components/admin/ui (a file outside this workstream's ownership) with a
 * `/admin/places` entry and the matching capability. Kept deliberately
 * minimal so the global nav stays the single source of truth.
 */
function AdminLayout() {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);

  return (
    <div className="mx-auto w-full min-w-0 max-w-[84rem] px-5 py-8 sm:px-8">
      <nav
        aria-label={lang === "vi" ? "Danh mục" : "Catalog"}
        className="mb-4 flex min-w-0 flex-wrap gap-2"
      >
        <Link
          to="/admin/dishes"
          search={{ lang, status: "review", cursor: "0" }}
          activeOptions={{ exact: false }}
          activeProps={{ "aria-current": "page" }}
          className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border-soft bg-white px-4 text-sm font-semibold text-ink hover:bg-cream aria-[current=page]:border-food-orange aria-[current=page]:bg-cream aria-[current=page]:font-bold aria-[current=page]:text-food-orange-dark"
        >
          {copy.adminDishes}
        </Link>
        <Link
          to="/admin/places"
          search={{ lang, query: "", kind: "", parentId: "", page: 1 }}
          activeOptions={{ exact: false }}
          activeProps={{ "aria-current": "page" }}
          className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border-soft bg-white px-4 text-sm font-semibold text-ink hover:bg-cream aria-[current=page]:border-food-orange aria-[current=page]:bg-cream aria-[current=page]:font-bold aria-[current=page]:text-food-orange-dark"
        >
          {copy.adminPlaces}
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
