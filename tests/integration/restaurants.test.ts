import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Effect, Result } from "effect";
import postgres from "postgres";

import { DishService } from "@/modules/food-discovery/server/index";
import {
  menuImportSchema,
  restaurantSearchSchema,
  venueWriteSchema,
} from "@/modules/restaurant-discovery/restaurant.schema";
import type {
  MenuImport,
  RestaurantSearch,
} from "@/modules/restaurant-discovery/restaurant.schema";
import {
  importMenu,
  reviewObservation,
  searchRestaurants,
  writeVenue,
  getRestaurant,
  setOfferingStatus,
} from "@/modules/restaurant-discovery/server/index";
import { validateReceiptPrice } from "@/modules/restaurant-discovery/server/operations/admin";
import {
  FxProvider,
  FxRates,
  FxUnavailable,
  makeFxRates,
} from "@/modules/restaurant-discovery/server/operations/fx";
import { getPreferredCurrency, setPreferredCurrency } from "@/modules/user/server/index";
import { Actor } from "@/server/auth/actor";
import { withActor } from "@/server/auth/current-actor";
import { requireAuthenticatedActor } from "@/server/auth/session";
import type { AppServices } from "@/server/layers";
import { appRuntime } from "@/server/runtime";

import { createFoodAuth } from "./food-auth";

const run = <A, E, R extends AppServices>(effect: Effect.Effect<A, E, R>) =>
  appRuntime.runPromise(effect);

const auth = createFoodAuth();
const sql = postgres(process.env.DATABASE_URL ?? "", { max: 2 });
const stamp = crypto.randomUUID().slice(0, 8);
const area = `PR4 synthetic ${stamp}`;
const venueIds: Array<string> = [];
let actor: Actor = Actor.Guest();
let member: Actor = Actor.Guest();
let dishId = "";
let a = "";
let b = "";
let c = "";
let initial: Awaited<ReturnType<typeof menuImportResult>>;
const menuImportResult = (input: MenuImport) => run(withActor(actor, importMenu(input)));

const source = (key: string, daysAgo = 1) => ({
  category: "official_menu" as const,
  url: "https://example.com/synthetic-menu",
  deduplicationKey: `${stamp}:${key}`,
  restaurantVerified: false,
  observedAt: new Date(Date.now() - daysAgo * 86400000).toISOString(),
  validUntil: new Date(Date.now() + (30 - daysAgo) * 86400000).toISOString(),
});

const inputFor = (venueId: string, amount: string | null, key: string, daysAgo = 1): MenuImport =>
  menuImportSchema.parse({
    venueId,
    menuName: "Synthetic fixture menu",
    source: source(key, daysAgo),
    items: [
      {
        name: "Synthetic noodle offering",
        dishId,
        matchKind: "exact",
        variants: [
          {
            name: "Regular bowl",
            comparisonKey: "regular-bowl",
            price:
              amount === null
                ? undefined
                : {
                    amount,
                    currency: "VND",
                    kind: "listed",
                    channel: "dine_in",
                    taxTreatment: "included",
                    sourceLineKey: "regular",
                  },
          },
          {
            name: "Large bowl",
            comparisonKey: "large-bowl",
            price: {
              amount: "75000",
              currency: "VND",
              kind: "listed",
              channel: "dine_in",
              taxTreatment: "included",
              sourceLineKey: "large",
            },
          },
        ],
      },
    ],
  });

const approve = async (result: Awaited<ReturnType<typeof menuImportResult>>) => {
  await Promise.all(
    result.priceIds.map((id) =>
      run(withActor(actor, reviewObservation({ kind: "price", id, status: "approved" }))),
    ),
  );
  await Promise.all(
    result.evidenceIds.map((id) =>
      run(withActor(actor, reviewObservation({ kind: "serving", id, status: "approved" }))),
    ),
  );
};

const makeVenue = async (
  name: string,
  longitude = 106.7,
  status = "published",
  businessId?: string,
) => {
  const result = await run(
    withActor(
      actor,
      writeVenue(
        venueWriteSchema.parse({
          businessName: "Synthetic fixture business",
          businessId,
          name: `${name} ${stamp}`,
          address: "Synthetic test address",
          area,
          countryCode: "VN",
          longitude,
          latitude: 10.8,
          status,
        }),
      ),
    ),
  );

  venueIds.push(result.id);

  return result.id;
};

