import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  DASHBOARD_TABS,
  dashboardTabLabel,
  isDashboardTab,
  RestaurantDashboard,
  type DashboardVenue,
} from "@/modules/restaurant-discovery/components/restaurant-dashboard";

const VENUE_A: DashboardVenue = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  businessId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  businessName: "Pho Thật",
  name: "Pho Thật · Hoan Kiem",
  address: "1 Hang Bong",
  area: "Hanoi",
  countryCode: "VN",
  status: "published",
  longitude: 105.85,
  latitude: 21.03,
  cuisineIds: ["cuisine-1"],
  sourceCount: 2,
  pendingCount: 1,
  pendingEvidence: 0,
};

const VENUE_B: DashboardVenue = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  businessId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  businessName: "Com Ga",
  name: "Com Ga · Old Quarter",
  address: "2 Ta Hien",
  area: "Hanoi",
  countryCode: "VN",
  status: "archived",
  longitude: 105.85,
  latitude: 21.03,
  cuisineIds: [],
  sourceCount: 0,
  pendingCount: 0,
  pendingEvidence: 0,
};

const baseProps = {
  venues: [VENUE_A, VENUE_B],
  total: 2,
  query: "",
  status: "" as const,
  offset: 0,
  busy: false,
  actionMessage: "",
  // SAFETY: the empty-selection base case carries no elements, so the
  // element type cannot be mistyped.
  selection: [] as ReadonlyArray<string>,
  cuisinesById: new Map([["cuisine-1", "Vietnamese"]]),
  onQuery: () => undefined,
  onStatus: () => undefined,
  onOffset: () => undefined,
  onToggleSelect: () => undefined,
  onToggleSelectPage: () => undefined,
  onCreate: () => undefined,
  onEdit: () => undefined,
  onManageMenus: () => undefined,
  onBulkArchive: () => undefined,
  onBulkPublish: () => undefined,
};

describe("restaurant dashboard table", () => {
  test("uses the Branch/Business/Status/Actions contract", () => {
    const html = renderToStaticMarkup(<RestaurantDashboard {...baseProps} />);

    expect(html).toContain("Branch");
    expect(html).toContain("Business");
    expect(html).toContain("Status");
    expect(html).toContain("Actions");
    expect(html).not.toContain("Cuisines");
    expect(html).not.toContain("Sources");
  });

  test("toolbar offers search, status filter, and Add restaurant", () => {
    const html = renderToStaticMarkup(<RestaurantDashboard {...baseProps} />);

    expect(html).toContain("dashboard-search");
    expect(html).toContain("dashboard-status");
    expect(html).toContain("Add restaurant");
    expect(html).not.toContain("Add branch");
  });

  test("row actions are labelled icon buttons with a 44px target", () => {
    const html = renderToStaticMarkup(<RestaurantDashboard {...baseProps} />);

    expect(html).toContain(`aria-label="Edit ${VENUE_A.name}"`);
    expect(html).toContain(`aria-label="Manage menu for ${VENUE_A.name}"`);
    expect(html).toContain(`aria-label="Manage photos for ${VENUE_A.name}"`);
    expect(html).toContain(`aria-label="Archive ${VENUE_A.name}"`);
    expect(html).toContain(`aria-label="More actions for ${VENUE_A.name}"`);
    expect(html).toContain("min-h-11 min-w-11");
  });

  test("archive is unavailable for already-archived branches", () => {
    const html = renderToStaticMarkup(<RestaurantDashboard {...baseProps} />);

    const archivedButton = html.split(`aria-label="Archive ${VENUE_B.name}"`)[1] ?? "";

    expect(archivedButton.slice(0, 200)).toContain("disabled");
  });

  test("icon actions disable without the manage grant", () => {
    const html = renderToStaticMarkup(
      <RestaurantDashboard {...baseProps} canEdit={false} canArchive={false} />,
    );

    expect(html).toContain(`aria-label="Edit ${VENUE_A.name}"`);
    expect(html.slice(html.indexOf(`aria-label="Edit ${VENUE_A.name}"`) - 200)).toContain(
      "disabled",
    );
  });
});

describe("restaurant dashboard detail tabs", () => {
  test("tab helpers cover the five-section contract", () => {
    expect(DASHBOARD_TABS).toEqual(["overview", "menu", "photos", "reviews", "sources"]);
    expect(dashboardTabLabel("overview")).toBe("Overview");
    expect(dashboardTabLabel("sources")).toBe("Sources");
    expect(isDashboardTab("menu")).toBe(true);
    expect(isDashboardTab("unknown")).toBe(false);
  });

  test("selected venue renders tabs with the active tab announced", () => {
    const html = renderToStaticMarkup(
      <RestaurantDashboard
        {...baseProps}
        selectedId={VENUE_A.id}
        activeTab="menu"
        onSelectVenue={() => undefined}
        onTabChange={() => undefined}
        renderTabPanel={(venue, tab) => (
          <p>
            {venue.name} · {tab}
          </p>
        )}
      />,
    );

    for (const label of ["Overview", "Menu", "Photos", "Reviews", "Sources"]) {
      expect(html).toContain(label);
    }

    expect(html).toContain('aria-selected="true"');
    expect(html).toContain(`${VENUE_A.name} · menu`);
  });

  test("no detail panel without a selection", () => {
    const html = renderToStaticMarkup(<RestaurantDashboard {...baseProps} />);

    expect(html).not.toContain('role="tablist"');
  });
});
