import { describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import {
  decisionDisabled,
  describeDecision,
  RestaurantReviewModeration,
  toDecisionInput,
  type CustomerReviewModerationClient,
  type ModerationQueuePage,
} from "@/modules/restaurant-discovery/components/restaurant-review-moderation";

const REVIEW_A = "11111111-1111-4111-8111-111111111111";
const REVIEW_B = "22222222-2222-4222-8222-222222222222";

const pageWith: ModerationQueuePage = {
  items: [
    {
      id: REVIEW_A,
      venueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      venueName: "Quán Phở Thật",
      rating: 5,
      body: "Broth stayed clear and rich. Verified visit, lunch rush.",
      status: "pending",
      submittedAt: "2026-10-20T08:00:00.000Z",
    },
    {
      id: REVIEW_B,
      venueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      venueName: "Cơm Gà Xối Mỡ",
      rating: 2,
      body: "Rice was dry; chicken fine. Would not repeat.",
      status: "published",
      submittedAt: "2026-10-18T08:00:00.000Z",
    },
  ],
  total: 2,
  limit: 20,
  offset: 0,
  pendingCount: 1,
};

const stubClient = (overrides: Partial<CustomerReviewModerationClient> = {}) => {
  const calls: Array<{ readonly reviewId: string; readonly status: string }> = [];

  const client: CustomerReviewModerationClient = {
    loadQueue: () => new Promise<ModerationQueuePage>(() => {}),
    decide: (input) => {
      calls.push({ reviewId: input.reviewId, status: input.status });

      return Promise.resolve({ reviewId: input.reviewId, status: input.status, repeated: false });
    },
    ...overrides,
  };

  return { client, calls };
};

const render = (node: React.ReactNode): string => {
  const queryClient = new QueryClient();

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
};

describe("customer review moderation queue", () => {
  test("hides the queue from members without the review grant", () => {
    const { client } = stubClient();
    const html = render(<RestaurantReviewModeration canReview={false} client={client} />);

    expect(html).toBe("");
  });

  test("renders the loading state before the queue resolves", () => {
    const { client } = stubClient();
    const html = render(<RestaurantReviewModeration canReview client={client} />);

    expect(html).toContain("Loading customer reviews");
    expect(html).not.toContain("Review published");
    expect(html).not.toContain("already recorded");
  });

  test("renders venue, rating, text, submitted time, and the pending count", () => {
    const { client } = stubClient({
      loadQueue: () => Promise.resolve(pageWith),
    });

    const html = render(
      <RestaurantReviewModeration canReview client={client} initialPage={pageWith} />,
    );

    expect(html).toContain("Quán Phở Thật");
    expect(html).toContain("5/5");
    expect(html).toContain("Broth stayed clear and rich");
    expect(html).toContain("2026-10-20");
    expect(html).toContain("1 pending");
    expect(html).toContain("Showing 1–2 of 2 reviews");
  });

  test("renders no stub notice: the queue is backed by the staff list endpoint", () => {
    const { client } = stubClient();

    const html = render(
      <RestaurantReviewModeration canReview client={client} initialPage={pageWith} />,
    );

    expect(html).not.toContain("not wired yet");
  });

  test("disables the already-recorded decision (duplicate-decision guard)", () => {
    const { client } = stubClient();

    const html = render(
      <RestaurantReviewModeration canReview client={client} initialPage={pageWith} />,
    );

    const publishButtons = html.match(/<button[^>]*>.*?Publish.*?<\/button>/gs) ?? [];

    expect(publishButtons.length).toBe(2);
    expect(publishButtons.some((button) => button.includes("disabled"))).toBe(true);
  });

  test("requires confirmation before remove", () => {
    const { client } = stubClient();

    const html = render(
      <RestaurantReviewModeration canReview client={client} initialPage={pageWith} />,
    );

    expect(html).toContain("Remove");
    expect(html).not.toContain("Confirm remove");
  });

  test("never edits author content: body is read-only, no success before mutation", () => {
    const { client } = stubClient();

    const html = render(
      <RestaurantReviewModeration canReview client={client} initialPage={pageWith} />,
    );

    expect(html).toContain("<blockquote");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("Review published");
    expect(html).not.toContain("Review removed");
    expect(html).not.toContain("already recorded");
  });

  test("decision payload carries the review ID only", () => {
    expect(toDecisionInput(REVIEW_A, "published")).toEqual({
      reviewId: REVIEW_A,
      status: "published",
    });
    expect(Object.keys(toDecisionInput(REVIEW_A, "removed")).toSorted()).toEqual([
      "reviewId",
      "status",
    ]);
  });

  test("duplicate-decision guard disables while pending or already decided", () => {
    expect(decisionDisabled("pending", "published", true)).toBe(true);
    expect(decisionDisabled("published", "published", false)).toBe(true);
    expect(decisionDisabled("removed", "removed", false)).toBe(true);
    expect(decisionDisabled("pending", "published", false)).toBe(false);
    expect(decisionDisabled("rejected", "published", false)).toBe(false);
    expect(decisionDisabled("published", "removed", false)).toBe(false);
  });

  test("applied and repeated decisions describe distinct outcomes", () => {
    expect(
      describeDecision({ reviewId: REVIEW_A, status: "published", repeated: false }),
    ).toContain("published");
    expect(describeDecision({ reviewId: REVIEW_A, status: "removed", repeated: false })).toContain(
      "audit",
    );
    expect(describeDecision({ reviewId: REVIEW_A, status: "published", repeated: true })).toContain(
      "already recorded",
    );
  });
});
