import { Link } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";

import type { DishPlaceAssociation, DishPlaceUpsert } from "@/components/admin/dish/edit-contracts";
import {
  GatedEditTrigger,
  SectionDialog,
  sameDraft,
  useEditSave,
} from "@/components/admin/dish/section-editor";
import { placeFnAvailable, type PlaceSearchHit } from "@/components/admin/places/place-contracts";
import { formatPlaceContext } from "@/components/admin/places/place-grammar";
import { PlaceSelector, usePlaceDisplayName } from "@/components/admin/places/PlaceSelector";
import { AdminSelectField } from "@/components/admin/select";
import { AdminField, AdminGhostButton } from "@/components/admin/ui";
import type { Locale, Messages } from "@/shared/i18n";

const ASSOCIATIONS: ReadonlyArray<DishPlaceAssociation> = ["origin", "associated", "popular"];

/** Server-side dish-place note limit (`place note must be at most 2000 characters`). */
const NOTE_LIMIT = 2000;

// Specific per-field message for the note limit: no admin copy key states a
// note limit (`recTermTooLong` names 100 characters, `adminSaveFailed` is the
// generic save failure), and i18n keys are owned elsewhere — so the limit
// wording lives here next to the check, mirroring the server reason.
const noteTooLongMessage = (lang: Locale): string =>
  lang === "vi" ? "Ghi chú tối đa 2000 ký tự." : "Notes must be at most 2000 characters.";

const associationOptions = (
  copy: Messages,
): ReadonlyArray<{ readonly label: string; readonly value: string }> => [
  { label: copy.adminAssocOrigin, value: "origin" },
  { label: copy.adminAssocAssociated, value: "associated" },
  { label: copy.adminAssocPopular, value: "popular" },
];

interface PlaceRow {
  readonly key: string;
  /** Registry place id — every row is registry-backed; display gaps never drop the link. */
  readonly placeId: string;
  /** Snapshot display name; upgraded with parent context once the registry resolves. */
  readonly name: string | null;
  readonly association: DishPlaceAssociation;
  readonly disputed: boolean;
  readonly note: string;
}

/**
 * Registry-resolved link name. Falls back to the snapshot name (or an
 * explicit `Place #id`) so an existing association is never lost because
 * its display name is temporarily unavailable.
 */
function PlaceLinkName({
  lang,
  name,
  placeId,
}: {
  readonly lang: Locale;
  readonly name: string | null;
  readonly placeId: string;
}): ReactNode {
  const fallback = name ?? (lang === "vi" ? `Địa điểm #${placeId}` : `Place #${placeId}`);
  const display = usePlaceDisplayName(placeId, fallback, lang);

  return <span className="font-semibold">{display}</span>;
}

/** Staged pick result: human-readable name plus kind — never a raw id. */
function StagedPlaceCard({
  hit,
  lang,
  note,
}: {
  readonly hit: PlaceSearchHit;
  readonly lang: Locale;
  readonly note: string;
}): ReactNode {
  const fallback = formatPlaceContext({
    name: hit.name,
    parentName: hit.parentName,
    iso: hit.iso,
    placeId: hit.id,
    lang,
  });

  const display = usePlaceDisplayName(hit.id, fallback, lang);
  const trimmedNote = note.trim();

  return (
    <div className="rounded-lg border border-border-soft bg-cream px-3 py-2">
      <p className="min-w-0 text-sm break-words">
        <span className="font-semibold">{display}</span>{" "}
        <span className="text-xs text-muted">{hit.kind}</span>
      </p>
      {trimmedNote === "" ? null : (
        <p className="mt-1 min-w-0 text-sm break-words text-muted">{trimmedNote}</p>
      )}
    </div>
  );
}

