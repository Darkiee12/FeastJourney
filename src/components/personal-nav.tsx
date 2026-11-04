import { Link, getRouteApi } from "@tanstack/react-router";

import { messagesFor } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

const linkClass =
  "inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-sm font-semibold whitespace-nowrap text-muted hover:bg-ink/5 hover:text-ink aria-[current=page]:bg-ink aria-[current=page]:text-white";

/**
 * Personal-area navigation. Saved dishes, account, and security links live
 * here — on the member's own pages — rather than in the global site header,
 * so personal navigation never leaks into shared navigation chrome.
 */
export function PersonalNav() {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);

  return (
    <nav aria-label={copy.authAccount} className="personal-nav -mx-1 overflow-x-auto px-1 pb-1">
      <ul className="flex items-center gap-1">
        <li className="shrink-0">
          <Link
            to="/saved"
            search={{ lang }}
            activeProps={{ "aria-current": "page" }}
            className={linkClass}
          >
            {copy.savedTitle}
          </Link>
        </li>
        <li className="shrink-0">
          <Link
            to="/settings/account"
            search={{ lang }}
            activeProps={{ "aria-current": "page" }}
            className={linkClass}
          >
            {copy.authAccount}
          </Link>
        </li>
        <li className="shrink-0">
          <Link
            to="/settings/security"
            search={{ lang }}
            activeProps={{ "aria-current": "page" }}
            className={linkClass}
          >
            {copy.authSecurity}
          </Link>
        </li>
      </ul>
    </nav>
  );
}
