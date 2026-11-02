import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatReviewDate,
  RestaurantReviewCard,
  sortCustomerReviews,
  type RestaurantCustomerReview,
} from "@/modules/restaurant-discovery/components/restaurant-review-card";
import {
  reviewFailureKind,
  validateCustomerReviewForm,
} from "@/modules/restaurant-discovery/components/restaurant-review-form";
import {
  distributionPercent,
  formatReviewAverage,
  RestaurantReviewSummary,
} from "@/modules/restaurant-discovery/components/restaurant-review-summary";

const review = (overrides: Partial<RestaurantCustomerReview>): RestaurantCustomerReview => ({
  id: "11111111-1111-4111-8111-111111111111",
  venue_id: "22222222-2222-4222-8222-222222222222",
  author_id: "author-traveler",
  rating: 4,
  body: "Lovely pho, quick service.",
  status: "published",
  created_at: "2026-10-20T10:00:00.000Z",
  updated_at: "2026-10-20T10:00:00.000Z",
  published_at: "2026-10-21T10:00:00.000Z",
  ...overrides,
});

const noop = (): void => {};

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

describe("review sort and filter logic", () => {
  const rows = [
    review({ id: "a", rating: 2, published_at: "2026-10-22T10:00:00.000Z" }),
    review({ id: "b", rating: 5, published_at: "2026-10-20T10:00:00.000Z" }),
    review({ id: "c", rating: 5, published_at: "2026-10-23T10:00:00.000Z" }),
  ];

  test("recent keeps server order", () => {
    expect(sortCustomerReviews(rows, "recent").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  test("highest and lowest order by rating with newest first on ties", () => {
    expect(sortCustomerReviews(rows, "highest").map((entry) => entry.id)).toEqual(["c", "b", "a"]);
    expect(sortCustomerReviews(rows, "lowest").map((entry) => entry.id)).toEqual(["a", "c", "b"]);
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
        review: review({ author_id: "user-uuid-9f3a", body: "Loved the broth." }),
        locale: "en",
        isAuthor: false,
        actionPending: false,
        onEdit: noop,
        onDelete: noop,
      }),
    );

    expect(html).toContain("Fellow traveler");
    expect(html).not.toContain("user-uuid-9f3a");
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("Edit");
    expect(html).not.toContain("Delete");
  });

  test("author sees edit and delete controls", () => {
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
