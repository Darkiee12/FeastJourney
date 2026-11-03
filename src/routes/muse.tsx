import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { copilotCopyFor } from "@/modules/muse-copilot/copilot-copy";
import type { JourneyTask } from "@/modules/muse-copilot/journey/types";
import { MuseShell } from "@/modules/muse-copilot/shell/muse-shell";
import { localeSearchSchema, type Locale } from "@/shared/i18n";

const journeyTaskSchema = z.enum(["scan", "plate", "find", "ask", "order"]);

/**
 * Muse deep links preserve the router locale convention (`lang`) and accept
 * shareable public identifiers only: task plus dish/venue/scan ids, each
 * trimmed and length-bounded. Scan ownership tokens never ride in the URL —
 * the server re-verifies ownership, so a shared link carries no private
 * state. Unknown `task` values fall back to the landing picker.
 */
const museSearchSchema = localeSearchSchema.extend({
  task: journeyTaskSchema.catch("ask").optional(),
  dish: z.string().trim().min(1).max(200).optional(),
  venue: z.string().trim().min(1).max(200).optional(),
  scan: z.string().trim().min(1).max(200).optional(),
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
}

function MuseRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  const language = search.lang === "vi" ? "vi" : "en";
  const copy = copilotCopyFor(language);
  const task: JourneyTask | null = search.task ?? null;

  return (
    <MuseShell
      key={search.lang}
      copy={copy}
      task={task}
      initialContext={{
        language,
        dishId: search.dish,
        venueId: search.venue,
        scanId: search.scan,
      }}
      onTaskChange={(next) => {
        const target: MuseSearchTarget = { lang: search.lang };

        if (next !== null) {
          target.task = next;
        }

        if (search.dish !== undefined) {
          target.dish = search.dish;
        }

        if (search.venue !== undefined) {
          target.venue = search.venue;
        }

        if (search.scan !== undefined) {
          target.scan = search.scan;
        }

        void navigate({ to: "/muse", search: target });
      }}
    />
  );
}
