import { createHash, randomBytes } from "node:crypto";

import { Cause, Effect, Exit, Result } from "effect";
import { z } from "zod";

import {
  contributeScanSchema,
  createScanSchema,
  menuCityIdSchema,
  reviseScanSchema,
  scanIdSchema,
  scanReviewSchema,
} from "@/modules/restaurant-discovery/menu-scan.schema";
import {
  attachMenuPhoto,
  claimGuestMenuScan,
  createMenuScan,
  deleteMenuScan,
  extractMenu,
  getMenuScan,
  readMenuPhoto,
  resolveScannerOrFail,
  reviseMenuScan,
  ScanInputError,
  submitMenuContribution,
} from "@/modules/restaurant-discovery/server/operations/menu-scans";
import {
  getMenuContribution,
  listMenuContributions,
  readContributionAsset,
  reviewMenuContribution,
} from "@/modules/restaurant-discovery/server/operations/scan-contributions";
import { Actor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import { resolveSession } from "@/server/auth/session";
import { appConfig } from "@/server/config";
import { serverEnv } from "@/server/env";
import { getTrustedVisitorCountry } from "@/server/geo/trusted-region";
import { BodyLimitError, boundedBody } from "@/server/http/body-limit";
import { clientFailure } from "@/server/http/client-failure";
import { RateLimitPolicy } from "@/server/http/rate-limit";
import { resolveClientIdentity } from "@/server/http/request";
import { menuScanConfig } from "@/server/integrations/menu-scan-config";
import { ExtractionUnavailable } from "@/server/integrations/muse-menu";
import { appRuntime, withRequestTimeout } from "@/server/runtime";

const commandSchema = z.discriminatedUnion("action", [
  createScanSchema.extend({ action: z.literal("create") }),
  scanIdSchema.extend({ action: z.literal("get") }),
  scanIdSchema.extend({
    action: z.literal("extract"),
    menuCityId: menuCityIdSchema.optional(),
  }),
  scanIdSchema.extend({ action: z.literal("claim") }),
  scanIdSchema.extend({ action: z.literal("delete") }),
  reviseScanSchema.extend({ action: z.literal("revise") }),
  contributeScanSchema.extend({ action: z.literal("contribute") }),
  z.strictObject({ action: z.literal("listContributions") }),
  z.strictObject({ action: z.literal("getContribution"), contributionId: z.uuid() }),
  scanReviewSchema.extend({ action: z.literal("review") }),
]);

const photoSchema = z.union([
  z.strictObject({ scanId: z.uuid(), assetId: z.uuid() }),
  z.strictObject({ contributionId: z.uuid(), assetId: z.uuid() }),
]);

/**
 * Multipart transport cap for one photo upload: the operator's
 * MENU_SCAN_MAX_IMAGE_BYTES plus framing overhead. Falls back to the
 * historical 8 MiB default when the scanner is disabled or misconfigured
 * (extraction itself still fails loudly at its own boundary).
 */
const resolveAttachBodyCap = (): number => {
  try {
    const scanner = menuScanConfig();

    if (scanner !== null) return scanner.maxImageBytes + 16384;
  } catch {
    // Misconfigured scanner: default cap for uploads only.
  }

  return 8 * 1024 * 1024 + 16384;
};

/**
 * Per-action request-transport budgets (ms). These bound hung transports
 * only — guest-accessible cancellation protection, never an operator-value
 * ceiling. JSON actions (claim, reads, writes, extraction accept) are quick
 * local work, so the existing 60 s stands confirmed; multipart photo
 * uploads carry megabytes over slow links plus two storage roundtrips
 * (each internally capped at STORAGE_OP_TIMEOUT_MS), so they get a
 * generous bound — previously a slow upload could die to the shared 60 s
 * mid-transfer. Extraction itself runs detached under the operator's
 * MENU_SCAN_TIMEOUT_MS, so no value here can defeat it. Documented
 * constants, not new env: no deployment tunes per-action HTTP budgets, so
 * an operator knob would be surface without a use case.
 */
const SCAN_HTTP_JSON_TIMEOUT_MS = 60000;
const SCAN_HTTP_UPLOAD_TIMEOUT_MS = 120000;

/**
 * Retry-After is advisory: it invites the client to retry, so it is sent
 * only when the client error contract says the failure is retryable. A
 * non-retryable failure that happens to carry provider timing data must not
 * advertise a retry delay.
 */
export function applyRetryAfter(
  headers: Headers,
  failure: { readonly retryable: boolean; readonly retryAfterSeconds: number | null },
): void {
  if (failure.retryable && failure.retryAfterSeconds !== null)
    headers.set("Retry-After", String(failure.retryAfterSeconds));
}

export async function handleMenuScanRequest(request: Request): Promise<Response> {
  const requestId = crypto.randomUUID();

  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
    "Referrer-Policy": "no-referrer",
  });

  const operation = Effect.gen(function* () {
    const origin = new URL(serverEnv().BETTER_AUTH_URL).origin;

    if (request.method === "POST" && request.headers.get("origin") !== origin)
      return yield* new ScanInputError({ reason: "Use this action from FeastJourney." });
    const config = yield* appConfig;
    const policy = yield* RateLimitPolicy;
    const identity = resolveClientIdentity(request, config);

    // Status polls ("get") arrive as POST through the same transport but are
    // cheap reads: a 2.5 s poll loop over a minutes-long extraction would
    // otherwise drain the shared search budget and 429 its own retry button.
    // Peek at JSON command bodies before charging; anything else (including
    // multipart photo uploads, which are never read here) stays on search.
    // Only JSON command bodies are peeked: multipart photo uploads skip
    // inspection entirely (no unbounded body read, no double processing).
    const commandContentType = request.headers.get("content-type") ?? "";

    const actionName =
      request.method === "POST" && commandContentType.includes("application/json")
        ? yield* Effect.tryPromise({
            try: async (): Promise<string | null> => {
              const peeked = z
                .object({ action: z.string() })
                .safeParse(await request.clone().json());

              return peeked.success ? peeked.data.action : null;
            },
            catch: (): null => null,
          })
        : null;

    yield* policy.check(
      actionName === "get" || request.method !== "POST" ? "public" : "search",
      identity,
    );

    const trusted = yield* resolveSession(request.headers).pipe(
      Effect.map((session) => session.userId),
      Effect.catchTag("SignInRequired", () => Effect.succeed(null)),
    );

    const cookieName = origin.startsWith("https:") ? "__Host-fj-menu-guest" : "fj-menu-guest";
    const cookies = request.headers.get("cookie") ?? "";

    const stored = cookies
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);

    let capability = stored;

    if (capability === undefined || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
      capability = randomBytes(32).toString("base64url");
      headers.append(
        "Set-Cookie",
        `${cookieName}=${capability}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${origin.startsWith("https:") ? "; Secure" : ""}`,
      );
    }

    const principal = {
      userId: trusted,
      guestHash: createHash("sha256").update(capability).digest("hex"),
    };

    const actor = trusted === null ? Actor.Guest() : Actor.Member({ userId: trusted });

    if (request.method === "GET") {
      const parsed = photoSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));

      if (!parsed.success)
        return yield* new ScanInputError({ reason: "Invalid private photo reference." });
      const photo = parsed.data;

      const bytes =
        "scanId" in photo
          ? yield* readMenuPhoto(principal, photo.scanId, photo.assetId)
          : yield* withActor(actor, readContributionAsset(photo.contributionId, photo.assetId));

      headers.set("Content-Type", "image/jpeg");
      headers.set("Content-Disposition", "inline");

      return new Response(new Uint8Array(bytes), { headers });
    }

    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.startsWith("multipart/form-data")) {
      const form = yield* Effect.tryPromise({
        try: async (signal) => {
          // Transport body cap admits the operator's MENU_SCAN_MAX_IMAGE_BYTES
          // plus multipart overhead — never a fixed 8 MiB that would defeat an
          // explicit larger value. The decoded image is still validated
          // against the configured byte bound in attachMenuPhoto.
          const bytes = await boundedBody(request, resolveAttachBodyCap(), signal);

          return new Response(new Uint8Array(bytes), {
            headers: { "Content-Type": contentType },
          }).formData();
        },
        catch: (error) =>
          error instanceof BodyLimitError
            ? new ScanInputError({ reason: error.reason })
            : new ScanInputError({ reason: "The photo upload is invalid or too large." }),
      });

      // Page range parses as a positive int here; the upper bound is enforced
      // against the operator's MENU_SCAN_MAX_IMAGES in attachMenuPhoto.
      const parsed = scanIdSchema
        .extend({ pageNumber: z.coerce.number().int().min(1) })
        .safeParse({ scanId: form.get("scanId"), pageNumber: form.get("pageNumber") });

      const file = form.get("file");

      if (!parsed.success || !(file instanceof File))
        return yield* new ScanInputError({ reason: "Choose a menu photograph and page number." });

      const bytes = yield* Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: () => new ScanInputError({ reason: "Cannot read this photograph." }),
      });

      const result = yield* attachMenuPhoto(
        principal,
        parsed.data.scanId,
        parsed.data.pageNumber,
        new Uint8Array(bytes),
        file.type,
      );

      return Response.json(result, { headers });
    }

    const input = yield* Effect.tryPromise({
      try: async (signal) => {
        const bytes = await boundedBody(request, 1024 * 1024 + 16384, signal);

        return commandSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      },
      catch: () => new ScanInputError({ reason: "Check the menu details and try again." }),
    });

    switch (input.action) {
      case "create": {
        // Deployment misconfiguration is a provider outage (503), never a
        // user validation error: the request itself may be perfectly valid.
        // Invalid explicit configuration logs field + reason server-side.
        const scanner = yield* resolveScannerOrFail();

        if (scanner === null)
          return yield* new ExtractionUnavailable({
            reason: "Menu analysis is unavailable. Please retry later.",
            retryable: false,
            category: "unavailable",
          });

        const { action: _action, ...command } = input;

        return Response.json(yield* createMenuScan(principal, command), { headers });
      }

      case "get":
        return Response.json(yield* getMenuScan(principal, input.scanId), { headers });
      case "extract": {
        // Coarse visitor country only; never raw GPS, street addresses, or
        // header values beyond the already-trusted boundary. extractMenu
        // merges this under the linked venue and printed-address evidence,
        // with the visitor-selected menu city (opaque id, server-resolved)
        // ranked below the venue.
        const trustedCountry = getTrustedVisitorCountry(
          request.headers,
          config.trustedProxies,
        ).country;

        return Response.json(
          yield* extractMenu(principal, input.scanId, requestId, {
            trustedCountry,
            menuCityId: input.menuCityId,
          }),
          { headers },
        );
      }

      case "revise": {
        const { action: _action, ...command } = input;

        return Response.json(yield* reviseMenuScan(principal, command), { headers });
      }

      case "contribute": {
        const { action: _action, ...command } = input;

        return Response.json(yield* submitMenuContribution(principal, command), { headers });
      }

      case "claim":
        return Response.json(yield* claimGuestMenuScan(principal, input.scanId), { headers });
      case "delete":
        return Response.json(yield* deleteMenuScan(principal, input.scanId), { headers });
      case "listContributions":
        return Response.json(yield* withActor(actor, listMenuContributions()), { headers });
      case "getContribution":
        return Response.json(yield* withActor(actor, getMenuContribution(input.contributionId)), {
          headers,
        });
      case "review": {
        const { action: _action, ...command } = input;

        return Response.json(yield* withActor(actor, reviewMenuContribution(command)), { headers });
      }

      default:
        return yield* new ScanInputError({ reason: "Unsupported menu action." });
    }
  }).pipe(Effect.annotateLogs({ requestId, operation: "menu-scans/http" }));

  // Per-action request-transport budget only (see SCAN_HTTP_*_TIMEOUT_MS):
  // multipart photo uploads are slow by nature, every other action is quick
  // local work. Extraction itself runs detached under the operator's
  // MENU_SCAN_TIMEOUT_MS, so this bound can never defeat it.
  const isUpload =
    request.method === "POST" &&
    (request.headers.get("content-type") ?? "").startsWith("multipart/form-data");

  const exit = await appRuntime.runPromiseExit(
    withRequestTimeout(
      operation,
      "menu-scans/http",
      isUpload ? SCAN_HTTP_UPLOAD_TIMEOUT_MS : SCAN_HTTP_JSON_TIMEOUT_MS,
    ),
    { signal: request.signal },
  );

  if (Exit.isSuccess(exit)) return exit.value;

  const failure = Result.match(Cause.findError(exit.cause), {
    onSuccess: clientFailure,
    onFailure: () => clientFailure(undefined),
  });

  applyRetryAfter(headers, failure);

  return Response.json(failure, { status: failure.status, headers });
}