const criteria = (extra: Partial<RestaurantSearch> = {}) =>
  restaurantSearchSchema.parse({ area, ...extra });

const provider = FxProvider.of({
  id: `test-search-${stamp}`,
  pair: (base, quote) =>
    Effect.succeed({
      base,
      quote,
      rate: "0.00004",
      effectiveDate: new Date().toISOString().slice(0, 10),
      provider: `test-search-${stamp}`,
    }),
  currencies: Effect.succeed(["VND", "USD"]),
});

const fx = makeFxRates(provider, {
  provider: provider.id,
  refreshMs: 86400000,
  maxAgeMs: 72 * 3600000,
});

beforeAll(async () => {
  const adminSession = await auth.signupSignin(`pr4-curator-${stamp}`);
  await auth.grantRole(adminSession.userId, "curator");

  const trusted = await run(
    requireAuthenticatedActor(new Headers({ cookie: adminSession.cookies })),
  );

  actor = Actor.Member({ userId: trusted.userId });
  const memberSession = await auth.signupSignin(`pr4-member-${stamp}`);

  const trustedMember = await run(
    requireAuthenticatedActor(new Headers({ cookie: memberSession.cookies })),
  );

  member = Actor.Member({ userId: trustedMember.userId });
  const dish = await run(Effect.flatMap(DishService, (service) => service.getDish("pho-bo", "en")));
  dishId = dish.id;
  a = await makeVenue("Phở Test A");
  const aDetail = await run(getRestaurant(a, "dine_in"));
  b = await makeVenue("Phở Test B", 106.7, "published", aDetail.venue.business_id);
  c = await makeVenue("Unknown Regular", 107.7);
  initial = await menuImportResult(inputFor(a, "55000", "a"));
  await approve(initial);
  const other = await menuImportResult(inputFor(b, "65000", "b"));
  await approve(other);
  const unknown = await menuImportResult(inputFor(c, null, "c"));
  await approve(unknown);
  const archived = await makeVenue("Archived", 106.7, "archived");
  await approve(await menuImportResult(inputFor(archived, "1000", "archived")));
  const expired = await makeVenue("Expired evidence");
  await approve(await menuImportResult(inputFor(expired, "1000", "expired", 100)));
  const pending = await makeVenue("Pending evidence");
  await menuImportResult(inputFor(pending, "1000", "pending"));
}, 30000);

afterAll(async () => {
  // Delete only explicitly tracked synthetic venues and their dependent fixtures.
  await sql.begin(async (tx) => {
    await tx`DELETE FROM feastjourney.restaurant_receipt_lines WHERE observation_id IN(SELECT id FROM feastjourney.restaurant_price_observations WHERE venue_id=ANY(${venueIds}::uuid[]))`;
    await tx`DELETE FROM feastjourney.restaurant_price_observations WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_serving_evidence WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_sources WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_menu_item_variants WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_menu_items WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_menus WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_venue_names WHERE venue_id=ANY(${venueIds}::uuid[])`;
    await tx`DELETE FROM feastjourney.restaurant_venue_cuisines WHERE venue_id=ANY(${venueIds}::uuid[])`;

    await tx`WITH removed AS (DELETE FROM feastjourney.restaurant_venues WHERE id=ANY(${venueIds}::uuid[]) RETURNING business_id)
      DELETE FROM feastjourney.restaurant_businesses WHERE id IN(SELECT business_id FROM removed)`;
    await tx`DELETE FROM feastjourney.currency_exchange_rates WHERE provider=${provider.id}`;
    await tx`DELETE FROM feastjourney.currency_refresh_leases WHERE key LIKE ${provider.id + ":%"}`;
  });
  await sql.end();
  await auth.close();
});

