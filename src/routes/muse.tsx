import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { copilotCopyFor } from "@/modules/muse-copilot/copilot-copy";
import type { CopilotContext, JourneyTask } from "@/modules/muse-copilot/journey/types";
import { MuseShell } from "@/modules/muse-copilot/shell/muse-shell";
import { localeSearchSchema, type Locale } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

const journeyTaskSchema = z.enum(["scan", "plate", "find", "ask", "order"]);

/**
 * Muse deep links preserve the router locale convention (`lang`) and accept
 * shareable public identifiers only: task plus dish/venue/scan ids and the
 * coarse city/country. Scan ownership tokens never ride in the URL — the
 * server re-verifies ownership, so a shared link carries no private state.
 * Unknown `task` values fall back to the landing picker.
 */
const museSearchSchema = localeSearchSchema.extend({
  task: journeyTaskSchema.catch("ask").optional(),
  dish: z.string().trim().min(1).max(200).optional(),
  venue: z.string().trim().min(1).max(200).optional(),
  scan: z.string().trim().min(1).max(200).optional(),
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

    void navigate({ to: "/muse", search: target });
  };

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
