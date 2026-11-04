import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { copilotCopyFor } from "@/modules/muse-copilot/copilot-copy";
import {
  journeyTasks,
  type CopilotContext,
  type JourneyTask,
} from "@/modules/muse-copilot/journey/types";
import { MuseShell } from "@/modules/muse-copilot/shell/muse-shell";
import { localeSearchSchema, type Locale } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

const journeyTaskSchema = z.enum(journeyTasks);

/**
 * Muse deep links preserve the router locale convention (`lang`) and accept
 * shareable public identifiers only: task plus dish/venue/scan ids and the
 * coarse city/country. Scan ownership tokens never ride in the URL — the
 * scan id is only a uuid-shaped hint and the server re-verifies ownership,
 * so a shared link carries no private state.
 *
 * `?task=ask` (or any valid slug) enters that task's conversation directly,
 * with no intermediate chooser. Unknown `task` values fall back to the
 * landing picker — never a blank page. An invalid `scan` is dropped the
 * same way instead of failing the whole search parse.
 */
const museSearchSchema = localeSearchSchema.extend({
  task: journeyTaskSchema.optional().catch(undefined),
  dish: z.string().trim().min(1).max(200).optional(),
  venue: z.string().trim().min(1).max(200).optional(),
  scan: z.string().uuid().optional().catch(undefined),
  city: z.string().trim().min(1).max(120).optional(),
  country: z.string().trim().min(1).max(120).optional(),
});

export const Route = createFileRoute("/muse")({
  validateSearch: museSearchSchema,
  component: MuseRoute,
});

/** Search params the shell writes back: locale plus shareable public ids. */
interface MuseSearchTarget {
  lang: Locale;
  task?: JourneyTask | undefined;
  dish?: string | undefined;
  venue?: string | undefined;
  scan?: string | undefined;
  city?: string | undefined;
  country?: string | undefined;
}

function MuseRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { session } = rootRoute.useRouteContext();

  const language = search.lang === "vi" ? "vi" : "en";
  const copy = copilotCopyFor(language);
  const task: JourneyTask | null = search.task ?? null;

  const signedIn = session.status === "signed-in";
  const identity = signedIn ? session.user.id : "guest";

  const sync = (nextTask: JourneyTask | null, context: CopilotContext): void => {
    const target: MuseSearchTarget = { lang: search.lang };

    if (nextTask !== null) {
      target.task = nextTask;
    }

    if (context.city !== undefined && context.city.trim() !== "") {
      target.city = context.city;
    }

    if (context.country !== undefined && context.country.trim() !== "") {
      target.country = context.country;
    }

    if (context.dishId !== undefined) {
      target.dish = context.dishId;
    }

    if (context.venueId !== undefined) {
      target.venue = context.venueId;
    }

    if (context.scanId !== undefined) {
      target.scan = context.scanId;
    }

    // Tool switches and context syncs replace the history entry instead of
    // pushing: task chips are in-place tool activation (typed MuseAction
    // outcomes), not page navigations, so Back returns to the prior
    // meaningful page rather than stepping through previous task chips.
    // Genuine page changes (dish details, restaurant map) navigate normally
    // from their own cards via OpenRoute and push history as usual.
    void navigate({ to: "/muse", search: target, replace: true });
  };

  // Keyed by session identity only: task/context/URL updates adopt in place
  // through the shell effect, so unrelated route updates never remount the
  // thread. Account switching remounts deliberately (thread storage is
  // identity-scoped); language switching remounts the workspace through its
  // storage key because the thread is language-scoped too.
  return (
    <MuseShell
      key={identity}
      copy={copy}
      task={task}
      initialContext={{
        language,
        dishId: search.dish,
        venueId: search.venue,
        scanId: search.scan,
        city: search.city,
        country: search.country,
      }}
      signedIn={signedIn}
      storageKey={`${identity}:${search.lang}`}
      onSync={sync}
    />
  );
}
