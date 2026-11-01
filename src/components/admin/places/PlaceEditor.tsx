import { useState, type ReactNode } from "react";

import { GatedEdit } from "@/components/admin/dish/section-editor";
import {
  PLACE_KINDS,
  readMutationFailure,
  placeFnAvailable,
  type PlaceDetail,
} from "@/components/admin/places/place-contracts";
import { parsePlaceRef } from "@/components/admin/places/place-grammar";
import { PlaceSelector } from "@/components/admin/places/PlaceSelector";
import { AdminSelectField } from "@/components/admin/select";
import { AdminDialog, AdminField, AdminGhostButton } from "@/components/admin/ui";
import {
  adminPlaceNamesFn,
  adminPlaceParentFn,
  adminUpdatePlaceFn,
} from "@/modules/food-discovery/place.functions";
import type { PlaceKind } from "@/modules/food-discovery/place.schema";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Place detail editors. Every editor renders nothing while its server
 * function is missing and reuses the same gated Edit trigger as the dish
 * sections: synchronous availability probe (no layout jump), `food:update`
 * display gating with the server as the real authority, dirty-state Save,
 * and anti-double-submit. Mutation failures arrive as client-safe
 * `{ok:false,reason}` outcomes and surface verbatim; infrastructure
 * failures surface the generic save message.
 */

const LANG_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/;

function PlaceDialog({
  children,
  copy,
  dirty,
  error,
  onClose,
  onSave,
  open,
  pending,
  title,
  valid,
}: {
  readonly children: ReactNode;
  readonly copy: Messages;
  readonly dirty: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly open: boolean;
  readonly pending: boolean;
  readonly title: string;
  readonly valid: boolean;
}): ReactNode {
  return (
    <AdminDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) {
          onClose();
        }
      }}
      title={title}
      closeLabel={copy.commonCancel}
      dismissOnBackdrop={false}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p aria-live="polite" className="text-sm text-muted">
            {!dirty ? copy.adminNoChanges : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <AdminGhostButton type="button" disabled={pending} onClick={onClose}>
              {copy.commonCancel}
            </AdminGhostButton>
            <button
              type="button"
              disabled={pending || !dirty || !valid}
              aria-busy={pending}
              onClick={onSave}
              className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-food-orange-dark px-4 py-2 text-sm font-bold text-white hover:bg-food-orange-strong disabled:opacity-50"
            >
              {pending ? copy.settingsSaving : copy.authSave}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex min-w-0 flex-col gap-3">
        {error !== null ? (
          <p role="alert" className="text-sm font-semibold text-red-800">
            {error}
          </p>
        ) : null}
        {children}
      </div>
    </AdminDialog>
  );
}

