import { useState, type ReactNode } from "react";

import type { DishPlaceAssociation, DishPlaceUpsert } from "@/components/admin/dish/edit-contracts";
import {
  GatedEditTrigger,
  SectionDialog,
  sameDraft,
  useEditSave,
} from "@/components/admin/dish/section-editor";
import { parsePlaceRef } from "@/components/admin/places/place-grammar";
import { PlaceSelector } from "@/components/admin/places/PlaceSelector";
import { AdminSelectField } from "@/components/admin/select";
import { AdminField, AdminGhostButton } from "@/components/admin/ui";
import type { Locale, Messages } from "@/shared/i18n";

const ASSOCIATIONS: ReadonlyArray<DishPlaceAssociation> = ["origin", "associated", "popular"];

interface PlaceRow {
  readonly key: string;
  /** Registry place id for existing links; absent for new grammar rows. */
  readonly placeId?: string;
  readonly refText: string;
  readonly association: DishPlaceAssociation;
  readonly disputed: boolean;
  readonly note: string;
}

const associationOptions = (
  copy: Messages,
): ReadonlyArray<{ readonly label: string; readonly value: string }> => [
  { label: copy.adminAssocOrigin, value: "origin" },
  { label: copy.adminAssocAssociated, value: "associated" },
  { label: copy.adminAssocPopular, value: "popular" },
];

/**
 * Dish↔place links editor via `adminUpdateDishPlacesFn`.
 *
 * Existing links keep their `id` for association/dispute edits and removal
 * (`removePlaceIds`); new links are entered as place-ref grammar
 * (`VN:origin`, `place:45:popular`, `Hanoi@VN:associated`, default
 * associated) and parsed client-side into the fixed `placeRef` shape.
 * Unparseable rows block save.
 */
export function DishPlacesEditor({
  copy,
  dishId,
  lang,
  places,
}: {
  readonly copy: Messages;
  readonly dishId: string;
  readonly lang: Locale;
  readonly places: ReadonlyArray<{
    readonly id: string;
    readonly name: string | undefined;
    readonly association: string;
    readonly isDisputed: boolean;
  }>;
}): ReactNode {
  const [open, setOpen] = useState(false);

  // `places[].id` is the registry place id (decimal string), so existing
  // rows round-trip as `{ placeId }` refs and removals as `removePlaceIds`.
  const snapshot: ReadonlyArray<PlaceRow> = places.map((entry) => ({
    key: entry.id,
    placeId: entry.id,
    refText: entry.name ?? entry.id,
    association: ASSOCIATIONS.find((candidate) => candidate === entry.association) ?? "associated",
    disputed: entry.isDisputed,
    note: "",
  }));

  const [rows, setRows] = useState<ReadonlyArray<PlaceRow>>(snapshot);
  const [removed, setRemoved] = useState<ReadonlyArray<string>>([]);
  const [counter, setCounter] = useState(0);

  const { error, pending, save } = useEditSave({
    copy,
    fnName: "adminUpdateDishPlacesFn",
    onSaved: () => {
      setOpen(false);
    },
  });

  const rowParse = (row: PlaceRow): boolean => {
    if (row.placeId !== undefined) {
      return true;
    }

    return parsePlaceRef(row.refText).ok;
  };

  const invalid = rows.some((row) => !rowParse(row)) || rows.some((row) => row.note.length > 2000);

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

  const patchRow = (key: string, patch: Partial<PlaceRow>): void => {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => {
    const next = counter + 1;

    setCounter(next);
    setRows((previous) => [
      ...previous,
      { key: `new-${next}`, refText: "", association: "associated", disputed: false, note: "" },
    ]);
  };

  const removeRow = (row: PlaceRow): void => {
    setRows((previous) => previous.filter((entry) => entry.key !== row.key));

    const removedId = row.placeId;

    if (removedId !== undefined) {
      setRemoved((previous) => [...previous, removedId]);
    }
  };

  const handleSave = (): void => {
    if (invalid) {
      return;
    }

    const upsert: Array<DishPlaceUpsert> = [];

    for (const row of rows) {
      const initial = snapshot.find((entry) => entry.key === row.key);
      const placeId = row.placeId;
      const note = row.note.trim() === "" ? null : row.note.trim();

      if (placeId !== undefined) {
        if (
          initial !== undefined &&
          initial.association === row.association &&
          initial.disputed === row.disputed &&
          note === null
        ) {
          continue;
        }

        const existing: DishPlaceUpsert = {
          place: { placeId },
          association: row.association,
          disputed: row.disputed,
          note,
        };

        upsert.push(existing);

        continue;
      }

      const parsed = parsePlaceRef(row.refText);

      if (!parsed.ok) {
        return;
      }

      const created: DishPlaceUpsert = {
        place: parsed.value.ref,
        association: row.association,
        disputed: row.disputed,
        note,
      };

      upsert.push(created);
    }

    save({ dishId, upsert, removePlaceIds: removed });
  };

  return (
    <>
      <GatedEditTrigger copy={copy} fnName="adminUpdateDishPlacesFn" onOpen={openDialog} />
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
          title={copy.adminPlaces}
        >
          <p className="text-sm text-muted">{copy.adminPlaceGrammarIntro}</p>
          <ul className="flex min-w-0 flex-col gap-4">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-soft p-3"
              >
                {row.placeId === undefined ? (
                  <PlaceSelector
                    id={`place-ref-${row.key}`}
                    label={copy.adminPlaceRef}
                    copy={copy}
                    lang={lang}
                    value={row.refText}
                    onChange={(value) => {
                      patchRow(row.key, { refText: value });
                    }}
                  />
                ) : (
                  <p className="min-w-0 text-sm break-words">
                    <span className="font-semibold">{row.refText}</span>
                  </p>
                )}
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                  <AdminSelectField
                    id={`place-assoc-${row.key}`}
                    label={copy.adminAssociation}
                    value={row.association}
                    onValueChange={(value) => {
                      const next = ASSOCIATIONS.find((candidate) => candidate === value);

                      if (next !== undefined) {
                        patchRow(row.key, { association: next });
                      }
                    }}
                    options={associationOptions(copy)}
                  />
                  <AdminField
                    id={`place-note-${row.key}`}
                    label={copy.adminNoteOptional}
                    value={row.note}
                    onChange={(event) => {
                      patchRow(row.key, { note: event.target.value });
                    }}
                    error={row.note.length > 2000 ? copy.adminSaveFailed : null}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor={`place-disputed-${row.key}`}
                    className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      id={`place-disputed-${row.key}`}
                      type="checkbox"
                      checked={row.disputed}
                      onChange={(event) => {
                        patchRow(row.key, { disputed: event.target.checked });
                      }}
                      className="h-5 w-5 shrink-0"
                    />
                    {copy.adminDisputed}
                  </label>
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
