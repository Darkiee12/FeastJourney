import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  redirect,
  stripSearchParams,
  useMatches,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { AccountMenu } from "@/components/account-menu";
import { adminNavEntries, isAdminRouteMatch } from "@/components/admin/ui";
import { LanguageMenu } from "@/components/language-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resolveInitialLocaleFn } from "@/modules/food-discovery/quiz.functions";
import { adminCapabilitiesFn, NO_ADMIN_CAPABILITIES } from "@/modules/user/admin.functions";
import { getSessionStateFn } from "@/modules/user/session.functions";
import {
  bcp47TagFor,
  detectBrowserLocale,
  hasExplicitLocaleChoice,
  localeSearchSchema,
  messagesFor,
} from "@/shared/i18n";

import stylesheet from "@/styles.css?url";

export const Route = createRootRoute({
  validateSearch: localeSearchSchema,
  search: { middlewares: [stripSearchParams({ lang: "en" })] },
  beforeLoad: async () => {
    // Server-side initial locale (first load only): resolve saved > trusted
    // geo > browser > default inside the server function and redirect once,
    // so the first paint already speaks the right language. All
    // `@tanstack/react-start/server` access stays inside that function's
    // handler — this route never imports the server module, keeping the
    // client bundle clean. An explicit `?lang` never redirects.
    if (typeof window === "undefined") {
      const { href } = await resolveInitialLocaleFn();

      if (href !== null) {
        throw redirect({ href });
      }
    }

    const session = await getSessionStateFn();

    if (session.status !== "signed-in") {
      return { session, isAdmin: false as const, capabilities: NO_ADMIN_CAPABILITIES };
    }

    const { capabilities } = await adminCapabilitiesFn();

    return { session, isAdmin: capabilities.admin, capabilities };
  },
  head: ({ match }) => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: messagesFor(match.search.lang).title },
      {
        name: "description",
        content: messagesFor(match.search.lang).description,
      },
    ],
    links: [
      { rel: "stylesheet", href: stylesheet },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Bangers&display=swap",
      },
    ],
  }),
  shellComponent: Document,
  component: AppLayout,
});

