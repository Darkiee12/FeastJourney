import { useState, type ReactNode } from "react";

import {
  GatedEditTrigger,
  SectionDialog,
  useEditSave,
} from "@/components/admin/dish/section-editor";
import { AdminField } from "@/components/admin/ui";
import type { Locale, Messages } from "@/shared/i18n";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const splitSlugs = (input: string): ReadonlyArray<string> =>
  input
    .split(/[,;]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

const sortedJoin = (slugs: ReadonlyArray<string>): string => slugs.toSorted().join(",");

/**
 * Taxonomy editor via `adminUpdateDishTaxonomyFn`: cuisine + category slug
 * lists. Both fields always ship when dirty (replace semantics); only
 * lowercase alphanumeric-and-hyphen slugs validate.
 */
export function DishTaxonomyEditor({
  categories,
  copy,
  cuisines,
  dishId,
  lang,
}: {
  readonly categories: ReadonlyArray<{ readonly slug: string }>;
  readonly copy: Messages;
  readonly cuisines: ReadonlyArray<{ readonly slug: string }>;
  readonly dishId: string;
  readonly lang: Locale;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const snapshotCuisines = sortedJoin(cuisines.map((entry) => entry.slug));
  const snapshotCategories = sortedJoin(categories.map((entry) => entry.slug));

  const [draftCuisines, setDraftCuisines] = useState(
    cuisines.map((entry) => entry.slug).join(", "),
  );

  const [draftCategories, setDraftCategories] = useState(
    categories.map((entry) => entry.slug).join(", "),
  );

  const { error, pending, save } = useEditSave({
    copy,
    fnName: "adminUpdateDishTaxonomyFn",
    onSaved: () => {
      setOpen(false);
    },
  });

  const cuisineSlugs = splitSlugs(draftCuisines);
  const categorySlugs = splitSlugs(draftCategories);

  const invalid =
    cuisineSlugs.some((slug) => !SLUG_PATTERN.test(slug)) ||
    categorySlugs.some((slug) => !SLUG_PATTERN.test(slug));

  const snapshotCuisineSet = new Set(snapshotCuisines === "" ? [] : snapshotCuisines.split(","));

  const snapshotCategorySet = new Set(
    snapshotCategories === "" ? [] : snapshotCategories.split(","),
  );

  const draftCuisineSet = new Set(cuisineSlugs);
  const draftCategorySet = new Set(categorySlugs);

  const dirty =
    [...draftCuisineSet].some((slug) => !snapshotCuisineSet.has(slug)) ||
    [...snapshotCuisineSet].some((slug) => !draftCuisineSet.has(slug)) ||
    [...draftCategorySet].some((slug) => !snapshotCategorySet.has(slug)) ||
    [...snapshotCategorySet].some((slug) => !draftCategorySet.has(slug));

  const openDialog = (): void => {
    setDraftCuisines(cuisines.map((entry) => entry.slug).join(", "));
    setDraftCategories(categories.map((entry) => entry.slug).join(", "));
    setOpen(true);
  };

  const handleSave = (): void => {
    if (invalid) {
      return;
    }

    save({
      dishId,
      cuisineUpsert: [...draftCuisineSet].filter((slug) => !snapshotCuisineSet.has(slug)),
      cuisineRemove: [...snapshotCuisineSet].filter((slug) => !draftCuisineSet.has(slug)),
      categoryUpsert: [...draftCategorySet].filter((slug) => !snapshotCategorySet.has(slug)),
      categoryRemove: [...snapshotCategorySet].filter((slug) => !draftCategorySet.has(slug)),
    });
  };

  return (
    <>
      <GatedEditTrigger copy={copy} fnName="adminUpdateDishTaxonomyFn" onOpen={openDialog} />
      {open ? (
        <SectionDialog
          canSave={!invalid}
          copy={copy}
          dirty={dirty}
          error={error}
          lang={lang}
          onClose={() => {
            setOpen(false);
          }}
          onSave={handleSave}
          open={open}
          pending={pending}
          title={`${copy.adminCuisines} · ${copy.adminCategories}`}
        >
          <AdminField
            id="dish-cuisine-slugs"
            label={copy.adminCuisineSlugs}
            value={draftCuisines}
            onChange={(event) => {
              setDraftCuisines(event.target.value);
            }}
            error={invalid ? copy.adminSaveFailed : null}
          />
          <AdminField
            id="dish-category-slugs"
            label={copy.adminCategorySlugs}
            value={draftCategories}
            onChange={(event) => {
              setDraftCategories(event.target.value);
            }}
            error={invalid ? copy.adminSaveFailed : null}
          />
          <p className="text-sm text-muted">{copy.adminSlugsHint}</p>
        </SectionDialog>
      ) : null}
    </>
  );
}
