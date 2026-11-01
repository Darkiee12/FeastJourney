import { useState, type ReactNode } from "react";

import type { DishNameUpsert } from "@/components/admin/dish/edit-contracts";
import {
  GatedEditTrigger,
  SectionDialog,
  sameDraft,
  useEditSave,
} from "@/components/admin/dish/section-editor";
import { AdminSelectField } from "@/components/admin/select";
import { AdminField, AdminGhostButton } from "@/components/admin/ui";
import type { Locale, Messages } from "@/shared/i18n";

const LANG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const NAME_KINDS = ["native", "localized", "alias", "transliteration"] as const;

interface NameRow {
  readonly key: string;
  readonly id?: string;
  readonly languageTag: string;
  readonly name: string;
  readonly nameKind: string;
  readonly isPreferred: boolean;
}

/**
 * Names editor via `adminUpdateDishNamesFn`.
 *
 * TODO(workstream-1b): the detail loader (`adminDishDetailFn` + route
 * schema + `DishProfile.nativeNames`) does not carry name row ids yet, so
 * rows loaded from it cannot supply `removeIds` — removal buttons render
 * only for rows that have an id, and `adminIdsPending` explains the gap.
 * Upsert-by-languageTag and adding names work against the landed
 * `adminUpdateDishNamesFn`.
 */
export function DishNamesEditor({
  copy,
  dishId,
  lang,
  names,
}: {
  readonly copy: Messages;
  readonly dishId: string;
  readonly lang: Locale;
  readonly names: ReadonlyArray<{
    readonly id?: string;
    readonly languageTag: string;
    readonly name: string;
    readonly nameKind?: string;
    readonly isPreferred?: boolean;
  }>;
}): ReactNode {
  const [open, setOpen] = useState(false);

  const snapshot: ReadonlyArray<NameRow> = names.map((entry, index) => ({
    key: entry.id ?? `loaded-${index}`,
    id: entry.id,
    languageTag: entry.languageTag,
    name: entry.name,
    nameKind: entry.nameKind ?? "localized",
    isPreferred: entry.isPreferred ?? false,
  }));

  const [rows, setRows] = useState<ReadonlyArray<NameRow>>(snapshot);
  const [removed, setRemoved] = useState<ReadonlyArray<string>>([]);
  const [counter, setCounter] = useState(0);

  const { error, pending, save } = useEditSave({
    copy,
    fnName: "adminUpdateDishNamesFn",
    onSaved: () => {
      setOpen(false);
    },
  });

  const invalid = rows.some(
    (row) => row.name.trim() === "" || row.name.length > 300 || !LANG_PATTERN.test(row.languageTag),
  );

  const preferredByLang = new Map<string, number>();

  for (const row of rows) {
    if (row.isPreferred) {
      preferredByLang.set(row.languageTag, (preferredByLang.get(row.languageTag) ?? 0) + 1);
    }
  }

  const duplicatePreferred = [...preferredByLang.values()].some((count) => count > 1);

  const dirty =
    removed.length > 0 ||
    !sameDraft(
      rows.map((row) => ({ ...row, key: undefined })),
      snapshot.map((row) => ({ ...row, key: undefined })),
    );

  const canSave = !invalid && !duplicatePreferred;

  const openDialog = (): void => {
    setRows(snapshot);
    setRemoved([]);
    setOpen(true);
  };

  const handleClose = (): void => {
    // Cancel restores the snapshot; failed saves keep edits for retry
    // (the dialog stays open on failure, only success closes it).
    setRows(snapshot);
    setRemoved([]);
    setOpen(false);
  };

  const patchRow = (key: string, patch: Partial<NameRow>): void => {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => {
    const next = counter + 1;

    setCounter(next);
    setRows((previous) => [
      ...previous,
      {
        key: `new-${next}`,
        languageTag: lang,
        name: "",
        nameKind: "localized",
        isPreferred: false,
      },
    ]);
  };

  const removeRow = (row: NameRow): void => {
    setRows((previous) => previous.filter((entry) => entry.key !== row.key));

    const removedId = row.id;

    if (removedId !== undefined) {
      setRemoved((previous) => [...previous, removedId]);
    }
  };

  const handleSave = (): void => {
    if (!canSave) {
      return;
    }

    const upsert: Array<DishNameUpsert> = rows.map((row) => {
      const trimmed = row.name.trim();

      if (row.id === undefined) {
        return {
          languageTag: row.languageTag,
          name: trimmed,
          nameKind: row.nameKind,
          isPreferred: row.isPreferred,
        };
      }

      return {
        id: row.id,
        languageTag: row.languageTag,
        name: trimmed,
        nameKind: row.nameKind,
        isPreferred: row.isPreferred,
      };
    });

    save({ dishId, upsert, removeIds: removed });
  };

  const missingIds = snapshot.some((row) => row.id === undefined);

  return (
    <>
      <GatedEditTrigger copy={copy} fnName="adminUpdateDishNamesFn" onOpen={openDialog} />
      {open ? (
        <SectionDialog
          canSave={canSave}
          copy={copy}
          dirty={dirty}
          error={error}
          lang={lang}
          onClose={handleClose}
          onSave={handleSave}
          open={open}
          pending={pending}
          title={copy.adminNames}
        >
          {missingIds ? <p className="text-sm text-muted">{copy.adminIdsPending}</p> : null}
          <ul className="flex min-w-0 flex-col gap-3">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-soft p-3"
              >
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                  <AdminField
                    id={`name-tag-${row.key}`}
                    label={copy.adminLanguageTag}
                    value={row.languageTag}
                    onChange={(event) => {
                      patchRow(row.key, { languageTag: event.target.value });
                    }}
                    error={LANG_PATTERN.test(row.languageTag) ? null : copy.adminFieldRequired}
                  />
                  <AdminSelectField
                    id={`name-kind-${row.key}`}
                    label={copy.adminNameKind}
                    value={row.nameKind}
                    onValueChange={(value) => {
                      patchRow(row.key, { nameKind: value });
                    }}
                    options={NAME_KINDS.map((kind) => ({ label: kind, value: kind }))}
                  />
                </div>
                <AdminField
                  id={`name-value-${row.key}`}
                  label={copy.adminNameLabel}
                  value={row.name}
                  onChange={(event) => {
                    patchRow(row.key, { name: event.target.value });
                  }}
                  error={row.name.trim() === "" ? copy.adminFieldRequired : null}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor={`name-preferred-${row.key}`}
                    className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      id={`name-preferred-${row.key}`}
                      type="checkbox"
                      checked={row.isPreferred}
                      onChange={(event) => {
                        patchRow(row.key, { isPreferred: event.target.checked });
                      }}
                      className="h-5 w-5 shrink-0"
                    />
                    {copy.adminPreferred}
                    <span className="rounded-full bg-cream px-2 py-0.5 text-xs font-bold text-food-orange-dark">
                      {row.languageTag}
                    </span>
                  </label>
                  {row.id === undefined && !row.key.startsWith("new-") ? null : (
                    <AdminGhostButton
                      type="button"
                      aria-label={`${copy.adminRemove} ${row.name.trim() === "" ? row.languageTag : row.name.trim()}`}
                      onClick={() => removeRow(row)}
                    >
                      {copy.adminRemove}
                    </AdminGhostButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div>
            <AdminGhostButton type="button" onClick={addRow}>
              {copy.adminAddName}
            </AdminGhostButton>
          </div>
          {duplicatePreferred ? (
            <p role="alert" className="text-sm font-semibold text-red-800">
              {copy.adminPreferredSingle}
            </p>
          ) : null}
        </SectionDialog>
      ) : null}
    </>
  );
}