describe("PostgreSQL/PostGIS restaurant search", () => {
  test("browses without geolocation, excludes archived and keeps physical branches separate", async () => {
    const output = await run(searchRestaurants(criteria()));
    expect(output.items.some((row) => row.id === a)).toBe(true);
    expect(output.items.some((row) => row.id === b)).toBe(true);
    expect(output.items.some((row) => row.name.startsWith("Archived"))).toBe(false);
    expect(output.items.some((row) => row.id === c)).toBe(true);
  });
  test("radius and bounds filter actual geography, including an empty viewport", async () => {
    const nearby = await run(
      searchRestaurants(criteria({ longitude: 106.7, latitude: 10.8, radius: 1000 })),
    );

    expect(nearby.items.some((row) => row.id === c)).toBe(false);
    expect(nearby.items.some((row) => row.id === a)).toBe(true);

    const bounds = await run(
      searchRestaurants(criteria({ west: 106.6, east: 106.8, south: 10.7, north: 10.9 })),
    );

    expect(bounds.items.some((row) => row.id === a)).toBe(true);
    expect(bounds.items.some((row) => row.id === c)).toBe(false);

    const empty = await run(
      searchRestaurants(criteria({ west: -1, east: 1, south: -1, north: 1 })),
    );

    expect(empty.items).toEqual([]);
  });
  test("distance ties and multilingual normalized name ranking are stable", async () => {
    const request = criteria({ q: "pho test", longitude: 106.7, latitude: 10.8 });
    const first = await run(searchRestaurants(request));
    const second = await run(searchRestaurants(request));
    expect(first.items.map((row) => row.id)).toEqual(second.items.map((row) => row.id));
    expect(first.items.map((row) => row.id)).toEqual([a, b]);
  });
  test("dish search requires accepted unexpired evidence and returns one row per branch", async () => {
    const output = await run(searchRestaurants(criteria({ dish: dishId })));
    expect(new Set(output.dishItems.map((row) => row.id))).toEqual(new Set([a, b, c]));
    expect(output.dishItems).toHaveLength(3);
  });
  test("unknown dish publication cannot be bypassed", async () => {
    const error = await run(
      Effect.flip(searchRestaurants(criteria({ dish: "9223372036854775807" }))),
    );

    expect(error._tag).toBe("DishNotFound");
  });
  test("price sort chooses the matching regular offering and excludes unknown/wrong-channel prices", async () => {
    const low = await run(
      searchRestaurants(
        criteria({ dish: dishId, portion: "regular-bowl", currency: "VND", sort: "price_low" }),
      ),
    );

    expect(low.dishItems.map((row) => row.id)).toEqual([a, b]);
    expect(low.dishItems[0]?.amount).toBe("55000");

    const high = await run(
      searchRestaurants(
        criteria({ dish: dishId, portion: "regular-bowl", currency: "VND", sort: "price_high" }),
      ),
    );

    expect(high.dishItems.map((row) => row.id)).toEqual([b, a]);

    const delivery = await run(
      searchRestaurants(
        criteria({
          dish: dishId,
          portion: "regular-bowl",
          currency: "VND",
          sort: "price_low",
          channel: "delivery",
        }),
      ),
    );

    expect(delivery.dishItems).toEqual([]);
  });
  test("strict cross-currency budgets compare exact unrounded NUMERIC products", async () => {
    const request = criteria({
      dish: dishId,
      portion: "regular-bowl",
      currency: "USD",
      budget: "2.20",
    });

    const equal = await run(Effect.provideService(searchRestaurants(request), FxRates, fx));
    expect(equal.dishItems).toEqual([]);

    const above = await run(
      Effect.provideService(searchRestaurants({ ...request, budget: "2.2000001" }), FxRates, fx),
    );

    expect(above.dishItems.map((row) => row.id)).toEqual([a]);
    expect(above.dishItems[0]?.amount).toBe("55000");
  });
});

