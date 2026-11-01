import { useState, type ReactNode } from "react";

import type { DishDescriptionUpsert } from "@/components/admin/dish/edit-contracts";
import {
  GatedEditTrigger,
  SectionDialog,
  sameDraft,
  useEditSave,
} from "@/components/admin/dish/section-editor";
import { AdminField, AdminGhostButton } from "@/components/admin/ui";
import type { Locale, Messages } from "@/shared/i18n";

interface DescriptionRow {
  readonly key: string;
  readonly languageTag: string;
  readonly description: string;
  readonly summary: string;
}

const LANG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * Descriptions editor via `adminUpdateDishDescriptionsFn`: upsert plus
 * removal by language tag (`removeLanguageTags`) — the read model carries
 * one description without a row id, but tags are sufficient for both paths.
 */
export function DishDescriptionsEditor({
  copy,
  description,
  descriptionLanguage,
  dishId,
  lang,
}: {
  readonly copy: Messages;
  readonly description: string | null;
  readonly descriptionLanguage: string | null;
  readonly dishId: string;
  readonly lang: Locale;
}): ReactNode {
  const [open, setOpen] = useState(false);

  const snapshot: ReadonlyArray<DescriptionRow> =
    description === null
      ? []
      : [
          {
            key: "loaded-0",
            languageTag: descriptionLanguage ?? "en",
            description,
            summary: "",
          },
        ];

  const [rows, setRows] = useState<ReadonlyArray<DescriptionRow>>(snapshot);
  const [removedTags, setRemovedTags] = useState<ReadonlyArray<string>>([]);
  const [counter, setCounter] = useState(0);

  const { error, pending, save } = useEditSave({
    copy,
    fnName: "adminUpdateDishDescriptionsFn",
    onSaved: () => {
      setOpen(false);
    },
  });

  const invalid = rows.some(
    (row) =>
      row.description.trim() === "" ||
      row.description.length > 20000 ||
      row.summary.length > 1000 ||
      !LANG_PATTERN.test(row.languageTag),
  );

  const dirty =
    removedTags.length > 0 ||
    !sameDraft(
      rows.map((row) => ({ ...row, key: undefined })),
      snapshot.map((row) => ({ ...row, key: undefined })),
    );

  const canSave = !invalid;

  const openDialog = (): void => {
    setRows(snapshot);
    setRemovedTags([]);
    setOpen(true);
  };

  const patchRow = (key: string, patch: Partial<DescriptionRow>): void => {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => {
    const next = counter + 1;

    setCounter(next);
    setRows((previous) => [
      ...previous,
      { key: `new-${next}`, languageTag: lang, description: "", summary: "" },
    ]);
  };

  const removeRow = (row: DescriptionRow): void => {
    setRows((previous) => previous.filter((entry) => entry.key !== row.key));

    // Removal is keyed by language tag (no row ids in the read model); the
    // tag list ships as `removeLanguageTags`.
    if (!row.key.startsWith("new-")) {
      const tag = row.languageTag;

      setRemovedTags((previous) => (previous.includes(tag) ? previous : [...previous, tag]));
    }
  };

  const handleSave = (): void => {
    if (!canSave) {
      return;
    }

    const upsert: Array<DishDescriptionUpsert> = rows.map((row) => ({
      languageTag: row.languageTag,
      description: row.description.trim(),
      summary: row.summary.trim() === "" ? null : row.summary.trim(),
    }));

    save({ dishId, upsert, removeLanguageTags: removedTags });
  };

  return (
    <>
      <GatedEditTrigger copy={copy} fnName="adminUpdateDishDescriptionsFn" onOpen={openDialog} />
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
          title={copy.adminDescriptions}
        >
          <ul className="flex min-w-0 flex-col gap-4">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-soft p-3"
              >
                <AdminField
                  id={`desc-tag-${row.key}`}
                  label={copy.adminLanguageTag}
                  value={row.languageTag}
                  onChange={(event) => {
                    patchRow(row.key, { languageTag: event.target.value });
                  }}
                  error={LANG_PATTERN.test(row.languageTag) ? null : copy.adminFieldRequired}
                />
                <div className="flex flex-col gap-1">
                  <label htmlFor={`desc-value-${row.key}`} className="text-sm font-semibold">
                    {copy.adminDescriptionLabel}
                  </label>
                  <textarea
                    id={`desc-value-${row.key}`}
                    value={row.description}
                    rows={4}
                    maxLength={20000}
                    onChange={(event) => {
                      patchRow(row.key, { description: event.target.value });
                    }}
                    aria-invalid={row.description.trim() === ""}
                    className="min-h-11 w-full rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink outline-none focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40"
                  />
                  {row.description.trim() === "" ? (
                    <p role="alert" className="text-sm font-semibold text-red-800">
                      {copy.adminFieldRequired}
                    </p>
                  ) : null}
                </div>
                <AdminField
                  id={`desc-summary-${row.key}`}
                  label={copy.adminSummary}
                  value={row.summary}
                  onChange={(event) => {
                    patchRow(row.key, { summary: event.target.value });
                  }}
                  error={row.summary.length > 1000 ? copy.adminSaveFailed : null}
                />
                <p className="text-sm text-muted">{copy.adminSummaryHint}</p>
                <div>
                  {row.key.startsWith("new-") ? null : (
                    <AdminGhostButton type="button" onClick={() => removeRow(row)}>
                      {copy.adminRemove}
                    </AdminGhostButton>
                  )}
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
