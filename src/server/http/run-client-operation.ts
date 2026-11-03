import {
  getRequestHeaders,
  setResponseHeader,
  setResponseStatus,
} from "@tanstack/react-start/server";
import { Effect, Result } from "effect";

import { appConfig } from "@/server/config";
import { clientFailure } from "@/server/http/client-failure";
import { RateLimitPolicy, type RateLimitBucket } from "@/server/http/rate-limit";
import { resolveClientIdentity } from "@/server/http/request";
import type { AppServices } from "@/server/layers";
import { appRuntime, withRequestTimeout } from "@/server/runtime";

export async function runClientOperation<A, E, R extends AppServices>(
  effect: Effect.Effect<A, E, R>,
  bucket: RateLimitBucket | null = "public",
): Promise<A> {
  const guarded = Effect.gen(function* () {
    if (bucket !== null) {
      const config = yield* appConfig;
      const policy = yield* RateLimitPolicy;

      const identity = resolveClientIdentity(
        new Request("http://server-function", { headers: getRequestHeaders() }),
        config,
      );

      yield* policy.check(bucket, identity);
    }

    return yield* effect;
  });

  const result = await appRuntime
    .runPromise(
      withRequestTimeout(guarded, "client/rpc", 15000).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Client operation failed", { tag: clientFailure(error)._tag }),
        ),
        Effect.mapError(clientFailure),
        Effect.result,
      ),
    )
    .catch(() => {
      setResponseStatus(500);
      throw clientFailure(undefined);
    });

  return Result.match(result, {
    onSuccess: (value) => value,
    onFailure: (failure) => {
      setResponseStatus(failure.status);

      if (failure.retryAfterSeconds !== null)
        setResponseHeader("Retry-After", String(failure.retryAfterSeconds));
      // Plain data retains domain identity through the framework serializer.
      throw failure;
    },
  });
}
