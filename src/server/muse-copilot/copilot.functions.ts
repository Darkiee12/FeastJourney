import type { Hash } from "node:crypto";

import { createServerFn } from "@tanstack/react-start";

import type { ScanPrincipal } from "@/modules/restaurant-discovery/server/operations/menu-scans";
import {
  copilotChatInputSchema,
  copilotChatOutputSchema,
  copilotDraftOrderInputSchema,
  copilotDraftOrderOutputSchema,
  copilotIdentifyPhotoInputSchema,
  copilotIdentifyPhotoOutputSchema,
  type CopilotChatOutput,
} from "@/server/muse-copilot/copilot-schemas";

const loadChatServer = () =>
  Promise.all([
    import("effect"),
    import("@/server/muse-copilot/copilot-service"),
    import("@/server/auth/actor"),
    import("@/server/auth/session"),
    import("@/server/runtime"),
    import("@/server/http/rate-limit"),
    import("@tanstack/react-start/server"),
    import("@/server/http/request"),
    import("@/server/config"),
    import("@/server/web-research/research-service"),
    import("@/server/integrations/meta-responses"),
    import("@/server/env"),
    import("node:crypto"),
  ]);

const loadPhotoServer = () =>
  Promise.all([
    import("effect"),
    import("@/server/muse-copilot/copilot-vision"),
    import("@/server/auth/actor"),
    import("@/server/auth/session"),
    import("@/server/runtime"),
    import("@/server/http/rate-limit"),
    import("@tanstack/react-start/server"),
    import("@/server/http/request"),
    import("@/server/config"),
    import("@/server/env"),
    import("node:crypto"),
  ]);

const loadDraftServer = () =>
  Promise.all([
    import("effect"),
    import("@/server/muse-copilot/copilot-service"),
    import("@/server/auth/actor"),
    import("@/server/auth/session"),
    import("@/server/runtime"),
    import("@/server/http/rate-limit"),
    import("@tanstack/react-start/server"),
    import("@/server/http/request"),
    import("@/server/config"),
    import("@/server/env"),
    import("node:crypto"),
  ]);

interface InflightEntry {
  readonly promise: Promise<CopilotChatOutput>;
  readonly expiresAt: number;
}

const CHAT_COHERENCE_TTL_MS = 30000;

const chatInflight = new Map<string, InflightEntry>();

const sweepChatInflight = (now: number): void => {
  for (const [key, entry] of chatInflight) {
    if (entry.expiresAt <= now) {
      chatInflight.delete(key);
    }
  }
};

/** Guest scan capability: same HttpOnly cookie + sha256 hash the scanner mints. */
const GUEST_COOKIE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Ownership principal for private scans. Members resolve from the verified
 * session; guests resolve from the existing scanner guest cookie (no new
 * mechanism). Null denies private access — callers fail closed.
 */
const resolveScanPrincipal = (
  headers: Headers,
  memberUserId: string | null,
  betterAuthUrl: string,
  createHash: (algorithm: string) => Hash,
): ScanPrincipal | null => {
  if (memberUserId !== null) {
    return { userId: memberUserId, guestHash: "" };
  }

  let origin: string;

  try {
    origin = new URL(betterAuthUrl).origin;
  } catch {
    return null;
  }

  const cookieName = origin.startsWith("https:") ? "__Host-fj-menu-guest" : "fj-menu-guest";
  const cookies = headers.get("cookie") ?? "";

  const stored = cookies
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);

  if (stored === undefined || !GUEST_COOKIE_PATTERN.test(stored)) {
    return null;
  }

  return { userId: null, guestHash: createHash("sha256").update(stored).digest("hex") };
};

/**
 * Muse copilot transport. Validation runs through Zod at this boundary;
 * server-only Effect modules load dynamically so browser bundles never
 * include database or provider code. Rate limiting runs before any identity
 * or database work; the actor always resolves from the verified session.
 */
