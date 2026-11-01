import { useState, type ReactNode } from "react";

import type { DishIngredientUpsert } from "@/components/admin/dish/edit-contracts";
import { roleLabel } from "@/components/admin/dish/presentation";
import {
  GatedEditTrigger,
  SectionDialog,
  sameDraft,
  useEditSave,
} from "@/components/admin/dish/section-editor";
import { AdminSelectField } from "@/components/admin/select";
import { AdminField, AdminGhostButton } from "@/components/admin/ui";
import type { Locale, Messages } from "@/shared/i18n";

const ROLES = ["core", "common", "optional", "garnish"] as const;
const DECIMAL_PATTERN = /^[0-9]+$/;

interface IngredientRow {
  readonly key: string;
  readonly id?: string;
  readonly ref: string;
  readonly role: string;
}

/**
 * Ingredients editor via `adminUpdateDishIngredientsFn`.
 *
 * Links are registry ids only: existing rows keep their `id` for role
 * edits and removal (`removeIngredientIds`); new rows take a decimal
 * ingredient id. Free-text ingredient names are not resolved by this
 * endpoint — curators register the ingredient first, then link it here.
 */
export function DishIngredientsEditor({
  copy,
  dishId,
  ingredients,
  lang,
}: {
  readonly copy: Messages;
  readonly dishId: string;
  readonly ingredients: ReadonlyArray<{
    readonly id: string;
    readonly name: string | undefined;
    readonly role: string;
  }>;
  readonly lang: Locale;
}): ReactNode {
  const [open, setOpen] = useState(false);

  const snapshot: ReadonlyArray<IngredientRow> = ingredients.map((entry) => ({
    key: entry.id,
    id: entry.id,
    ref: entry.name ?? entry.id,
    role: entry.role,
  }));

  const [rows, setRows] = useState<ReadonlyArray<IngredientRow>>(snapshot);
  const [removed, setRemoved] = useState<ReadonlyArray<string>>([]);
  const [counter, setCounter] = useState(0);

  const { error, pending, save } = useEditSave({
    copy,
    fnName: "adminUpdateDishIngredientsFn",
    onSaved: () => {
      setOpen(false);
    },
  });

  const invalid = rows.some((row) => {
    if (row.id !== undefined) {
      return false;
    }

    return !DECIMAL_PATTERN.test(row.ref.trim());
  });

  const dirty =
    removed.length > 0 ||
    !sameDraft(
      rows.map((row) => ({ ...row, key: undefined })),
      snapshot.map((row) => ({ ...row, key: undefined })),
    );

  const openDialog = (): void => {
    setRows(snapshot);
    setRemoved([]);
    setOpen(true);
  };

  const patchRow = (key: string, patch: Partial<IngredientRow>): void => {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => {
    const next = counter + 1;

    setCounter(next);
    setRows((previous) => [...previous, { key: `new-${next}`, ref: "", role: "common" }]);
  };

  const removeRow = (row: IngredientRow): void => {
    setRows((previous) => previous.filter((entry) => entry.key !== row.key));

    const removedId = row.id;

    if (removedId !== undefined) {
      setRemoved((previous) => [...previous, removedId]);
    }
  };

  const handleSave = (): void => {
    if (invalid) {
      return;
    }

    const upsert: Array<DishIngredientUpsert> = [];

    for (const row of rows) {
      const initial = snapshot.find((entry) => entry.key === row.key);
      const ingredientId = row.id ?? row.ref.trim();

      if (initial !== undefined && initial.role === row.role) {
        continue;
      }

      upsert.push({ ingredientId, role: row.role });
    }

    save({ dishId, upsert, removeIngredientIds: removed });
  };

  return (
    <>
      <GatedEditTrigger copy={copy} fnName="adminUpdateDishIngredientsFn" onOpen={openDialog} />
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
          title={copy.adminIngredients}
        >
          <ul className="flex min-w-0 flex-col gap-3">
            {rows.map((row) => (
              <li
                key={row.key}
                className="grid min-w-0 grid-cols-1 gap-2 rounded-xl border border-border-soft p-3 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                  {row.id === undefined ? (
                    <AdminField
                      id={`ingredient-ref-${row.key}`}
                      label={copy.adminIngredientRef}
                      value={row.ref}
                      inputMode="numeric"
                      onChange={(event) => {
                        patchRow(row.key, { ref: event.target.value });
                      }}
                      error={DECIMAL_PATTERN.test(row.ref.trim()) ? null : copy.adminFieldRequired}
                    />
                  ) : (
                    <p className="min-w-0 self-center text-sm break-words">
                      <span className="font-semibold">{row.ref}</span>
                    </p>
                  )}
                  <AdminSelectField
                    id={`ingredient-role-${row.key}`}
                    label={copy.adminIngredientRole}
                    value={row.role}
                    onValueChange={(value) => {
                      patchRow(row.key, { role: value });
                    }}
                    options={ROLES.map((role) => ({ label: roleLabel(role, lang), value: role }))}
                  />
                </div>
                <div className="flex items-end">
                  <AdminGhostButton type="button" onClick={() => removeRow(row)}>
                    {copy.adminRemove}
                  </AdminGhostButton>
                </div>
              </li>
            ))}
          </ul>
          <div>
            <AdminGhostButton type="button" onClick={addRow}>
              {copy.adminAddRow}
            </AdminGhostButton>
          </div>
        </SectionDialog>
      ) : null}
    </>
  );
}
