import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatReviewDate,
  RestaurantReviewCard,
} from "@/modules/restaurant-discovery/components/restaurant-review-card";
import type { RestaurantCustomerReview } from "@/modules/restaurant-discovery/components/restaurant-review-card";
import {
  parseReviewWriteIntent,
  reviewFailureKind,
  reviewWriteIntentKey,
  serializeReviewWriteIntent,
  validateCustomerReviewForm,
} from "@/modules/restaurant-discovery/components/restaurant-review-form";
import {
  distributionPercent,
  formatReviewAverage,
  RestaurantReviewSummary,
} from "@/modules/restaurant-discovery/components/restaurant-review-summary";
import {
  customerReviewListKey,
  nextCustomerReviewPageParam,
} from "@/modules/restaurant-discovery/components/restaurant-reviews-panel";
import type { CustomerReviewPublicPage } from "@/modules/restaurant-discovery/restaurant-reviews.schema";

const review = (overrides: Partial<RestaurantCustomerReview>): RestaurantCustomerReview => ({
  id: "11111111-1111-4111-8111-111111111111",
  rating: 4,
  body: "Lovely pho, quick service.",
  created_at: "2026-10-20T10:00:00.000Z",
  published_at: "2026-10-21T10:00:00.000Z",
  ...overrides,
});

const page = (overrides: Partial<CustomerReviewPublicPage>): CustomerReviewPublicPage => ({
  items: [],
  total: 0,
  limit: 10,
  offset: 0,
  ...overrides,
});

const noop = (): void => {};

const items = (count: number): CustomerReviewPublicPage["items"] =>
  Array.from({ length: count }, (_, index) =>
    review({ id: `review-${index}`, rating: 4, body: `Body ${index}` }),
  );

describe("review form validation", () => {
  test("accepts a 1–5 rating with 1–2000 character text", () => {
    expect(validateCustomerReviewForm(5, "Wonderful dinner.")).toEqual({});
    expect(validateCustomerReviewForm(1, "x".repeat(2000))).toEqual({});
  });

  test("rejects missing and out-of-range ratings", () => {
    expect(validateCustomerReviewForm(null, "Fine.").rating).toBeString();
    expect(validateCustomerReviewForm(0, "Fine.").rating).toBeString();
    expect(validateCustomerReviewForm(6, "Fine.").rating).toBeString();
    expect(validateCustomerReviewForm(2.5, "Fine.").rating).toBeString();
  });

  test("rejects empty text and text over 2000 characters", () => {
    expect(validateCustomerReviewForm(4, "").body).toBeString();
    expect(validateCustomerReviewForm(4, "   ").body).toBeString();
    expect(validateCustomerReviewForm(4, "x".repeat(2001)).body).toBeString();
  });
});

describe("review failure mapping", () => {
  test("only the sign-in tag switches to the sign-in prompt", () => {
    expect(reviewFailureKind("SignInRequired")).toBe("sign-in");
    expect(reviewFailureKind("CustomerReviewValidationFailed")).toBe("message");
    expect(reviewFailureKind("CustomerReviewConflict")).toBe("message");
    expect(reviewFailureKind("NotReviewAuthor")).toBe("message");
    expect(reviewFailureKind("UnknownVenue")).toBe("message");
    expect(reviewFailureKind(null)).toBe("message");
  });
});

describe("review list query keys", () => {
  const venueId = "22222222-2222-4222-8222-222222222222";

  test("the sort rides in the key so sorts never share a cache", () => {
    expect(customerReviewListKey(venueId, "recent")).toEqual([
      "customer-reviews",
      venueId,
      "recent",
    ]);
    expect(customerReviewListKey(venueId, "highest")).not.toEqual(
      customerReviewListKey(venueId, "recent"),
    );
    expect(customerReviewListKey(venueId, "lowest")).not.toEqual(
      customerReviewListKey(venueId, "highest"),
    );
  });

  test("every list key carries the venue invalidation prefix", () => {
    const sorts = ["recent", "highest", "lowest"] as const;

    for (const sort of sorts) {
      expect(customerReviewListKey(venueId, sort).slice(0, 2)).toEqual([
        "customer-reviews",
        venueId,
      ]);
    }
  });

  test("different venues never share a key", () => {
    expect(customerReviewListKey(venueId, "recent")).not.toEqual(
      customerReviewListKey("33333333-3333-4333-8333-333333333333", "recent"),
    );
  });
});

describe("review page cursor", () => {
  test("advances by the page limit while rows remain", () => {
    expect(
      nextCustomerReviewPageParam(page({ items: items(10), total: 25, limit: 10, offset: 0 })),
    ).toBe(10);
    expect(
      nextCustomerReviewPageParam(page({ items: items(10), total: 25, limit: 10, offset: 10 })),
    ).toBe(20);
  });

  test("stops at the exact end of the total", () => {
    expect(
      nextCustomerReviewPageParam(page({ items: items(5), total: 25, limit: 10, offset: 20 })),
    ).toBeUndefined();
  });

  test("an empty page with a zero total stops instead of looping", () => {
    expect(
      nextCustomerReviewPageParam(page({ items: [], total: 0, limit: 10, offset: 0 })),
    ).toBeUndefined();
  });
});

