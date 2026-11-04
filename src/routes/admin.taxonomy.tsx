import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { CuisinePanel } from "@/components/admin/taxonomy/cuisine-panel";
import { IngredientPanel } from "@/components/admin/taxonomy/ingredient-panel";
import { unimplementedTaxonomyClient } from "@/components/admin/taxonomy/taxonomy-contracts";
import { AdminPageHeading, AdminRouteError } from "@/components/admin/ui";
import { authorizeFn } from "@/modules/user/admin.functions";
import { getSessionFn } from "@/modules/user/session.functions";
import { localeSearchSchema, type Locale } from "@/shared/i18n";

const rootRoute = getRouteApi("__root__");

export const Route = createFileRoute("/admin/taxonomy")({
  validateSearch: localeSearchSchema,
  beforeLoad: async ({ search }) => {
    const session = await getSessionFn();

    if (session.user === null) {
      throw redirect({
        to: "/sign-in",
        search: { returnTo: "/admin/taxonomy", lang: search.lang },
      });
    }

    const { allowed } = await authorizeFn({
      data: { checks: [{ resource: "food", actions: ["read"] }] },
    });

    if (!allowed) {
      throw redirect({ to: "/", search: { lang: search.lang } });
    }

    return {};
  },
  component: AdminTaxonomy,
  errorComponent: AdminRouteError,
});

type TaxonomyTab = "cuisines" | "ingredients";

/**
 * Feast Lab taxonomy workspace: cuisines + ingredients tabs sharing one
 * panel contract. List/search/add/bulk-add run through `TaxonomyClient`.
 *
 * TODO(contract): `feat/admin-taxonomy` owns the six server functions
 * (`listCuisinesFn`, `createCuisineFn`, `bulkCreateCuisinesFn`,
 * `listIngredientsFn`, `createIngredientFn`, `bulkCreateIngredientsFn` in
 * `@/modules/food-discovery/admin.functions.ts`). Until it lands, both tabs
 * render against `unimplementedTaxonomyClient` and surface the honest
 * error state; swapping to the real wiring is a one-line client change at
 * the coordinator merge.
 *
 * Note: no `/admin/taxonomy` entry exists in the shared `adminNavEntries`
 * union (`components/admin/ui`, outside this workstream's ownership), so the
 * page is reachable by direct URL until the coordinator extends the nav.
 */
function AdminTaxonomy(): ReactNode {
  const { lang } = rootRoute.useSearch();
  const locale: Locale = lang === "vi" ? "vi" : "en";
  const vi = locale === "vi";
  const [tab, setTab] = useState<TaxonomyTab>("cuisines");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AdminPageHeading
        title={vi ? "Phân loại" : "Taxonomy"}
        description={
          vi
            ? "Quản lý cuisine và nguyên liệu chuẩn cho catalog."
            : "Manage the canonical cuisines and ingredients used across the catalog."
        }
      />
      <div
        role="tablist"
        aria-label={vi ? "Phân loại" : "Taxonomy"}
        className="flex flex-wrap gap-2"
      >
        <TabButton
          active={tab === "cuisines"}
          label={vi ? "Cuisine" : "Cuisines"}
          tabId="taxonomy-tab-cuisines"
          panelId="taxonomy-panel-cuisines"
          onSelect={() => {
            setTab("cuisines");
          }}
        />
        <TabButton
          active={tab === "ingredients"}
          label={vi ? "Nguyên liệu" : "Ingredients"}
          tabId="taxonomy-tab-ingredients"
          panelId="taxonomy-panel-ingredients"
          onSelect={() => {
            setTab("ingredients");
          }}
        />
      </div>
      <div
        role="tabpanel"
        id={tab === "cuisines" ? "taxonomy-panel-cuisines" : "taxonomy-panel-ingredients"}
        aria-labelledby={tab === "cuisines" ? "taxonomy-tab-cuisines" : "taxonomy-tab-ingredients"}
      >
        {tab === "cuisines" ? (
          <CuisinePanel client={unimplementedTaxonomyClient} lang={locale} />
        ) : (
          <IngredientPanel client={unimplementedTaxonomyClient} lang={locale} />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  label,
  onSelect,
  panelId,
  tabId,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onSelect: () => void;
  readonly panelId: string;
  readonly tabId: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      id={tabId}
      aria-selected={active}
      aria-controls={panelId}
      onClick={onSelect}
      className="inline-flex min-h-11 shrink-0 cursor-pointer items-center rounded-full border border-border-soft bg-white px-4 text-sm font-semibold text-ink hover:bg-cream aria-[selected=true]:border-food-orange aria-[selected=true]:bg-cream aria-[selected=true]:font-bold aria-[selected=true]:text-food-orange-dark"
    >
      {label}
    </button>
  );
}
