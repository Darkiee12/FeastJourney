import { Effect } from "effect";

import { Authorization } from "@/modules/user/server/operations/authorization";
import save from "@/modules/user/server/repository/sql/currency-preference-save.sql";
import preference from "@/modules/user/server/repository/sql/currency-preference.sql";
import { Actor } from "@/server/auth/actor";
import { CurrentActor } from "@/server/auth/current-actor";
import { runQuery } from "@/server/database/query";

export const getPreferredCurrency = Effect.gen(function* () {
  const actor = yield* CurrentActor;

  return yield* Actor.$match(actor, {
    Guest: () => Effect.succeed({ member: false, currency: null, userId: null }),
    Member: ({ userId }) =>
      runQuery("user/currency", (sql) => preference.run(sql, { user: userId })).pipe(
        Effect.map((row) => ({ member: true, currency: row?.preferred_currency ?? null, userId })),
      ),
  });
});

export const setPreferredCurrency = Effect.fn("user.setPreferredCurrency")(function* (
  currency: string | null,
) {
  const actor = yield* CurrentActor;
  const authorization = yield* Authorization;
  yield* authorization.require(actor, { resource: "profile", actions: ["update"] });

  return yield* Actor.$match(actor, {
    Guest: () => Effect.die(new Error("Authorization allowed a guest profile mutation")),
    Member: ({ userId }) =>
      runQuery("user/currency-save", (sql) => save.run(sql, { user: userId, currency })),
  });
});