describe("observation integrity and RBAC", () => {
  test("guest and ordinary member cannot write or approve", async () => {
    const guest = await run(
      Effect.flip(withActor(Actor.Guest(), importMenu(inputFor(a, "1", "guest")))),
    );

    expect(guest._tag).toBe("InsufficientPermissions");

    const denied = await run(
      Effect.flip(withActor(member, importMenu(inputFor(a, "1", "member")))),
    );

    expect(denied._tag).toBe("InsufficientPermissions");
    const id = initial.priceIds[0];

    if (id === undefined) throw new Error("Missing fixture price");

    const review = await run(
      Effect.flip(withActor(member, reviewObservation({ id, kind: "price", status: "approved" }))),
    );

    expect(review._tag).toBe("InsufficientPermissions");
  });
  test("duplicate source snapshots roll back the whole import", async () => {
    const failure = await run(Effect.flip(withActor(actor, importMenu(inputFor(a, "55000", "a")))));
    expect(failure._tag).toBe("PersistenceConflict");
    const detail = await run(getRestaurant(a, "dine_in"));
    expect(detail.offerings).toHaveLength(2);
  });
  test("cannot attach a different branch to existing menu/item/variant IDs", async () => {
    const request = { ...inputFor(b, "1", "wrong-branch"), menuId: initial.menuId };
    const failure = await run(Effect.flip(withActor(actor, importMenu(request))));
    expect(failure._tag).toBe("RestaurantInputError");

    const rows =
      await sql`SELECT id FROM feastjourney.restaurant_sources WHERE venue_id=${b} AND deduplication_key=${stamp + ":wrong-branch"}`;

    expect(rows).toHaveLength(0);
  });
  test("suggestions cannot be approved as serving evidence", async () => {
    const input = inputFor(a, null, "suggestion");

    for (const item of input.items) item.matchKind = "suggestion";
    const result = await menuImportResult(input);

    const id = result.evidenceIds[0];

    if (id === undefined) throw new Error("Missing suggestion");

    const failure = await run(
      Effect.flip(withActor(actor, reviewObservation({ id, kind: "serving", status: "approved" }))),
    );

    expect(failure._tag).toBe("PersistenceError");
  });
  test("price changes append history to the same variant; older observations are immutable", async () => {
    const offering = initial.offeringIds[0];

    if (offering === undefined) throw new Error("Missing fixture offering");
    const input = inputFor(a, "60000", "price-change");
    const first = input.items[0];

    if (first === undefined) throw new Error("Missing input fixture");
    const variant = first.variants[0];

    if (variant === undefined) throw new Error("Missing variant fixture");

    const changed = await menuImportResult({
      ...input,
      menuId: initial.menuId,
      items: [
        {
          ...first,
          itemId: offering.itemId,
          variants: [{ ...variant, variantId: offering.variantId }],
        },
      ],
    });

    await approve(changed);

    const history =
      await sql`SELECT id FROM feastjourney.restaurant_price_observations WHERE variant_id=${offering.variantId}`;

    expect(history).toHaveLength(2);
    const originalPriceId = initial.priceIds[0];

    if (originalPriceId === undefined) throw new Error("Missing original price fixture");

    const rejected =
      await sql`UPDATE feastjourney.restaurant_price_observations SET amount=1 WHERE id=${originalPriceId}`.then(
        () => false,
        () => true,
      );

    expect(rejected).toBe(true);
  });
  test("receipt derivation needs known net semantics and accounts for discounted unit prices", () => {
    const price = {
      amount: "55000",
      currency: "VND",
      kind: "paid_unit" as const,
      channel: "dine_in" as const,
      taxTreatment: "unknown" as const,
      sourceLineKey: "line",
      receipt: {
        quantity: "2",
        lineTotal: "110000",
        discount: "10000",
        taxesFees: "0",
        totalSemantics: "net_food_only" as const,
      },
    };

    expect(validateReceiptPrice(price)).toBe(true);
    expect(validateReceiptPrice({ ...price, amount: "60000" })).toBe(false);
    expect(
      validateReceiptPrice({
        ...price,
        receipt: { ...price.receipt, totalSemantics: "includes_fees" },
      }),
    ).toBe(false);
    expect(validateReceiptPrice({ ...price, receipt: { ...price.receipt, quantity: "0" } })).toBe(
      false,
    );
  });
});

