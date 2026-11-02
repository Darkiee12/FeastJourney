import { describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import {
  RestaurantEditor,
  type EditorCuisine,
  type EditorSource,
  type EditorVenue,
} from "@/modules/restaurant-discovery/components/restaurant-editor";

const VENUE: EditorVenue = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  businessId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  businessName: "Pho Thật",
  name: "Pho Thật · Hoan Kiem",
  address: "1 Hang Bong",
  area: "Hanoi",
  countryCode: "VN",
  longitude: 105.85,
  latitude: 21.03,
  status: "draft",
  cuisineIds: [],
};

const CUISINES: ReadonlyArray<EditorCuisine> = [
  { id: "cuisine-1", slug: "vietnamese", displayName: "Vietnamese" },
];

const SOURCES: ReadonlyArray<EditorSource> = [
  {
    id: "source-1",
    category: "official_menu",
    sourceUrl: "https://example.com/menu",
    observedAt: "2026-10-01T00:00:00.000Z",
    validUntil: "2027-10-01T00:00:00.000Z",
    eligible: true,
    priceCount: 3,
    pendingPrices: 1,
    pendingEvidence: 0,
  },
];

const baseProps = {
  venue: VENUE,
  businesses: [],
  businessQuery: "",
  cuisines: CUISINES,
  sources: SOURCES,
  busy: false,
  error: "",
  canPublish: false,
  onSearchBusinesses: () => undefined,
  onSubmit: () => undefined,
  onClose: () => undefined,
};

const readSource = async (path: string): Promise<string> => Bun.file(path).text();

const render = (node: React.ReactNode): string => {
  const queryClient = new QueryClient();

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
};

describe("restaurant editor", () => {
  test("closed editor renders nothing", () => {
    const html = render(<RestaurantEditor {...baseProps} open={false} venue={null} />);

    expect(html).toBe("");
  });

  test("editing shows sources with an anchor for the Sources tab", async () => {
    // The editor body renders inside a Radix Dialog portal, which has no
    // DOM container under renderToStaticMarkup — so the anchor contract is
    // pinned at the source level (same readSource pattern as map-ux.test).
    const source = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-editor.tsx",
    );

    expect(source).toContain("Edit branch · ");
    expect(source).toContain('id="restaurant-editor-sources"');
    expect(source).toContain("source.category");
    expect(source).toContain("Review source");
  });

  test("photos section stays hidden until the route injects its client", async () => {
    const source = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-editor.tsx",
    );

    expect(source).toContain("photoClient !== undefined");
    expect(source).toContain('id="restaurant-editor-photos"');
  });

  test("injected photo client reveals the anchored photos section", async () => {
    const source = await readSource(
      "src/modules/restaurant-discovery/components/restaurant-editor.tsx",
    );

    expect(source).toContain("canManagePhotos");
    expect(source).toContain("client={photoClient}");
    expect(source).toContain('id="restaurant-editor-photos"');
    expect(source).toContain("Photos");
  });
});