/**
 * Dish↔place links editor via `adminUpdateDishPlacesFn`.
 *
 * The normal workflow is registry-first: Add location → searchable
 * city/country/locality picker (registry-backed via `adminPlacesListFn`
 * with canonical ids) → human-readable result (name + country/parent
 * context + kind) → association select (existing values, never display
 * labels) → optional note/disputed → Cancel/Add. No grammar field.
 *
 * Existing links keep their registry `placeId` for association/dispute
 * edits and removal (`removePlaceIds`); only changed or new rows are
 * sent as upsert. Permission gating (`food:update` display, server as
 * authority) and the revision/audit workflow are untouched.
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
    readonly note: string | null;
  }>;
}): ReactNode {
  const [open, setOpen] = useState(false);

  // `places[].id` is the registry place id (decimal string), so existing
  // rows round-trip as `{ placeId }` refs and removals as `removePlaceIds`.
  const snapshot: ReadonlyArray<PlaceRow> = places.map((entry) => ({
    key: entry.id,
    placeId: entry.id,
    name: entry.name ?? null,
    association: ASSOCIATIONS.find((candidate) => candidate === entry.association) ?? "associated",
    disputed: entry.isDisputed,
    note: entry.note ?? "",
  }));

  const [rows, setRows] = useState<ReadonlyArray<PlaceRow>>(snapshot);
  const [removed, setRemoved] = useState<ReadonlyArray<string>>([]);
  const [counter, setCounter] = useState(0);

  const [adding, setAdding] = useState(false);
  const [stagedId, setStagedId] = useState("");
  const [stagedHit, setStagedHit] = useState<PlaceSearchHit | null>(null);
  const [stagedAssociation, setStagedAssociation] = useState<DishPlaceAssociation>("associated");
  const [stagedDisputed, setStagedDisputed] = useState(false);
  const [stagedNote, setStagedNote] = useState("");
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  const { error, pending, save } = useEditSave({
    copy,
    fnName: "adminUpdateDishPlacesFn",
    onSaved: () => {
      setOpen(false);
    },
  });

  const invalid = rows.some((row) => row.note.length > NOTE_LIMIT);

  const stripped = (row: PlaceRow) => ({
    placeId: row.placeId,
    association: row.association,
    disputed: row.disputed,
    note: row.note.trim(),
  });

  const dirty = removed.length > 0 || !sameDraft(rows.map(stripped), snapshot.map(stripped));

  const openDialog = (): void => {
    setRows(snapshot);
    setRemoved([]);
    setAdding(false);
    setStagedId("");
    setStagedHit(null);
    setStagedAssociation("associated");
    setStagedDisputed(false);
    setStagedNote("");
    setOpen(true);
  };

  const patchRow = (key: string, patch: Partial<PlaceRow>): void => {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const removeRow = (row: PlaceRow): void => {
    setRows((previous) => previous.filter((entry) => entry.key !== row.key));

    // Only persisted rows (present in the loader snapshot) need a removal
    // entry — unsaved `new-N` rows were never linked, so tracking them would
    // send a bogus removePlaceIds entry for a link that does not exist.
    if (snapshot.some((entry) => entry.key === row.key)) {
      setRemoved((previous) =>
        previous.includes(row.placeId) ? previous : [...previous, row.placeId],
      );
    }
  };

  const cancelAdding = (): void => {
    setAdding(false);
    setStagedId("");
    setStagedHit(null);
    setStagedAssociation("associated");
    setStagedDisputed(false);
    setStagedNote("");
    addButtonRef.current?.focus();
  };

  const duplicateStaged = stagedId !== "" && rows.some((row) => row.placeId === stagedId);
  const stagedNoteInvalid = stagedNote.length > NOTE_LIMIT;

  const confirmAdding = (): void => {
    if (stagedId === "" || duplicateStaged || stagedNoteInvalid) {
      return;
    }

    const next = counter + 1;

    setCounter(next);
    // Re-adding a removed persisted id revives the link: drop its removal
    // entry so the save never sends both upsert and removePlaceIds.
    setRemoved((previous) => previous.filter((id) => id !== stagedId));
    setRows((previous) => [
      ...previous,
      {
        key: `new-${next}`,
        placeId: stagedId,
        name: stagedHit?.name ?? null,
        association: stagedAssociation,
        disputed: stagedDisputed,
        note: stagedNote,
      },
    ]);
    setStagedId("");
    setStagedHit(null);
    setStagedAssociation("associated");
    setStagedDisputed(false);
    setStagedNote("");
  };

  const handleSave = (): void => {
    if (invalid) {
      return;
    }

    const upsert: Array<DishPlaceUpsert> = [];

    for (const row of rows) {
      const initial = snapshot.find((entry) => entry.key === row.key);
      // Empty and whitespace-only drafts clear the link note (null); the
      // skip compares normalized notes so an untouched server note — or a
      // note just cleared back to its empty initial — sends nothing.
      const note = row.note.trim() === "" ? null : row.note.trim();

      if (initial !== undefined) {
        const initialNote = initial.note.trim() === "" ? null : initial.note.trim();

        if (
          initial.association === row.association &&
          initial.disputed === row.disputed &&
          initialNote === note
        ) {
          continue;
        }
      }

      upsert.push({
        place: { placeId: row.placeId },
        association: row.association,
        disputed: row.disputed,
        note,
      });
    }

    save({ dishId, upsert, removePlaceIds: removed });
  };

  const searchAvailable = placeFnAvailable("adminPlacesListFn");
  const createAvailable = placeFnAvailable("adminCreatePlaceFn");

  const missingPlaceSlot = (
    <>
      <p className="font-semibold text-ink">{copy.adminNoResults}</p>
      <p className="mt-1 text-muted">{copy.adminPlaceNeedsRegistration}</p>
      {createAvailable ? (
        <Link
          to="/admin/places/$placeId"
          params={{ placeId: "new" }}
          search={{ lang }}
          className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-brand-blue underline"
        >
          {copy.adminNewPlace}
        </Link>
      ) : null}
    </>
  );

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
          <ul className="flex min-w-0 flex-col gap-4">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-soft p-3"
              >
                <p className="min-w-0 text-sm break-words">
                  <PlaceLinkName lang={lang} name={row.name} placeId={row.placeId} />
                </p>
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
                    error={row.note.length > NOTE_LIMIT ? noteTooLongMessage(lang) : null}
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
          {adding ? (
            <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-brand-blue/30 bg-brand-blue/5 p-3">
              {searchAvailable ? (
                <PlaceSelector
                  id="place-add-search"
                  label={copy.adminSelectPlace}
                  copy={copy}
                  lang={lang}
                  variant="parentFilter"
                  placeholder={copy.adminSearchPlacesPlaceholder}
                  value={stagedId}
                  emptySlot={missingPlaceSlot}
                  onPickHit={(hit) => {
                    setStagedId(hit.id);
                    setStagedHit(hit);
                  }}
                  onChange={(value) => {
                    // Picks arrive via onPickHit with full hit context;
                    // free typing never mutates the staged id — only an
                    // explicit clear discards the selection.
                    if (value === "") {
                      setStagedId("");
                      setStagedHit(null);
                    }
                  }}
                />
              ) : (
                <p className="text-sm text-muted">{copy.adminPlacesPending}</p>
              )}
              {stagedId !== "" && stagedHit !== null ? (
                <StagedPlaceCard hit={stagedHit} lang={lang} note={stagedNote} />
              ) : null}
              {duplicateStaged ? (
                <p role="alert" className="text-sm font-semibold text-red-800">
                  {lang === "vi"
                    ? "Địa điểm này đã được liên kết — hãy sửa mục hiện có."
                    : "This place is already linked — edit the existing entry instead."}
                </p>
              ) : null}
              <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                <AdminSelectField
                  id="place-add-assoc"
                  label={copy.adminAssociation}
                  value={stagedAssociation}
                  onValueChange={(value) => {
                    const next = ASSOCIATIONS.find((candidate) => candidate === value);

                    if (next !== undefined) {
                      setStagedAssociation(next);
                    }
                  }}
                  options={associationOptions(copy)}
                />
                <AdminField
                  id="place-add-note"
                  label={copy.adminNoteOptional}
                  value={stagedNote}
                  onChange={(event) => {
                    setStagedNote(event.target.value);
                  }}
                  error={stagedNoteInvalid ? noteTooLongMessage(lang) : null}
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label
                  htmlFor="place-add-disputed"
                  className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    id="place-add-disputed"
                    type="checkbox"
                    checked={stagedDisputed}
                    onChange={(event) => {
                      setStagedDisputed(event.target.checked);
                    }}
                    className="h-5 w-5 shrink-0"
                  />
                  {copy.adminDisputed}
                </label>
                <div className="flex flex-wrap gap-2">
                  <AdminGhostButton type="button" onClick={cancelAdding}>
                    {copy.commonCancel}
                  </AdminGhostButton>
                  <AdminGhostButton
                    type="button"
                    disabled={stagedId === "" || duplicateStaged || stagedNoteInvalid}
                    onClick={confirmAdding}
                  >
                    {lang === "vi" ? "Thêm địa điểm" : "Add location"}
                  </AdminGhostButton>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <AdminGhostButton
                type="button"
                ref={addButtonRef}
                onClick={() => {
                  setAdding(true);
                }}
              >
                {copy.adminAddRow}
              </AdminGhostButton>
            </div>
          )}
        </SectionDialog>
      ) : null}
    </>
  );
}