export function PlaceMetadataEditor({
  copy,
  onSaved,
  place,
}: {
  readonly copy: Messages;
  readonly onSaved: () => void;
  readonly place: PlaceDetail;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<PlaceKind>(place.kind);
  const [iso, setIso] = useState(place.iso3166 ?? "");

  const [latitude, setLatitude] = useState(
    place.displayLatitude === null ? "" : String(place.displayLatitude),
  );

  const [longitude, setLongitude] = useState(
    place.displayLongitude === null ? "" : String(place.displayLongitude),
  );

  const [note, setNote] = useState(place.displayNote ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedLatitude = latitude.trim() === "" ? null : Number(latitude);
  const parsedLongitude = longitude.trim() === "" ? null : Number(longitude);

  const coordsInvalid =
    (latitude.trim() !== "" &&
      (parsedLatitude === null ||
        Number.isNaN(parsedLatitude) ||
        parsedLatitude < -90 ||
        parsedLatitude > 90)) ||
    (longitude.trim() !== "" &&
      (parsedLongitude === null ||
        Number.isNaN(parsedLongitude) ||
        parsedLongitude < -180 ||
        parsedLongitude > 180));

  const isoInvalid = iso.trim().length > 10;
  const snapshotLatitude = place.displayLatitude === null ? "" : String(place.displayLatitude);
  const snapshotLongitude = place.displayLongitude === null ? "" : String(place.displayLongitude);

  const dirty =
    kind !== place.kind ||
    iso.trim() !== (place.iso3166 ?? "") ||
    latitude.trim() !== snapshotLatitude ||
    longitude.trim() !== snapshotLongitude ||
    note.trim() !== (place.displayNote ?? "");

  const openDialog = (): void => {
    setKind(place.kind);
    setIso(place.iso3166 ?? "");
    setLatitude(snapshotLatitude);
    setLongitude(snapshotLongitude);
    setNote(place.displayNote ?? "");
    setError(null);
    setOpen(true);
  };

  const handleSave = (): void => {
    if (coordsInvalid || isoInvalid || !dirty || pending) {
      return;
    }

    const nextKind = kind;

    setPending(true);
    setError(null);

    void adminUpdatePlaceFn({
      data: {
        placeId: place.id,
        kind: nextKind,
        iso3166: iso.trim() === "" ? null : iso.trim(),
        displayLatitude: parsedLatitude,
        displayLongitude: parsedLongitude,
        displayNote: note.trim() === "" ? null : note.trim(),
      },
    }).then(
      (outcome) => {
        setPending(false);

        const failure = readMutationFailure(outcome, copy.adminSaveFailed);

        if (failure !== null) {
          setError(failure);

          return;
        }

        setOpen(false);
        onSaved();
      },
      () => {
        setPending(false);
        setError(copy.adminSaveFailed);
      },
    );
  };

  return (
    <>
      <GatedEdit
        available={placeFnAvailable("adminUpdatePlaceFn")}
        copy={copy}
        onOpen={openDialog}
      />
      {open ? (
        <PlaceDialog
          copy={copy}
          dirty={dirty}
          error={error}
          onClose={() => {
            setOpen(false);
          }}
          onSave={handleSave}
          open={open}
          pending={pending}
          title={copy.adminKind}
          valid={!coordsInvalid && !isoInvalid}
        >
          <AdminSelectField
            id="place-kind"
            label={copy.adminKind}
            value={kind}
            onValueChange={(value) => {
              const next = PLACE_KINDS.find((entry) => entry === value);

              if (next !== undefined) {
                setKind(next);
              }
            }}
            options={PLACE_KINDS.map((entry) => ({ label: entry, value: entry }))}
          />
          <AdminField
            id="place-iso"
            label={copy.adminIso}
            value={iso}
            onChange={(event) => {
              setIso(event.target.value);
            }}
            error={isoInvalid ? copy.adminSaveFailed : null}
          />
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <AdminField
              id="place-latitude"
              label={copy.adminLatitude}
              value={latitude}
              inputMode="decimal"
              onChange={(event) => {
                setLatitude(event.target.value);
              }}
              error={coordsInvalid ? copy.adminSaveFailed : null}
            />
            <AdminField
              id="place-longitude"
              label={copy.adminLongitude}
              value={longitude}
              inputMode="decimal"
              onChange={(event) => {
                setLongitude(event.target.value);
              }}
              error={coordsInvalid ? copy.adminSaveFailed : null}
            />
          </div>
          <AdminField
            id="place-note"
            label={copy.adminDisplayNote}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
            error={note.length > 2000 ? copy.adminSaveFailed : null}
          />
        </PlaceDialog>
      ) : null}
    </>
  );
}

interface PlaceNameDraft {
  readonly key: string;
  readonly id?: string;
  readonly languageTag: string;
  readonly name: string;
  readonly isPreferred: boolean;
}

interface PlaceNameSaveRow {
  readonly languageTag: string;
  readonly name: string;
  readonly isPreferred: boolean;
}

const savePlaceNames = async (input: {
  readonly failureMessage: string;
  readonly placeId: string;
  readonly removed: ReadonlyArray<string>;
  readonly upsert: ReadonlyArray<PlaceNameSaveRow>;
}): Promise<string | null> => {
  if (input.upsert.length > 0) {
    const upserted = await adminPlaceNamesFn({
      data: {
        placeId: input.placeId,
        action: "upsert",
        names: input.upsert.map((row) => ({ ...row })),
      },
    });

    const failure = readMutationFailure(upserted, input.failureMessage);

    if (failure !== null) {
      return failure;
    }
  }

  const removals = await Promise.all(
    input.removed.map((nameId) =>
      adminPlaceNamesFn({ data: { placeId: input.placeId, action: "remove", nameId } }),
    ),
  );

  for (const outcome of removals) {
    const failure = readMutationFailure(outcome, input.failureMessage);

    if (failure !== null) {
      return failure;
    }
  }

  return null;
};

export function PlaceNamesEditor({
  copy,
  lang,
  onSaved,
  place,
}: {
  readonly copy: Messages;
  readonly lang: Locale;
  readonly onSaved: () => void;
  readonly place: PlaceDetail;
}): ReactNode {
  const [open, setOpen] = useState(false);

  const snapshot: ReadonlyArray<PlaceNameDraft> = place.names.map((entry) => ({
    key: entry.id,
    id: entry.id,
    languageTag: entry.languageTag,
    name: entry.name,
    isPreferred: entry.isPreferred,
  }));

  const [rows, setRows] = useState<ReadonlyArray<PlaceNameDraft>>(snapshot);
  const [removed, setRemoved] = useState<ReadonlyArray<string>>([]);
  const [counter, setCounter] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalid = rows.some(
    (row) => row.name.trim() === "" || row.name.length > 300 || !LANG_PATTERN.test(row.languageTag),
  );

  const preferredCount = rows.filter((row) => row.isPreferred).length;

  const dirty =
    removed.length > 0 ||
    JSON.stringify(rows.map((row) => ({ ...row, key: undefined }))) !==
      JSON.stringify(snapshot.map((row) => ({ ...row, key: undefined })));

  const openDialog = (): void => {
    setRows(snapshot);
    setRemoved([]);
    setError(null);
    setOpen(true);
  };

  const patchRow = (key: string, patch: Partial<PlaceNameDraft>): void => {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const upsertRows = rows.filter((row) => {
    const initial = snapshot.find((entry) => entry.key === row.key);

    return (
      initial === undefined ||
      initial.languageTag !== row.languageTag ||
      initial.name !== row.name ||
      initial.isPreferred !== row.isPreferred
    );
  });

  const handleSave = (): void => {
    if (invalid || preferredCount > 1 || !dirty || pending) {
      return;
    }

    setPending(true);
    setError(null);

    void savePlaceNames({
      failureMessage: copy.adminSaveFailed,
      placeId: place.id,
      removed,
      upsert: upsertRows.map((row) => ({
        languageTag: row.languageTag,
        name: row.name.trim(),
        isPreferred: row.isPreferred,
      })),
    }).then(
      (failure) => {
        setPending(false);

        if (failure !== null) {
          setError(failure);

          return;
        }

        setOpen(false);
        onSaved();
      },
      () => {
        setPending(false);
        setError(copy.adminSaveFailed);
      },
    );
  };

  return (
    <>
      <GatedEdit
        available={placeFnAvailable("adminPlaceNamesFn")}
        copy={copy}
        onOpen={openDialog}
      />
      {open ? (
        <PlaceDialog
          copy={copy}
          dirty={dirty}
          error={error}
          onClose={() => {
            setOpen(false);
          }}
          onSave={handleSave}
          open={open}
          pending={pending}
          title={copy.adminNames}
          valid={!invalid && preferredCount <= 1}
        >
          <ul className="flex min-w-0 flex-col gap-4">
            {rows.map((row) => (
              <li
                key={row.key}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-border-soft p-3"
              >
                <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                  <AdminField
                    id={`place-name-tag-${row.key}`}
                    label={copy.adminLanguageTag}
                    value={row.languageTag}
                    onChange={(event) => {
                      patchRow(row.key, { languageTag: event.target.value });
                    }}
                    error={LANG_PATTERN.test(row.languageTag) ? null : copy.adminFieldRequired}
                  />
                  <AdminField
                    id={`place-name-value-${row.key}`}
                    label={copy.adminPlaces}
                    value={row.name}
                    onChange={(event) => {
                      patchRow(row.key, { name: event.target.value });
                    }}
                    error={row.name.trim() === "" ? copy.adminFieldRequired : null}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor={`place-name-preferred-${row.key}`}
                    className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      id={`place-name-preferred-${row.key}`}
                      type="checkbox"
                      checked={row.isPreferred}
                      onChange={(event) => {
                        patchRow(row.key, { isPreferred: event.target.checked });
                      }}
                      className="h-5 w-5 shrink-0"
                    />
                    {copy.adminPreferred}
                  </label>
                  <AdminGhostButton
                    type="button"
                    onClick={() => {
                      setRows((previous) => previous.filter((entry) => entry.key !== row.key));

                      const removedId = row.id;

                      if (removedId !== undefined) {
                        setRemoved((previous) => [...previous, removedId]);
                      }
                    }}
                  >
                    {copy.adminRemove}
                  </AdminGhostButton>
                </div>
              </li>
            ))}
          </ul>
          <div>
            <AdminGhostButton
              type="button"
              onClick={() => {
                const next = counter + 1;

                setCounter(next);
                setRows((previous) => [
                  ...previous,
                  { key: `new-${next}`, languageTag: lang, name: "", isPreferred: false },
                ]);
              }}
            >
              {copy.adminAddName}
            </AdminGhostButton>
          </div>
        </PlaceDialog>
      ) : null}
    </>
  );
}

const parentIdFor = (raw: string): string | null | undefined => {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return null;
  }

  const parsed = parsePlaceRef(trimmed);

  if (!parsed.ok || !("placeId" in parsed.value.ref)) {
    return undefined;
  }

  return parsed.value.ref.placeId;
};

export function PlaceParentEditor({
  copy,
  lang,
  onSaved,
  place,
}: {
  readonly copy: Messages;
  readonly lang: Locale;
  readonly onSaved: () => void;
  readonly place: PlaceDetail;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const currentParentId = place.parents[0]?.id ?? null;

  const [parentRef, setParentRef] = useState(
    currentParentId === null ? "" : `place:${currentParentId}`,
  );

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextParentId = parentIdFor(parentRef);
  const valid = nextParentId !== undefined;
  const dirty = parentRef.trim() !== (currentParentId === null ? "" : `place:${currentParentId}`);

  const openDialog = (): void => {
    setParentRef(currentParentId === null ? "" : `place:${currentParentId}`);
    setError(null);
    setOpen(true);
  };

  const handleSave = (): void => {
    if (nextParentId === undefined || !dirty || pending) {
      return;
    }

    if (nextParentId === null && currentParentId === null) {
      return;
    }

    setPending(true);
    setError(null);

    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary: untyped server-function outcome, narrowed by readMutationFailure below.
    const onSettled = (outcome: unknown): void => {
      setPending(false);

      const failure = readMutationFailure(outcome, copy.adminSaveFailed);

      if (failure !== null) {
        setError(failure);

        return;
      }

      setOpen(false);
      onSaved();
    };

    const onFailed = (): void => {
      setPending(false);
      setError(copy.adminSaveFailed);
    };

    if (nextParentId === null) {
      const parentToRemove = currentParentId;

      if (parentToRemove === null) {
        setPending(false);

        return;
      }

      void adminPlaceParentFn({
        data: { placeId: place.id, parentPlaceId: parentToRemove, action: "remove" },
      }).then(onSettled, onFailed);

      return;
    }

    void adminPlaceParentFn({
      data: { placeId: place.id, parentPlaceId: nextParentId, action: "set" },
    }).then(onSettled, onFailed);
  };

  return (
    <>
      <GatedEdit
        available={placeFnAvailable("adminPlaceParentFn")}
        copy={copy}
        onOpen={openDialog}
      />
      {open ? (
        <PlaceDialog
          copy={copy}
          dirty={dirty}
          error={error}
          onClose={() => {
            setOpen(false);
          }}
          onSave={handleSave}
          open={open}
          pending={pending}
          title={copy.adminParentFilter}
          valid={valid}
        >
          <PlaceSelector
            id="place-parent-ref"
            label={copy.adminParentFilter}
            copy={copy}
            lang={lang}
            value={parentRef}
            onChange={setParentRef}
          />
          <p className="text-sm text-muted">{copy.adminNoParent}</p>
        </PlaceDialog>
      ) : null}
    </>
  );
}