function Document({ children }: { children: ReactNode }) {
  const { lang } = Route.useSearch();

  return (
    <html lang={bcp47TagFor(lang)} className="scroll-smooth motion-reduce:scroll-auto">
      <head>
        <HeadContent />
      </head>
      <body className="bg-cream font-body text-ink antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function AppLayout() {
  const { lang } = Route.useSearch();
  const { session, capabilities } = Route.useRouteContext();
  const copy = messagesFor(lang);
  const navigate = useNavigate();
  const [queryClient] = useState(() => new QueryClient());

  // Feast Lab mode: derived from TanStack Router's matched route ids, not
  // from pathname parsing, so locale search params can never fool it. The
  // entries themselves come from the single shared source of truth in
  // components/admin/ui (same list the admin shell renders), gated by the
  // server-verified capabilities already in route context.
  const routeIds = useMatches().map((match) => match.routeId);
  const adminMode = isAdminRouteMatch(routeIds);
  const adminEntries = adminMode ? adminNavEntries(capabilities, copy) : [];

  const currentAdminEntry = adminEntries
    .toReversed()
    .find((entry) =>
      entry.exact
        ? routeIds.includes(entry.to) && !routeIds.some((routeId) => routeId.startsWith("/admin/"))
        : routeIds.some((routeId) => routeId === entry.to || routeId.startsWith(`${entry.to}/`)),
    );

  // First visit only: default to the browser's language when it is a fully
  // translated UI locale. Manual picks are remembered and never overridden;
  // an explicit ?lang= URL wins over detection.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (hasExplicitLocaleChoice()) {
      return;
    }

    if (new URLSearchParams(window.location.search).has("lang")) {
      return;
    }

    const detected = detectBrowserLocale();

    if (detected !== null && detected !== lang) {
      void navigate({
        to: ".",
        search: (previous) => ({ ...previous, lang: detected }),
        replace: true,
      });
    }
    // Mount-only default: reacting to later changes would fight the menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <a
        href="#main"
        className="fixed top-4 left-4 z-[60] -translate-y-[300%] rounded-md bg-white p-4 font-bold text-ink focus:translate-y-0"
      >
        {copy.skipContent}
      </a>

      <div className="app-shell flex min-h-dvh flex-col">
        <header className="site-header sticky top-0 z-50 border-b border-white/10 bg-space-deep">
          {/* Compact single-row app bar: never wraps, even on 320px phones.
              Public links collapse into a Menu entry below 480px; account and
              language controls stay reachable but shrink-proof. */}
          <div className="mx-auto flex max-w-7xl flex-nowrap items-center gap-x-1 px-3 py-2.5 min-[480px]:gap-x-2 min-[480px]:px-4 sm:px-6">
            <Link
              to="/"
              search={{ lang }}
              aria-label={copy.homeLabel}
              className="font-display mr-auto flex min-w-0 flex-none items-center gap-2 text-xl leading-none tracking-wide text-white no-underline min-[480px]:gap-3 min-[480px]:text-2xl md:text-3xl"
            >
              <img
                src="/applogo.png"
                alt=""
                width={64}
                height={64}
                fetchPriority="high"
                className="block h-7 w-auto flex-none object-contain min-[480px]:h-8 md:h-10"
              />
              <span className="truncate">FeastJourney</span>
            </Link>

            <nav
              aria-label={adminMode ? copy.adminNavSectionsLabel : "FeastJourney"}
              className="flex flex-none items-center gap-1"
            >
              {adminMode ? (
                <>
                  <ul className="hidden items-center gap-1 md:flex">
                    {adminEntries.map((entry) => (
                      <li key={entry.to} className="shrink-0">
                        <Link
                          to={entry.to}
                          search={{ lang }}
                          activeOptions={{ exact: entry.exact }}
                          activeProps={{ "aria-current": "page" }}
                          className="inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold text-white/85 no-underline hover:bg-white/10 hover:text-white aria-[current=page]:bg-white/10 aria-[current=page]:text-white"
                        >
                          {entry.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={copy.adminNavSectionsLabel}
                      className="inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm font-semibold text-white/85 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white md:hidden"
                    >
                      {currentAdminEntry?.label ?? copy.adminWorkspace}
                      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4">
                        <path
                          d="M4 6l4 4 4-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {adminEntries.map((entry) => (
                        <DropdownMenuItem key={entry.to} asChild>
                          <Link
                            to={entry.to}
                            search={{ lang }}
                            activeOptions={{ exact: entry.exact }}
                            activeProps={{ "aria-current": "page" }}
                          >
                            {entry.label}
                            {currentAdminEntry?.to === entry.to ? (
                              <span className="sr-only">{copy.adminNavCurrent}</span>
                            ) : null}
                          </Link>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : (
                <>
                  <Link
                    to="/"
                    search={{ lang }}
                    hash="discover"
                    resetScroll={false}
                    className="hidden min-h-11 flex-none items-center rounded-full px-3 text-sm font-semibold whitespace-nowrap text-white/85 no-underline hover:bg-white/10 hover:text-white min-[480px]:inline-flex"
                  >
                    {copy.navDiscover}
                  </Link>
                  <Link
                    to="/"
                    search={{ lang }}
                    hash="recommend"
                    resetScroll={false}
                    className="hidden min-h-11 flex-none items-center rounded-full px-3 text-sm font-semibold whitespace-nowrap text-white/85 no-underline hover:bg-white/10 hover:text-white min-[480px]:inline-flex"
                  >
                    {copy.ctaRecommend}
                  </Link>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger className="inline-flex min-h-11 flex-none items-center rounded-full px-3 text-sm font-semibold text-white/85 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-white min-[480px]:hidden">
                      Menu
                      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4">
                        <path
                          d="M4 6l4 4 4-4"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem asChild>
                        <Link to="/" search={{ lang }} hash="discover" resetScroll={false}>
                          {copy.navDiscover}
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link to="/" search={{ lang }} hash="recommend" resetScroll={false}>
                          {copy.ctaRecommend}
                        </Link>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </nav>

            <div className="flex flex-none items-center gap-0.5 min-[480px]:gap-1">
              <AccountMenu />
              <LanguageMenu />
            </div>
          </div>
        </header>

        {session.status === "unavailable" ? (
          <p
            role="note"
            className="border-b border-mango/40 bg-cream px-4 py-2 text-center text-sm font-semibold text-ink"
          >
            {copy.saveDishPaused}
          </p>
        ) : null}

        <main id="main" tabIndex={-1} className="flex-1">
          <Outlet />
        </main>

        <footer className="site-footer bg-space-deep text-muted-on-dark">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-6 py-5 text-sm">
            <span>{copy.footerTagline}</span>
            <span>{copy.footerAdvice}</span>
          </div>
        </footer>
      </div>
    </QueryClientProvider>
  );
}