export const copilotChatFn = createServerFn({ method: "POST" })
  .validator(copilotChatInputSchema)
  .handler(async ({ data }) => {
    const [
      effects,
      { copilotChat, COPILOT_OVERALL_DEADLINE_MS },
      { Actor },
      { resolveSession },
      { runApp },
      { RateLimitPolicy },
      server,
      { resolveIdentityFromHeaders },
      { appConfig },
      { WebResearchLive },
      { MetaResponsesLive },
      { serverEnv },
      { createHash },
    ] = await loadChatServer();

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await runApp(
      effects.Effect.flatMap(RateLimitPolicy, (policy) =>
        effects.Effect.flatMap(appConfig, (config) =>
          policy.check("search", resolveIdentityFromHeaders(headers, config)).pipe(
            effects.Effect.catchTag("RateLimitExceeded", (failure) =>
              effects.Effect.die(
                new Response(
                  JSON.stringify({
                    error: "rate_limited",
                    retryAfterSeconds: failure.retryAfterSeconds,
                  }),
                  {
                    status: 429,
                    headers: {
                      "content-type": "application/json",
                      "Retry-After": String(failure.retryAfterSeconds),
                    },
                  },
                ),
              ),
            ),
            effects.Effect.catchTag("StoreUnavailable", () =>
              effects.Effect.die(
                new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
                  status: 503,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
      ),
      "fn/copilot/rate-limit",
      5000,
      requestId,
    );

    const actor = await runApp(
      resolveSession(headers).pipe(
        effects.Effect.map((trusted) => Actor.Member({ userId: trusted.userId })),
        effects.Effect.catchTag("SignInRequired", () => effects.Effect.succeed(Actor.Guest())),
      ),
      "fn/copilot/actor",
      5000,
      requestId,
    );

    const memberUserId = Actor.$match(actor, {
      Guest: () => null,
      Member: ({ userId }) => userId,
    });

    let betterAuthUrl = "";

    try {
      betterAuthUrl = serverEnv().BETTER_AUTH_URL;
    } catch {
      betterAuthUrl = "";
    }

    const scanPrincipal = resolveScanPrincipal(headers, memberUserId, betterAuthUrl, createHash);

    const actorKey = Actor.$match(actor, {
      Guest: () => `guest:${scanPrincipal?.guestHash.slice(0, 16) ?? "none"}`,
      Member: ({ userId }) => `member:${userId}`,
    });

    const coherenceKey = JSON.stringify({
      message: data.message,
      task: data.task ?? "ask",
      context: data.context ?? {},
      history: data.history ?? [],
      actor: actorKey,
    });

    const now = Date.now();
    sweepChatInflight(now);
    const ongoing = chatInflight.get(coherenceKey);

    if (ongoing !== undefined) {
      return await ongoing.promise;
    }

    const run = runApp(
      effects.Effect.provide(
        copilotChat({
          message: data.message,
          task: data.task ?? "ask",
          context: data.context ?? {},
          history: data.history ?? [],
          actor,
          scanPrincipal,
        }),
        effects.Layer.provide(WebResearchLive, MetaResponsesLive),
      ),
      "fn/copilot/chat",
      COPILOT_OVERALL_DEADLINE_MS,
      requestId,
    ).then((output) => {
      const checked = copilotChatOutputSchema.safeParse(output);

      if (checked.success) {
        return checked.data;
      }

      return {
        reply: "This answer could not be completed. Please try again.",
        cards: [],
        followUps: ["Browse popular dishes"],
        synthesized: false,
      };
    });

    chatInflight.set(coherenceKey, { promise: run, expiresAt: now + CHAT_COHERENCE_TTL_MS });

    try {
      return await run;
    } finally {
      chatInflight.delete(coherenceKey);
    }
  });

export const copilotIdentifyPhotoFn = createServerFn({ method: "POST" })
  .validator(copilotIdentifyPhotoInputSchema)
  .handler(async ({ data }) => {
    const [
      effects,
      { identifyFoodPhoto },
      { Actor },
      { resolveSession },
      { runApp },
      { RateLimitPolicy },
      server,
      { resolveIdentityFromHeaders },
      { appConfig },
      { serverEnv },
      { createHash },
    ] = await loadPhotoServer();

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await runApp(
      effects.Effect.flatMap(RateLimitPolicy, (policy) =>
        effects.Effect.flatMap(appConfig, (config) =>
          policy.check("search", resolveIdentityFromHeaders(headers, config)).pipe(
            effects.Effect.catchTag("RateLimitExceeded", (failure) =>
              effects.Effect.die(
                new Response(
                  JSON.stringify({
                    error: "rate_limited",
                    retryAfterSeconds: failure.retryAfterSeconds,
                  }),
                  {
                    status: 429,
                    headers: {
                      "content-type": "application/json",
                      "Retry-After": String(failure.retryAfterSeconds),
                    },
                  },
                ),
              ),
            ),
            effects.Effect.catchTag("StoreUnavailable", () =>
              effects.Effect.die(
                new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
                  status: 503,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
      ),
      "fn/copilot-photo/rate-limit",
      5000,
      requestId,
    );

    const actor = await runApp(
      resolveSession(headers).pipe(
        effects.Effect.map((trusted) => Actor.Member({ userId: trusted.userId })),
        effects.Effect.catchTag("SignInRequired", () => effects.Effect.succeed(Actor.Guest())),
      ),
      "fn/copilot-photo/actor",
      5000,
      requestId,
    );

    const memberUserId = Actor.$match(actor, {
      Guest: () => null,
      Member: ({ userId }) => userId,
    });

    let betterAuthUrl = "";

    try {
      betterAuthUrl = serverEnv().BETTER_AUTH_URL;
    } catch {
      betterAuthUrl = "";
    }

    const scanPrincipal = resolveScanPrincipal(headers, memberUserId, betterAuthUrl, createHash);

    const output = await runApp(
      identifyFoodPhoto(
        { scanId: data.scanId, assetId: data.assetId, language: data.language },
        scanPrincipal,
      ),
      "fn/copilot-photo/identify",
      30000,
      requestId,
    );

    const checked = copilotIdentifyPhotoOutputSchema.safeParse(output);

    if (checked.success) {
      return checked.data;
    }

    return {
      candidates: [],
      unmatchedNote: "This photo could not be analyzed. Try another image.",
    };
  });

export const copilotDraftOrderFn = createServerFn({ method: "POST" })
  .validator(copilotDraftOrderInputSchema)
  .handler(async ({ data }) => {
    const [
      effects,
      { draftOrder },
      { Actor },
      { resolveSession },
      { runApp },
      { RateLimitPolicy },
      server,
      { resolveIdentityFromHeaders },
      { appConfig },
      { serverEnv },
      { createHash },
    ] = await loadDraftServer();

    const headers = server.getRequestHeaders();
    const requestId = crypto.randomUUID();

    await runApp(
      effects.Effect.flatMap(RateLimitPolicy, (policy) =>
        effects.Effect.flatMap(appConfig, (config) =>
          policy.check("search", resolveIdentityFromHeaders(headers, config)).pipe(
            effects.Effect.catchTag("RateLimitExceeded", (failure) =>
              effects.Effect.die(
                new Response(
                  JSON.stringify({
                    error: "rate_limited",
                    retryAfterSeconds: failure.retryAfterSeconds,
                  }),
                  {
                    status: 429,
                    headers: {
                      "content-type": "application/json",
                      "Retry-After": String(failure.retryAfterSeconds),
                    },
                  },
                ),
              ),
            ),
            effects.Effect.catchTag("StoreUnavailable", () =>
              effects.Effect.die(
                new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
                  status: 503,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          ),
        ),
      ),
      "fn/copilot-draft/rate-limit",
      5000,
      requestId,
    );

    const actor = await runApp(
      resolveSession(headers).pipe(
        effects.Effect.map((trusted) => Actor.Member({ userId: trusted.userId })),
        effects.Effect.catchTag("SignInRequired", () => effects.Effect.succeed(Actor.Guest())),
      ),
      "fn/copilot-draft/actor",
      5000,
      requestId,
    );

    const memberUserId = Actor.$match(actor, {
      Guest: () => null,
      Member: ({ userId }) => userId,
    });

    let betterAuthUrl = "";

    try {
      betterAuthUrl = serverEnv().BETTER_AUTH_URL;
    } catch {
      betterAuthUrl = "";
    }

    const output = await runApp(
      draftOrder({
        venueId: data.venueId,
        scanId: data.scanId,
        items: data.items,
        instructions: data.instructions,
        actor,
        scanPrincipal: resolveScanPrincipal(headers, memberUserId, betterAuthUrl, createHash),
      }),
      "fn/copilot-draft/order",
      30000,
      requestId,
    );

    const checked = copilotDraftOrderOutputSchema.safeParse(output);

    if (checked.success) {
      return checked.data;
    }

    return {
      lines: [],
      subtotalMinor: null,
      currency: "",
      incomplete: true,
      warnings: ["This draft could not be completed. Please try again."],
    };
  });
