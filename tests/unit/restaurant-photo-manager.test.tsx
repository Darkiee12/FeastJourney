import { describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import {
  describePhotoDecision,
  missingPhotoEvidence,
  photoActionDisabled,
  restaurantPhotoListKey,
  restaurantPhotoReviewKey,
  RestaurantPhotoManager,
  toPhotoIdInput,
  type ManagedRestaurantPhoto,
  type RestaurantPhotoManagerClient,
} from "@/modules/restaurant-discovery/components/restaurant-photo-manager";

const VENUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const PHOTO_A: ManagedRestaurantPhoto = {
  id: "11111111-1111-4111-8111-111111111111",
  venueId: VENUE_ID,
  venueName: "Quán Phở Thật",
  status: "published",
  sortOrder: 0,
  isPrimary: true,
  altText: "Storefront at lunch, Vietnamese sign visible",
  attribution: "Photo by Linh Nguyen",
  description: null,
  license: "own-work",
  focalX: 0.5,
  focalY: 0.4,
  sourceUrl: "https://example.com/source-a",
  deliveryUrl: "https://cdn.example.com/a-1600.webp",
  previewUrl: null,
  processing: "ready",
  blockReasons: [],
};

const PHOTO_B: ManagedRestaurantPhoto = {
  id: "22222222-2222-4222-8222-222222222222",
  venueId: VENUE_ID,
  venueName: "Quán Phở Thật",
  status: "draft",
  sortOrder: 1,
  isPrimary: false,
  altText: null,
  attribution: null,
  description: "Evening crowd near the entrance",
  license: "unknown",
  focalX: null,
  focalY: null,
  sourceUrl: null,
  deliveryUrl: null,
  previewUrl: "https://cdn.example.com/b-preview.webp?preview=1",
  processing: "ready",
  blockReasons: [],
};

const OTHER_VENUE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const QUEUE_ROWS: ReadonlyArray<ManagedRestaurantPhoto> = [
  {
    ...PHOTO_A,
    status: "review",
    isPrimary: false,
    venueName: "Quán Phở Thật",
  },
  {
    ...PHOTO_B,
    status: "review",
  },
  {
    ...PHOTO_A,
    id: "33333333-3333-4333-8333-333333333333",
    venueId: OTHER_VENUE_ID,
    venueName: "Other Branch",
    status: "review",
    isPrimary: false,
  },
];

const stubClient = (
  overrides: Partial<RestaurantPhotoManagerClient> = {},
): RestaurantPhotoManagerClient => ({
  listVenuePhotos: () => Promise.resolve([PHOTO_A, PHOTO_B]),
  listPhotoReviewQueue: () => Promise.resolve(QUEUE_ROWS),
  stageVenuePhoto: () => Promise.resolve(PHOTO_A),
  updatePhotoMetadata: () => Promise.resolve(PHOTO_A),
  reorderPhotos: () => Promise.resolve([PHOTO_A, PHOTO_B]),
  submitPhotoForReview: () => Promise.resolve(PHOTO_A),
  publishPhoto: () => Promise.resolve(PHOTO_A),
  withdrawPhoto: () => Promise.resolve(PHOTO_A),
  deletePhoto: () => Promise.resolve({ id: PHOTO_A.id, venueId: VENUE_ID }),
  previewPhoto: () => Promise.resolve("https://cdn.example.com/preview.webp"),
  ...overrides,
});

const render = (node: React.ReactNode): string => {
  const queryClient = new QueryClient();

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
};

const manager = (overrides: Partial<Parameters<typeof RestaurantPhotoManager>[0]> = {}) =>
  render(
    <RestaurantPhotoManager
      venueId={VENUE_ID}
      venueName="Quán Phở Thật"
      canManage
      canReview
      client={stubClient()}
      initialPhotos={[PHOTO_A, PHOTO_B]}
      initialQueue={QUEUE_ROWS}
      {...overrides}
    />,
  );

describe("restaurant photo manager", () => {
  test("query keys carry the admin prefix and venue scope", () => {
    expect(restaurantPhotoListKey(VENUE_ID)).toEqual(["admin", "restaurant-photos", VENUE_ID]);
    expect(restaurantPhotoListKey(VENUE_ID)).not.toEqual(
      restaurantPhotoListKey("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    );

    const key = restaurantPhotoReviewKey(VENUE_ID);

    expect(key).toEqual(["admin", "restaurant-photos", "review-queue", VENUE_ID]);
  });

  test("client boundary mirrors the transport names and window shape", async () => {
    const client = stubClient();
    const rows = await client.listPhotoReviewQueue({ limit: 20, offset: 0 });

    expect(rows.length).toBe(3);

    const staged = await client.stageVenuePhoto({
      venueId: VENUE_ID,
      file: new File(["bytes"], "venue.webp", { type: "image/webp" }),
      altText: null,
      attribution: null,
      description: null,
      license: "unknown",
      sourceUrl: null,
      focalX: null,
      focalY: null,
      makePrimary: false,
    });

    expect(staged.id).toBe(PHOTO_A.id);

    const preview = await client.previewPhoto({ photoId: PHOTO_A.id });

    expect(preview).toContain("https://");
  });

  test("renders the photo grid with alt text, status, and the primary flag on the first photo", () => {
    const html = manager();

    expect(html).toContain("Storefront at lunch");
    expect(html).toContain("published");
    expect(html).toContain("Primary");
    expect(html).toContain("Position 1 of 2");
    expect(html).toContain("Position 2 of 2");
  });

  test("renders an empty state instead of an empty grid", () => {
    const html = manager({ initialPhotos: [] });

    expect(html).toContain("No venue photos yet");
    expect(html).not.toContain("Position 1 of");
  });

  test("unpublished photos stay staff-only: the lede says guests see published photos only", () => {
    const html = manager();

    expect(html).toContain("guests see");
    expect(html).toContain("published photos only");
  });

  test("upload area is hidden from members without the manage grant", () => {
    const html = manager({ canManage: false });

    expect(html).not.toContain("Choose photo");
    expect(html).not.toContain("Upload photo");
  });

  test("review queue is hidden from members without the review grant", () => {
    const html = manager({ canReview: false });

    expect(html).not.toContain("Photo review queue");
  });

  test("review queue shows this venue's images with source evidence and block reasons", () => {
    const html = manager();

    expect(html).toContain("Photo review queue");
    expect(html).toContain("2 photos awaiting review for this venue");
    expect(html).toContain("Review source");
    expect(html).toContain("https://example.com/source-a");
  });

  test("review queue filters the transport window to the edited venue", () => {
    const html = manager();

    expect(html).toContain("Quán Phở Thật");
    expect(html).not.toContain("Other Branch");
  });

  test("incomplete photos list publish blockers with source evidence guidance", () => {
    const html = manager();

    expect(html).toContain("attribution is required to publish");
    expect(html).toContain("alt text is required to publish");
  });

  test("delete requires confirmation before the destructive action", () => {
    const html = manager();

    expect(html).toContain("Delete");
    expect(html).not.toContain("Confirm delete");
  });

  test("no success notice renders before any mutation settles", () => {
    const html = manager();

    expect(html).not.toContain("Photo published");
    expect(html).not.toContain("Photo uploaded");
    expect(html).not.toContain("Photo metadata saved");
    expect(html).not.toContain("already recorded");
  });

  test("decision payloads carry the photo ID only", () => {
    expect(toPhotoIdInput(PHOTO_A.id)).toEqual({ photoId: PHOTO_A.id });
    expect(Object.keys(toPhotoIdInput(PHOTO_A.id))).toEqual(["photoId"]);
  });

  test("lifecycle guard disables while pending or when the state cannot move", () => {
    expect(photoActionDisabled("draft", "submit", true)).toBe(true);
    expect(photoActionDisabled("review", "submit", false)).toBe(true);
    expect(photoActionDisabled("published", "submit", false)).toBe(true);
    expect(photoActionDisabled("draft", "submit", false)).toBe(false);

    expect(photoActionDisabled("published", "publish", false)).toBe(true);
    expect(photoActionDisabled("draft", "publish", false)).toBe(false);
    expect(photoActionDisabled("review", "publish", true)).toBe(true);

    expect(photoActionDisabled("draft", "withdraw", false)).toBe(true);
    expect(photoActionDisabled("published", "withdraw", false)).toBe(false);
    expect(photoActionDisabled("review", "withdraw", false)).toBe(false);

    expect(photoActionDisabled("published", "remove", false)).toBe(false);
    expect(photoActionDisabled("draft", "remove", true)).toBe(true);
  });

  test("missing evidence mirrors the server publish gate", () => {
    expect(missingPhotoEvidence(PHOTO_A)).toEqual([]);
    expect(missingPhotoEvidence(PHOTO_B)).toContain("attribution is required to publish");
    expect(missingPhotoEvidence(PHOTO_B)).toContain("alt text is required to publish");
    expect(missingPhotoEvidence(PHOTO_B)).toContain(
      "photo is draft; submit it for review before publishing",
    );
    expect(missingPhotoEvidence({ ...PHOTO_A, processing: "processing" })).toContain(
      "photo is processing; finalize processing before publishing",
    );
  });

  test("decisions describe distinct outcomes without leaking internals", () => {
    expect(describePhotoDecision("published", false)).toContain("published");
    expect(describePhotoDecision("removed", false)).toContain("audit");
    expect(describePhotoDecision("withdrawn", false)).toContain("revoked");
    expect(describePhotoDecision("published", true)).toContain("already recorded");
  });
});
