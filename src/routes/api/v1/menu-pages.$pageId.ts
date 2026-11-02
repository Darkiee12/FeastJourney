import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import {
  MenuPageFullLive,
  MenuPageService,
} from "@/modules/restaurant-discovery/server/operations/menu-page-media";
import { Actor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import { resolveSession } from "@/server/auth/session";
import { appRuntime } from "@/server/runtime";

export const Route = createFileRoute("/api/v1/menu-pages/$pageId")({
  server: {
    handlers: {
      GET: ({ request, params }) => handleMenuPage(request, params, false),
      HEAD: ({ request, params }) => handleMenuPage(request, params, true),
    },
  },
});

interface MenuPageParams {
  readonly pageId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Same-origin delivery for permanent photographed menu pages.
 *
 * Default: published pages only (drafts, review items, and removed rows
 * resolve to 404 without distinguishing them, so private state cannot be
 * probed). `?preview=1` serves any non-removed row to a signed-in member
 * holding `restaurant:read` for staff previews; it is never linked from
 * public responses and carries `private, no-store`.
 *
 * Served bytes are the stored originals (no derivatives, so photographed
 * text stays full-resolution). Eligibility runs BEFORE the If-None-Match
 * short-circuit — a withdrawn page must 404 at origin even when the
 * client presents a previously valid ETag.
 */
const handleMenuPage = async (
  request: Request,
  params: MenuPageParams,
  headOnly: boolean,
): Promise<Response> => {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const pageId = params.pageId;
  const preview = new URL(request.url).searchParams.get("preview") === "1";

  if (!UUID_PATTERN.test(pageId)) {
    return imageError(404, requestId);
  }

  let actor: Actor = Actor.Guest();

  if (preview) {
    try {
      const trusted = await appRuntime.runPromise(resolveSession(request.headers));

      actor = Actor.Member({ userId: trusted.userId });
    } catch {
      return imageError(401, requestId);
    }
  }

  const ifNoneMatch = preview ? null : request.headers.get("if-none-match");

  const program = Effect.flatMap(MenuPageService, (service) =>
    service.servePage({ pageId, preview }),
  ).pipe(
    Effect.map((served) => {
      if (ifNoneMatch !== null && ifNoneMatch === served.etag) {
        return new Response(null, {
          status: 304,
          headers: imageHeaders(served.contentType, served.etag, 0, requestId, preview),
        });
      }

      return imageResponse(served, requestId, headOnly, preview);
    }),
    Effect.provide(MenuPageFullLive),
    (effect) => withActor(actor, effect),
    Effect.catchTags({
      MenuPageNotFound: () => Effect.succeed(imageError(404, requestId)),
      MenuPageValidationFailed: () => Effect.succeed(imageError(404, requestId)),
      RestaurantPhotoStorageFailed: () => Effect.succeed(imageError(404, requestId)),
      RestaurantPhotoStorageMisconfigured: () => Effect.succeed(imageError(404, requestId)),
      InsufficientPermissions: () => Effect.succeed(imageError(403, requestId)),
    }),
    Effect.catch(() => Effect.succeed(imageError(500, requestId))),
  );

  return appRuntime.runPromise(program);
};

const imageHeaders = (
  contentType: string,
  etag: string,
  byteSize: number,
  requestId: string,
  preview: boolean,
): Headers => {
  const headers = new Headers();

  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(byteSize));
  headers.set("ETag", etag);
  headers.set("X-Request-Id", requestId);
  headers.set(
    "Cache-Control",
    preview ? "private, no-store" : "public, max-age=31536000, immutable",
  );

  return headers;
};

const imageResponse = (
  served: {
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly etag: string;
    readonly byteSize: number;
  },
  requestId: string,
  headOnly: boolean,
  preview: boolean,
): Response => {
  const headers = imageHeaders(
    served.contentType,
    served.etag,
    served.byteSize,
    requestId,
    preview,
  );

  if (headOnly) {
    return new Response(null, { status: 200, headers });
  }

  const body = new Uint8Array(served.byteSize);

  body.set(served.bytes);

  return new Response(body, { status: 200, headers });
};

const imageError = (status: number, requestId: string): Response =>
  Response.json(
    { error: status === 401 ? "sign-in required" : "not found", requestId },
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Request-Id": requestId,
      },
    },
  );
