import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import {
  RestaurantPhotoFullLive,
  RestaurantPhotoService,
} from "@/modules/restaurant-discovery/server/operations/photos";
import { Actor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import { resolveSession } from "@/server/auth/session";
import { appRuntime } from "@/server/runtime";

export const Route = createFileRoute("/api/v1/restaurant-images/$assetId/$version/$width")({
  server: {
    handlers: {
      GET: ({ request, params }) => handleRestaurantImage(request, params, false),
      HEAD: ({ request, params }) => handleRestaurantImage(request, params, true),
    },
  },
});

interface RestaurantImageParams {
  readonly assetId: string;
  readonly version: string;
  readonly width: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Same-origin delivery for approved restaurant-photo derivatives.
 *
 * Default: published + ready derivatives only (drafts, review items, and
 * failed processing resolve to 404 without distinguishing them, so private
 * state cannot be probed). `?preview=1` serves any ready row to a signed-in
 * member holding `restaurant:read` for staff previews; it is never linked
 * from public responses and carries `private, no-store`.
 *
 * Public responses are immutable per (assetId, version, width) and carry
 * year-long cache headers. Eligibility runs BEFORE the If-None-Match
 * short-circuit — a withdrawn image must 404 at origin even when the
 * client presents a previously valid ETag.
 */
const handleRestaurantImage = async (
  request: Request,
  params: RestaurantImageParams,
  headOnly: boolean,
): Promise<Response> => {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const assetId = params.assetId;
  const version = Number(params.version);
  const width = Number(params.width);
  const preview = new URL(request.url).searchParams.get("preview") === "1";

  if (!UUID_PATTERN.test(assetId) || !Number.isInteger(version) || !Number.isInteger(width)) {
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

  const program = Effect.flatMap(RestaurantPhotoService, (service) =>
    service.serveDerivative({ photoId: assetId, version, width, preview }),
  ).pipe(
    Effect.map((derivative) => {
      if (ifNoneMatch !== null && ifNoneMatch === derivative.etag) {
        return new Response(null, {
          status: 304,
          headers: imageHeaders(derivative.etag, 0, requestId, preview),
        });
      }

      return imageResponse(derivative, requestId, headOnly, preview);
    }),
    Effect.provide(RestaurantPhotoFullLive),
    (effect) => withActor(actor, effect),
    Effect.catchTags({
      RestaurantPhotoNotFound: () => Effect.succeed(imageError(404, requestId)),
      RestaurantPhotoValidationFailed: () => Effect.succeed(imageError(404, requestId)),
      RestaurantPhotoStorageFailed: () => Effect.succeed(imageError(404, requestId)),
      RestaurantPhotoStorageMisconfigured: () => Effect.succeed(imageError(404, requestId)),
      InsufficientPermissions: () => Effect.succeed(imageError(403, requestId)),
    }),
    Effect.catch(() => Effect.succeed(imageError(500, requestId))),
  );

  return appRuntime.runPromise(program);
};

const imageHeaders = (
  etag: string,
  byteSize: number,
  requestId: string,
  preview: boolean,
): Headers => {
  const headers = new Headers();

  headers.set("Content-Type", "image/webp");
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
  derivative: { readonly bytes: Uint8Array; readonly etag: string; readonly byteSize: number },
  requestId: string,
  headOnly: boolean,
  preview: boolean,
): Response => {
  const headers = imageHeaders(derivative.etag, derivative.byteSize, requestId, preview);

  if (headOnly) {
    return new Response(null, { status: 200, headers });
  }

  const body = new Uint8Array(derivative.byteSize);

  body.set(derivative.bytes);

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
