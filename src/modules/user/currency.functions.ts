import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { isCurrency } from "@/shared/money";

export const currencyPreferenceFn = createServerFn({ method: "GET" }).handler(async () => {
  const { Effect } = await import("effect");
  const { getRequestHeaders } = await import("@tanstack/react-start/server");
  const { resolveSession } = await import("@/server/auth/session");
  const { Actor } = await import("@/server/auth/actor");
  const { withActor } = await import("@/server/auth/current-actor");
  const { getPreferredCurrency } = await import("@/modules/user/server/index");
  const { runClientOperation } = await import("@/server/http/run-client-operation");

  const actor = await runClientOperation(
    resolveSession(getRequestHeaders()).pipe(
      Effect.map((session) => Actor.Member({ userId: session.userId })),
      Effect.catchTag("SignInRequired", () => Effect.succeed(Actor.Guest())),
    ),
  );

  return runClientOperation(withActor(actor, getPreferredCurrency));
});

export const saveCurrencyPreferenceFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      expectedUserId: z.string().min(1),
      currency: z.string().refine(isCurrency, "Invalid ISO currency").nullable(),
    }),
  )
  .handler(async ({ data }) => {
    const { getRequestHeaders } = await import("@tanstack/react-start/server");
    const { requireAuthenticatedActor } = await import("@/server/auth/session");
    const { Actor } = await import("@/server/auth/actor");
    const { withActor } = await import("@/server/auth/current-actor");
    const { setPreferredCurrency } = await import("@/modules/user/server/index");
    const { runClientOperation } = await import("@/server/http/run-client-operation");
    const session = await runClientOperation(requireAuthenticatedActor(getRequestHeaders()));

    if (session.userId !== data.expectedUserId) {
      const { Effect } = await import("effect");
      const { OwnershipDenied } = await import("@/server/auth/errors");

      return runClientOperation(Effect.fail(new OwnershipDenied({ reason: "Account changed" })));
    }

    return runClientOperation(
      withActor(Actor.Member({ userId: session.userId }), setPreferredCurrency(data.currency)),
    );
  });