describe("price provenance regression cases", () => {
  test("currency preferences are scoped to verified members; guests need no account", async () => {
    await run(withActor(actor, setPreferredCurrency("USD")));
    expect(await run(withActor(actor, getPreferredCurrency))).toMatchObject({
      member: true,
      currency: "USD",
    });
    expect(await run(withActor(member, getPreferredCurrency))).toMatchObject({
      member: true,
      currency: null,
    });
    expect(await run(withActor(Actor.Guest(), getPreferredCurrency))).toMatchObject({
      member: false,
      currency: null,
    });
  });
  test("pending imports cannot relabel an accepted offering or its comparison portion", async () => {
    const offering = initial.offeringIds[0];
    const input = inputFor(a, "1", "relabel");
    const item = input.items[0];
    const variant = item?.variants[0];

    if (offering === undefined || item === undefined || variant === undefined)
      throw new Error("Missing fixture offering");

    const failure = await run(
      Effect.flip(
        withActor(
          actor,
          importMenu({
            ...input,
            menuId: initial.menuId,
            items: [
              {
                ...item,
                itemId: offering.itemId,
                variants: [
                  {
                    ...variant,
                    variantId: offering.variantId,
                    name: "Large bowl",
                    comparisonKey: "large-bowl",
                  },
                ],
              },
            ],
          }),
        ),
      ),
    );

    expect(failure._tag).toBe("RestaurantInputError");
    const detail = await run(getRestaurant(a, "dine_in"));
    expect(
      detail.offerings.find((row) => row.variant_id === offering.variantId)?.variant_name,
    ).toBe("Regular bowl");
  });
  test("a newer receipt-paid observation cannot replace an advertised menu price", async () => {
    const offering = initial.offeringIds[0];
    const input = inputFor(a, "100", "paid");
    const item = input.items[0];

    if (offering === undefined || item === undefined) throw new Error("Missing fixture item");

    const paid = await menuImportResult(
      menuImportSchema.parse({
        ...input,
        menuId: initial.menuId,
        source: {
          ...input.source,
          category: "receipt",
          url: undefined,
          privateObjectKey: `receipt/${crypto.randomUUID()}`,
          restaurantVerified: false,
        },
        items: [
          {
            ...item,
            itemId: offering.itemId,
            variants: [
              {
                name: "Regular bowl",
                variantId: offering.variantId,
                comparisonKey: "regular-bowl",
                price: {
                  amount: "100",
                  currency: "VND",
                  kind: "paid_unit",
                  channel: "dine_in",
                  taxTreatment: "included",
                  sourceLineKey: "paid-1",
                  receipt: {
                    quantity: "2",
                    lineTotal: "200",
                    discount: "10000",
                    taxesFees: "100",
                    totalSemantics: "net_food_only",
                  },
                },
              },
            ],
          },
        ],
      }),
    );

    await approve(paid);
    const detail = await run(getRestaurant(a, "dine_in"));
    const selected = detail.offerings.find((row) => row.variant_id === offering.variantId);
    expect(selected?.amount).toBe("60000");
    expect(selected?.price_kind).toBe("listed");
    expect(JSON.stringify(detail)).not.toContain("receipt/");
  });
  test("budget FX failure is explicit while original menu retrieval stays available", async () => {
    const unavailable = FxRates.of({
      rate: () => Effect.fail(new FxUnavailable({ reason: "Synthetic FX outage" })),
      supportedCurrencies: Effect.succeed(["VND", "USD"]),
    });

    const failure = await run(
      Effect.flip(
        Effect.provideService(
          searchRestaurants(
            criteria({ dish: dishId, portion: "regular-bowl", currency: "USD", budget: "5" }),
          ),
          FxRates,
          unavailable,
        ),
      ),
    );

    expect(failure._tag).toBe("FxUnavailable");
    const detail = await run(getRestaurant(a, "dine_in"));
    expect(detail.offerings.some((row) => row.amount === "60000" && row.currency === "VND")).toBe(
      true,
    );
  });
  test("PostgreSQL rejects nonfinite/negative amounts, non-ISO currency and cross-branch sources", async () => {
    const id = initial.priceIds[0];

    if (id === undefined) throw new Error("Missing fixture price");
    await Promise.all(
      ["-1", "NaN", "Infinity"].map(async (amount) => {
        const rejected =
          await sql`INSERT INTO feastjourney.restaurant_price_observations(venue_id,variant_id,source_id,source_line_key,price_kind,amount,currency,sales_channel,tax_treatment,observed_at,review_after)
        SELECT venue_id,variant_id,source_id,${"invalid-" + amount},price_kind,${amount}::numeric,currency,sales_channel,tax_treatment,observed_at,review_after FROM feastjourney.restaurant_price_observations WHERE id=${id}`.then(
            () => false,
            () => true,
          );

        expect(rejected).toBe(true);
      }),
    );

    const invalidCurrency =
      await sql`INSERT INTO feastjourney.restaurant_price_observations(venue_id,variant_id,source_id,source_line_key,price_kind,amount,currency,sales_channel,tax_treatment,observed_at,review_after)
      SELECT venue_id,variant_id,source_id,'invalid-currency',price_kind,amount,'CNH',sales_channel,tax_treatment,observed_at,review_after FROM feastjourney.restaurant_price_observations WHERE id=${id}`.then(
        () => false,
        () => true,
      );

    expect(invalidCurrency).toBe(true);

    const wrongSource =
      await sql`INSERT INTO feastjourney.restaurant_price_observations(venue_id,variant_id,source_id,source_line_key,price_kind,amount,currency,sales_channel,tax_treatment,observed_at,review_after)
      SELECT p.venue_id,p.variant_id,s.id,'wrong-branch',p.price_kind,p.amount,p.currency,p.sales_channel,p.tax_treatment,p.observed_at,p.review_after
      FROM feastjourney.restaurant_price_observations p CROSS JOIN feastjourney.restaurant_sources s WHERE p.id=${id} AND s.venue_id=${b} LIMIT 1`.then(
        () => false,
        () => true,
      );

    expect(wrongSource).toBe(true);
  });
  test("local ranges need three current comparable venues and count each branch once", async () => {
    const before = await run(
      searchRestaurants(criteria({ dish: dishId, portion: "regular-bowl" })),
    );

    expect(before.ranges).toEqual([]);
    const detail = await run(getRestaurant(c, "dine_in"));
    const offering = detail.offerings.find((row) => row.comparison_key === "regular-bowl");
    const input = inputFor(c, "50000", "range");
    const item = input.items[0];
    const variant = item?.variants[0];

    if (offering === undefined || item === undefined || variant === undefined)
      throw new Error("Missing range fixture");

    const result = await menuImportResult({
      ...input,
      menuId: offering.menu_id,
      items: [
        {
          ...item,
          itemId: offering.item_id,
          variants: [{ ...variant, variantId: offering.variant_id }],
        },
      ],
    });

    await approve(result);
    const after = await run(searchRestaurants(criteria({ dish: dishId, portion: "regular-bowl" })));
    expect(after.ranges).toEqual([
      { currency: "VND", minimum: "50000", maximum: "65000", venue_count: 3 },
    ]);
    expect(after.dishItems.filter((row) => row.id === c)).toHaveLength(1);
  });
});