describe("write intent parking", () => {
  test("intent keys are venue-scoped", () => {
    expect(reviewWriteIntentKey("venue-a")).toBe("rv-write-intent:venue-a");
    expect(reviewWriteIntentKey("venue-a")).not.toBe(reviewWriteIntentKey("venue-b"));
  });

  test("a draft round-trips through serialization", () => {
    expect(
      parseReviewWriteIntent(serializeReviewWriteIntent({ rating: 5, body: "Great pho." })),
    ).toEqual({
      rating: 5,
      body: "Great pho.",
    });
  });

  test("an empty intent round-trips for the bare sign-in handoff", () => {
    expect(parseReviewWriteIntent(serializeReviewWriteIntent({ rating: null, body: "" }))).toEqual({
      rating: null,
      body: "",
    });
  });

  test("drops null, malformed, and out-of-range payloads", () => {
    expect(parseReviewWriteIntent(null)).toBeNull();
    expect(parseReviewWriteIntent("")).toBeNull();
    expect(parseReviewWriteIntent("{not-json")).toBeNull();
    expect(parseReviewWriteIntent(JSON.stringify({ rating: 9, body: "Fine." }))).toBeNull();
    expect(parseReviewWriteIntent(JSON.stringify({ rating: 2.5, body: "Fine." }))).toBeNull();
    expect(parseReviewWriteIntent(JSON.stringify({ rating: "5", body: "Fine." }))).toBeNull();
    expect(
      parseReviewWriteIntent(JSON.stringify({ rating: 3, body: "x".repeat(2002) })),
    ).toBeNull();
  });
});

describe("review summary", () => {
  test("distribution shares never divide by zero and cap at 100", () => {
    expect(distributionPercent(0, 0)).toBe(0);
    expect(distributionPercent(3, 0)).toBe(0);
    expect(distributionPercent(2, 4)).toBe(50);
    expect(distributionPercent(9, 4)).toBe(100);
  });

  test("average formats with one decimal", () => {
    expect(formatReviewAverage(4.25, "en")).toBe("4.3");
  });

  test("empty summary invites the first review and never shows 0.0", () => {
    const html = renderToStaticMarkup(
      createElement(RestaurantReviewSummary, {
        summary: { venueId: "v", total: 0, average: 0, distribution: [] },
        isPending: false,
        locale: "en",
      }),
    );

    expect(html).toContain("No reviews yet. Be the first");
    expect(html).not.toContain("0.0");
  });

  test("pending summary renders a skeleton region", () => {
    const html = renderToStaticMarkup(
      createElement(RestaurantReviewSummary, { summary: null, isPending: true, locale: "en" }),
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading review summary");
  });

  test("published summary shows the exact count and server bars", () => {
    const html = renderToStaticMarkup(
      createElement(RestaurantReviewSummary, {
        summary: {
          venueId: "v",
          total: 3,
          average: 4,
          distribution: [
            { stars: 1, count: 0 },
            { stars: 2, count: 0 },
            { stars: 3, count: 1 },
            { stars: 4, count: 1 },
            { stars: 5, count: 1 },
          ],
        },
        isPending: false,
        locale: "en",
      }),
    );

    expect(html).toContain("Based on 3 published reviews");
    expect(html).toContain("of 3 reviews gave 5 stars");
    expect(html).toContain("4.0");
  });
});

describe("review card", () => {
  test("uses a neutral traveler label and never renders author identity metadata", () => {
    const html = renderToStaticMarkup(
      createElement(RestaurantReviewCard, {
        review: review({ body: "Loved the broth." }),
        locale: "en",
        isAuthor: false,
        actionPending: false,
        onEdit: noop,
        onDelete: noop,
      }),
    );

    expect(html).toContain("Fellow traveler");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("Edit");
    expect(html).not.toContain("Delete");
  });

  test("author sees the your-review label with edit and delete controls", () => {
    const html = renderToStaticMarkup(
      createElement(RestaurantReviewCard, {
        review: review({}),
        locale: "en",
        isAuthor: true,
        actionPending: false,
        onEdit: noop,
        onDelete: noop,
      }),
    );

    expect(html).toContain("Your review");
    expect(html).toContain("Edit");
    expect(html).toContain("Delete");
  });

  test("pending actions disable author controls", () => {
    const html = renderToStaticMarkup(
      createElement(RestaurantReviewCard, {
        review: review({}),
        locale: "en",
        isAuthor: true,
        actionPending: true,
        onEdit: noop,
        onDelete: noop,
      }),
    );

    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
  });

  test("dates localize and malformed input never throws", () => {
    expect(formatReviewDate("2026-10-21T10:00:00.000Z", "en")).toContain("2026");
    expect(formatReviewDate("not-a-date", "en")).toBe("not-a-date");
  });
});
