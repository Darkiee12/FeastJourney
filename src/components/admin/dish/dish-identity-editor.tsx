import { useState, type ReactNode } from "react";

import {
  GatedEditTrigger,
  SectionDialog,
  useEditSave,
} from "@/components/admin/dish/section-editor";
import { AdminField } from "@/components/admin/ui";
import type { Locale, Messages } from "@/shared/i18n";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Identity editor via `adminUpdateDishFieldsFn`: slug + parent-dish slug
 * (null clears the link). Only changed fields ship.
 */
export function DishIdentityEditor({
  copy,
  dishId,
  lang,
  parentSlug,
  slug,
}: {
  readonly copy: Messages;
  readonly dishId: string;
  readonly lang: Locale;
  readonly parentSlug: string | null;
  readonly slug: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [draftSlug, setDraftSlug] = useState(slug);
  // Empty clears the parent link (parentSlug: null); untouched leaves the
  // stored parent alone.
  const [draftParent, setDraftParent] = useState(parentSlug ?? "");
  const [touchedParent, setTouchedParent] = useState(false);

  const { error, pending, save } = useEditSave({
    copy,
    fnName: "adminUpdateDishFieldsFn",
    onSaved: () => {
      setOpen(false);
    },
  });

  const slugInvalid = !SLUG_PATTERN.test(draftSlug.trim());

  const parentInvalid =
    touchedParent &&
    draftParent.trim() !== "" &&
    (draftParent.trim().length > 120 || !SLUG_PATTERN.test(draftParent.trim()));

  const dirty =
    draftSlug.trim() !== slug || (touchedParent && draftParent.trim() !== (parentSlug ?? ""));

  const canSave = !slugInvalid && !parentInvalid;

  const openDialog = (): void => {
    setDraftSlug(slug);
    setDraftParent(parentSlug ?? "");
    setTouchedParent(false);
    setOpen(true);
  };

  const handleSave = (): void => {
    if (!canSave) {
      return;
    }

    let nextParent: string | null = parentSlug;

    if (touchedParent) {
      nextParent = draftParent.trim() === "" ? null : draftParent.trim();
    }

    save({ dishId, slug: draftSlug.trim(), parentSlug: nextParent });
  };

  return (
    <>
      <GatedEditTrigger copy={copy} fnName="adminUpdateDishFieldsFn" onOpen={openDialog} />
      {open ? (
        <SectionDialog
          canSave={canSave}
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
          title={copy.adminSlug}
        >
          <AdminField
            id="dish-slug"
            label={copy.adminSlug}
            value={draftSlug}
            onChange={(event) => {
              setDraftSlug(event.target.value);
            }}
            error={slugInvalid ? copy.adminSaveFailed : null}
          />
          <AdminField
            id="dish-parent"
            label={copy.adminParentDish}
            value={draftParent}
            onChange={(event) => {
              setDraftParent(event.target.value);
              setTouchedParent(true);
            }}
            error={parentInvalid ? copy.adminSaveFailed : null}
          />
          <p className="text-sm text-muted">{copy.adminParentDishHint}</p>
        </SectionDialog>
      ) : null}
    </>
  );
}
