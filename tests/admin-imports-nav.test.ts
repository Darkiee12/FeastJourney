import { describe, expect, test } from "bun:test";

import { adminNavEntries, isAdminRouteMatch } from "@/components/admin/ui";
import { NO_ADMIN_CAPABILITIES } from "@/modules/user/admin.functions";
import type { AdminCapabilities } from "@/modules/user/admin.functions";
import { messagesFor } from "@/shared/i18n";

/**
 * Feast Lab navbar mode + capability gating. Pure unit tests over the
 * shared source of truth in components/admin/ui — no DB, no server.
 */

const copy = messagesFor("en");

const full: AdminCapabilities = {
  admin: true,
  dishes: true,
  imports: true,
  members: true,
  overview: true,
  reviews: true,
  roles: true,
};

describe("isAdminRouteMatch", () => {
  test("matches the admin shell and its sections", () => {
    expect(isAdminRouteMatch(["__root__", "/admin"])).toBe(true);
    expect(isAdminRouteMatch(["__root__", "/admin", "/admin/imports"])).toBe(true);
    expect(isAdminRouteMatch(["__root__", "/admin", "/admin/imports/$jobId"])).toBe(true);
  });

  test("rejects public routes and lookalikes", () => {
    expect(isAdminRouteMatch(["__root__", "/"])).toBe(false);
    expect(isAdminRouteMatch([])).toBe(false);
    expect(isAdminRouteMatch(["__root__", "/administrator"])).toBe(false);
    expect(isAdminRouteMatch(["__root__", "/adminx/imports"])).toBe(false);
  });
});

describe("adminNavEntries", () => {
  test("hides everything without capabilities", () => {
    expect(adminNavEntries(NO_ADMIN_CAPABILITIES, copy)).toEqual([]);
  });

  test("exposes all seven sections with dashboard exact", () => {
    const entries = adminNavEntries(full, copy);

    expect(entries.map((entry) => entry.to)).toEqual([
      "/admin",
      "/admin/dishes",
      "/admin/places",
      "/admin/imports",
      "/admin/reviews",
      "/admin/users",
      "/admin/roles",
    ]);
    expect(entries[0]?.exact).toBe(true);
    expect(entries.slice(1).every((entry) => !entry.exact)).toBe(true);
  });

  test("dishes capability gates the places registry alongside dishes", () => {
    const curator: AdminCapabilities = { ...NO_ADMIN_CAPABILITIES, dishes: true };

    expect(adminNavEntries(curator, copy).map((entry) => entry.to)).toEqual([
      "/admin/dishes",
      "/admin/places",
    ]);
  });

  test("importer-only sees only imports", () => {
    const importer: AdminCapabilities = { ...NO_ADMIN_CAPABILITIES, imports: true };

    expect(adminNavEntries(importer, copy).map((entry) => entry.to)).toEqual(["/admin/imports"]);
  });

  test("labels come from the active locale copy", () => {
    const vi = messagesFor("vi");
    const entries = adminNavEntries(full, vi);

    expect(entries[0]?.label).toBe(vi.adminDashboard);
    expect(entries[2]?.label).toBe(vi.adminPlaces);
    expect(entries[3]?.label).toBe(vi.adminImports);
  });
});