describe("PR4 remediation regressions", () => {
  test("an unpublished best association does not hide a second published match", async () => {
    const venue = await makeVenue("Published association fallback");

    const [top] =
      await sql`INSERT INTO feastjourney.dishes(slug,status) VALUES(${`pr4-top-match-${stamp}`},'published') RETURNING id::text AS id`;

    if (top === undefined) throw new Error("Missing synthetic dish fixture");

    try {
      const request = inputFor(venue, "123", "top-match");
      const first = request.items[0];

      if (first === undefined) throw new Error("Missing synthetic item fixture");

      const topImport = await menuImportResult({
        ...request,
        items: [{ ...first, dishId: top.id }],
      });

      await approve(topImport);
      const item = topImport.offeringIds[0];

      if (item === undefined) throw new Error("Missing imported item fixture");

      const alternative = await menuImportResult({
        ...inputFor(venue, null, "alternate-match"),
        menuId: topImport.menuId,
        items: [
          {
            ...first,
            itemId: item.itemId,
            dishId,
            matchKind: "variant",
            variants: [
              { name: "Regular bowl", variantId: item.variantId, comparisonKey: "regular-bowl" },
            ],
          },
        ],
      });

      await approve(alternative);
      const before = await run(getRestaurant(venue, "dine_in"));
      expect(before.offerings.every((offering) => offering.dish_id === top.id)).toBe(true);
      await sql`UPDATE feastjourney.dishes SET status='draft' WHERE id=${top.id}`;
      const after = await run(getRestaurant(venue, "dine_in"));
      expect(after.offerings).toHaveLength(2);
      expect(
        after.offerings.every(
          (offering) => offering.dish_id === dishId && offering.match_kind === "variant",
        ),
      ).toBe(true);
    } finally {
      await sql`DELETE FROM feastjourney.restaurant_serving_evidence WHERE dish_id=${top.id}`;
      await sql`DELETE FROM feastjourney.dishes WHERE id=${top.id}`;
    }
  });
  test("reviewers can publish a price-free item, while a manage-only actor cannot", async () => {
    const venue = await makeVenue("Price-free menu");
    const input = inputFor(venue, null, "price-free");

    for (const item of input.items) {
      item.dishId = undefined;

      for (const variant of item.variants) variant.price = undefined;
    }

    const imported = await menuImportResult(input);
    const item = imported.offeringIds[0];

    if (item === undefined) throw new Error("Missing price-free item fixture");
    const session = await auth.signupSignin(`pr4-manager-only-${stamp}`);
    const role = `pr4-manager-only-${stamp}`;
    await sql`INSERT INTO feastjourney.roles(id,slug,name) VALUES(${role},${role},'Synthetic manage-only role')`;

    try {
      await sql`INSERT INTO feastjourney.role_permissions(role_id,permission_key) VALUES(${role},'restaurant:manage')`;
      await auth.grantRole(session.userId, role);
      const manager = Actor.Member({ userId: session.userId });

      const denied = await run(
        withActor(
          manager,
          setOfferingStatus({ kind: "item", id: item.itemId, status: "published" }),
        ).pipe(Effect.result),
      );

      expect(Result.isFailure(denied)).toBe(true);
      expect((await run(getRestaurant(venue, "dine_in"))).offerings).toEqual([]);
      await run(
        withActor(actor, setOfferingStatus({ kind: "item", id: item.itemId, status: "published" })),
      );
      await Promise.all(
        imported.offeringIds.map((offering) =>
          run(
            withActor(
              actor,
              setOfferingStatus({ kind: "variant", id: offering.variantId, status: "published" }),
            ),
          ),
        ),
      );
      const menu = await run(getRestaurant(venue, "dine_in"));
      expect(menu.offerings).toHaveLength(2);
      expect(
        menu.offerings.every((offering) => offering.amount === null && offering.dish_id === null),
      ).toBe(true);
    } finally {
      await sql`DELETE FROM feastjourney.roles WHERE id=${role}`;
    }
  });
  test("pending menu names remain private until a fact is reviewed", async () => {
    const venue = await makeVenue("Private pending menu");
    const imported = await menuImportResult(inputFor(venue, "123", "private-pending"));
    expect((await run(getRestaurant(venue, "dine_in"))).offerings).toEqual([]);
    await approve(imported);
    expect((await run(getRestaurant(venue, "dine_in"))).offerings).toHaveLength(2);
  });

  test("a manager import cannot claim independently verified restaurant authority", async () => {
    const imported = await menuImportResult(inputFor(a, "123", "unverified-source"));

    const rows =
      await sql`SELECT restaurant_verified FROM feastjourney.restaurant_sources WHERE id=${imported.sourceId}`;

    expect(rows[0]?.restaurant_verified).toBe(false);
  });

  test("concurrent reviewer decisions have one winner and preserve its attribution", async () => {
    const imported = await menuImportResult(inputFor(a, "123", "concurrent-review"));
    const id = imported.priceIds[0];

    if (id === undefined) throw new Error("Missing price fixture");

    const decisions = await Promise.all(
      (["approved", "rejected"] as const).map((status) =>
        run(withActor(actor, reviewObservation({ kind: "price", id, status })).pipe(Effect.result)),
      ),
    );

    expect(decisions.filter(Result.isSuccess)).toHaveLength(1);
    expect(decisions.filter(Result.isFailure)).toHaveLength(1);

    const rows =
      await sql`SELECT review_status,reviewed_by,reviewed_at FROM feastjourney.restaurant_price_observations WHERE id=${id}`;

    expect(rows[0]?.reviewed_by).not.toBeNull();
    expect(rows[0]?.reviewed_at).not.toBeNull();

    const repeated = await run(
      withActor(actor, reviewObservation({ kind: "price", id, status: "approved" })).pipe(
        Effect.result,
      ),
    );

    expect(Result.isFailure(repeated)).toBe(true);

    const after =
      await sql`SELECT review_status,reviewed_by,reviewed_at FROM feastjourney.restaurant_price_observations WHERE id=${id}`;

    expect(after).toEqual(rows);
  });

  test.each(["excluded", "unknown"] as const)(
    "strict comparison excludes tax %s observations",
    async (taxTreatment) => {
      const venue = await makeVenue(`Tax ${taxTreatment}`);
      const request = inputFor(venue, "1", `tax-${taxTreatment}`);

      for (const item of request.items) {
        for (const variant of item.variants) {
          if (variant.price !== undefined) variant.price.taxTreatment = taxTreatment;
        }
      }

      const imported = await menuImportResult(request);
      await approve(imported);

      const output = await run(
        searchRestaurants(
          criteria({ dish: dishId, portion: "regular-bowl", currency: "VND", sort: "price_low" }),
        ),
      );

      expect(output.dishItems.some((row) => row.id === venue)).toBe(false);
      const menu = await run(getRestaurant(venue, "dine_in"));

      expect(
        menu.offerings.find((offering) => offering.comparison_key === "regular-bowl")?.amount,
      ).toBe("1");
    },
  );
});
