import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BookmarkIcon } from "lucide-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { z } from "zod";

import {
  addFavoriteFn,
  favoriteStatusFn,
  listFavoritesFn,
  removeFavoriteFn,
} from "@/modules/user/profile.functions";
import type { SessionState } from "@/modules/user/session.functions";
import { messagesFor, type Locale, type Messages } from "@/shared/i18n";

/**
 * Shared member-only save toggle. Membership always comes from a batched,
 * per-account status query owned by the surrounding card list — never from
 * a capped recent-favorites list — so cards stay correct no matter how many
 * dishes the account has saved. Every copy of the same dish card (homepage,
 * recommendations, detail, saved list) shares the same cache entries and
 * therefore always agrees.
 *
 * Data flow per list: `useFavoriteStatus(visibleIds, userId)` once, then one
 * `SaveDishButton` per card with the resolved value. Guests are sent to
 * sign-in with a return path; discovery itself never requires an account.
 */

export const favoriteStatusQueryKey = (
  userId: string,
  ids: ReadonlyArray<string>,
): ReadonlyArray<string> => ["favorites", "status", userId, ...ids.toSorted()];

/**
 * Batched membership probe for exactly the visible dish ids. Complete for
 * the rendered set regardless of total saved count; paged saved-list
 * enumeration stays on `useFavoriteIds`.
 */
export function useFavoriteStatus(ids: ReadonlyArray<string>, userId: string | null) {
  const sortedKey = useMemo(() => ids.toSorted().join(","), [ids]);

  const sorted = useMemo(
    (): Array<string> => (sortedKey === "" ? [] : sortedKey.split(",")),
    [sortedKey],
  );

  return useQuery({
    queryKey:
      userId === null
        ? ["favorites", "status", "signed-out"]
        : favoriteStatusQueryKey(userId, sorted),
    queryFn: async (): Promise<Array<string>> => favoriteStatusFn({ data: { ids: [...sorted] } }),
    enabled: userId !== null && sorted.length > 0,
    staleTime: 60_000,
    retry: 1,
  });
}

export const favoriteIdsQueryKey = (userId: string): ReadonlyArray<string> => [
  "favorites",
  "ids",
  userId,
];

const favoriteIdSchema = z.object({ dish_id: z.string().regex(/^[0-9]+$/) });

const favoriteExistsSchema = z.object({ _tag: z.literal("FavoriteExists") });

const favoriteNotFoundSchema = z.object({ _tag: z.literal("FavoriteNotFound") });

/** Paged enumeration for the saved list itself (not for card membership). */
export function useFavoriteIds(
  userId: string | null,
  limit: number,
  offset: number,
  initialData?: Array<string>,
) {
  return useQuery({
    queryKey:
      userId === null
        ? ["favorites", "ids", "signed-out"]
        : [...favoriteIdsQueryKey(userId), `limit:${limit}`, `offset:${offset}`],
    queryFn: async (): Promise<Array<string>> => {
      const rows = await listFavoritesFn({ data: { limit, offset } });

      return rows.map((entry) => favoriteIdSchema.parse(entry).dish_id);
    },
    initialData,
    enabled: userId !== null,
    staleTime: 60_000,
    retry: 1,
  });
}

const invalidateFavoriteCaches = (
  queryClient: {
    setQueriesData: (
      filters: { queryKey: ReadonlyArray<string> },
      updater: (old: Array<string> | undefined) => Array<string>,
    ) => void;
    invalidateQueries: (filters: { queryKey: ReadonlyArray<string> }) => void;
  },
  userId: string,
  dishId: string,
  saved: boolean,
): void => {
  queryClient.setQueriesData({ queryKey: ["favorites", "status", userId] }, (old) =>
    applyMembershipToIds(old ?? [], dishId, saved),
  );
  queryClient.invalidateQueries({ queryKey: ["favorites", "status", userId] });
  queryClient.invalidateQueries({ queryKey: favoriteIdsQueryKey(userId) });
};

/** Remove all cached favorites data, e.g. immediately after sign-out. */
export const clearFavoriteCaches = (queryClient: {
  removeQueries: (filters: { queryKey: ReadonlyArray<string> }) => void;
}): void => {
  queryClient.removeQueries({ queryKey: ["favorites"] });
};

/**
 * Pure cache updater behind mutation confirmations: the server-confirmed
 * outcome is written into every matching status cache first, so a stale
 * in-flight refetch can never paint over a newer action.
 */
export const applyMembershipToIds = (
  ids: ReadonlyArray<string>,
  dishId: string,
  saved: boolean,
): Array<string> => {
  if (saved) {
    return ids.includes(dishId) ? [...ids] : [...ids, dishId];
  }

  return ids.filter((id) => id !== dishId);
};

/**
 * Pure save-button state machine. `owner` is the server-verified user id the
 * confirmed value belongs to; `confirmed` is the last server-confirmed value
 * (`undefined` before membership resolves); `pending` is the in-flight
 * action; `failedAction` remembers what to retry. Failures never touch
 * `confirmed`, so retrying a failed removal attempts removal again —
 * never a save. Server snapshots are adopted only on first load or account
 * change, never over a newer confirmed action.
 */
export interface SaveButtonState {
  readonly owner: string | null;
  readonly confirmed: boolean | undefined;
  /** dataUpdatedAt of the query snapshot that produced `confirmed`. */
  readonly updatedAt: number;
  readonly pending: "save" | "unsave" | null;
  readonly failedAction: "save" | "unsave" | null;
}

export type SaveButtonEvent =
  | {
      readonly type: "resolved";
      readonly owner: string;
      readonly saved: boolean;
      readonly updatedAt: number;
    }
  | { readonly type: "identity-changed"; readonly owner: string | null }
  | { readonly type: "save-requested" }
  | { readonly type: "unsave-requested" }
  | { readonly type: "save-succeeded" }
  | { readonly type: "unsave-succeeded" }
  | { readonly type: "save-failed" }
  | { readonly type: "unsave-failed" }
  | { readonly type: "dismiss-error" };

export const initialSaveButtonState: SaveButtonState = {
  owner: null,
  confirmed: undefined,
  updatedAt: 0,
  pending: null,
  failedAction: null,
};

export const saveButtonTransition = (
  state: SaveButtonState,
  event: SaveButtonEvent,
): SaveButtonState => {
  switch (event.type) {
    case "resolved": {
      if (event.owner !== state.owner) {
        return {
          owner: event.owner,
          confirmed: event.saved,
          updatedAt: event.updatedAt,
          pending: null,
          failedAction: null,
        };
      }

      if (state.confirmed === undefined && state.pending === null) {
        return { ...state, confirmed: event.saved, updatedAt: event.updatedAt };
      }

      // Adopt only snapshots newer than the one behind `confirmed`: this is
      // what lets a second mounted button follow the first button's
      // server-confirmed action, while a stale in-flight refetch (older
      // fetch timestamp) can never paint over a newer value. Equal or older
      // timestamps are ignored; the next refetch converges.
      if (state.pending === null && event.updatedAt > state.updatedAt) {
        return { ...state, confirmed: event.saved, updatedAt: event.updatedAt };
      }

      return state;
    }

    case "identity-changed": {
      if (event.owner === state.owner) {
        return state;
      }

      return {
        owner: event.owner,
        confirmed: undefined,
        updatedAt: 0,
        pending: null,
        failedAction: null,
      };
    }

    case "save-requested": {
      if (state.pending !== null || state.confirmed === true) {
        return state;
      }

      return { ...state, pending: "save", failedAction: null };
    }

    case "unsave-requested": {
      if (state.pending !== null || state.confirmed === false) {
        return state;
      }

      return { ...state, pending: "unsave", failedAction: null };
    }

    case "save-succeeded": {
      return { ...state, confirmed: true, pending: null, failedAction: null };
    }

    case "unsave-succeeded": {
      return { ...state, confirmed: false, pending: null, failedAction: null };
    }

    case "save-failed": {
      return { ...state, pending: null, failedAction: "save" };
    }

    case "unsave-failed": {
      return { ...state, pending: null, failedAction: "unsave" };
    }

    case "dismiss-error": {
      if (state.failedAction === null) {
        return state;
      }

      return { ...state, failedAction: null };
    }

    default: {
      return state;
    }
  }
};

const saveLabel = (state: SaveButtonState, loading: boolean, copy: Messages): string => {
  if (state.pending === "save") {
    return copy.saveDishSaving;
  }

  if (state.pending === "unsave") {
    return copy.saveDishRemoving;
  }

  if (state.confirmed === true) {
    return copy.saveDishSaved;
  }

  if (state.failedAction !== null) {
    return copy.saveDishRetry;
  }

  if (loading || state.confirmed === undefined) {
    return copy.saveDishLoading;
  }

  return copy.saveDishSave;
};

export interface SaveButtonStatus {
  /** Authoritative membership from the list-level status query. */
  readonly saved: boolean | undefined;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly refetch: () => void;
  /** dataUpdatedAt of the query snapshot behind `saved`. */
  readonly updatedAt: number;
}

export interface FavoriteStatusQuery {
  readonly data: Array<string> | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly refetch: () => void;
  readonly dataUpdatedAt: number;
}

/** Project one dish's button status out of a list-level batched query. */
export const statusForDish = (query: FavoriteStatusQuery, dishId: string): SaveButtonStatus => ({
  saved: query.data?.includes(dishId),
  pending: query.isPending,
  failed: query.isError,
  refetch: () => {
    query.refetch();
  },
  updatedAt: query.dataUpdatedAt,
});

/**
 * Mobile guest entry: the phone button opens a bottom sheet with sign-in /
 * create-account actions instead of navigating straight away. Desktop keeps
 * the direct sign-in navigation. Both actions preserve `returnTo` verbatim
 * so auth lands back on the dish; nothing fabricates auth state.
 */
function GuestSaveSheetButton({
  compact = false,
  dishLabel,
  lang,
  onOpenChange,
  returnTo,
}: {
  readonly compact?: boolean;
  readonly dishLabel: string;
  readonly lang: Locale;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  readonly returnTo: string;
}) {
  const navigate = useNavigate();
  const [sheetOpen, setSheetOpen] = useState(false);
  const panelRef = useRef<HTMLDialogElement | null>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);

  // Notify an interested ancestor (e.g. the quiz drawer, which defers its
  // own Escape handling while a nested sheet owns the key) without changing
  // this component's standalone behavior when no listener is attached.
  useEffect(() => {
    onOpenChange?.(sheetOpen);
  }, [sheetOpen, onOpenChange]);

  useEffect(() => {
    if (!sheetOpen) {
      return undefined;
    }

    previouslyFocusedRef.current = document.activeElement;

    const scrollY = window.scrollY;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSheetOpen(false);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.querySelector<HTMLElement>("[data-sheet-focus]")?.focus({
      preventScroll: true,
    });

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      window.scrollTo({ top: scrollY, behavior: "auto" });

      const previous = previouslyFocusedRef.current;

      if (previous instanceof HTMLElement) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [sheetOpen]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSheetOpen(true);
        }}
        aria-label={compact ? dishLabel : undefined}
        title={compact ? dishLabel : undefined}
        className={
          compact
            ? "inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white text-ink transition hover:bg-ink hover:text-white md:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            : "inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white md:hidden"
        }
      >
        {compact ? <BookmarkIcon aria-hidden="true" className="size-4 flex-none" /> : null}
        {compact ? null : dishLabel}
      </button>
      {sheetOpen
        ? createPortal(
            <div className="fixed inset-0 z-50 flex items-end justify-center md:hidden">
              <dialog
                ref={panelRef}
                open
                aria-modal="true"
                aria-label={lang === "vi" ? "Lưu món ăn" : "Save dish"}
                lang={lang}
                className="pointer-events-auto m-0 flex max-h-[46dvh] w-full max-w-none flex-col overflow-hidden rounded-t-3xl border-2 border-b-0 border-border-soft bg-cream p-0 shadow-[0_-12px_32px_rgba(3,10,30,0.35)] motion-safe:animate-rec-step-enter motion-reduce:animate-none"
              >
                <div className="mx-auto mt-2 h-1.5 w-12 flex-none rounded-full bg-border-soft" />
                <div className="flex flex-none items-start justify-between gap-2 px-4 pt-2">
                  <h2
                    data-sheet-focus
                    tabIndex={-1}
                    className="font-display text-xl tracking-wide text-ink outline-none"
                  >
                    {lang === "vi" ? "Lưu món này để xem lại sau?" : "Save this dish for later?"}
                  </h2>
                  <button
                    type="button"
                    onClick={() => {
                      setSheetOpen(false);
                    }}
                    aria-label={lang === "vi" ? "Đóng" : "Close"}
                    className="inline-flex min-h-11 min-w-11 flex-none cursor-pointer items-center justify-center rounded-full border-2 border-border-soft bg-white px-3 text-sm font-bold text-ink transition hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                  >
                    ✕
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
                  <p className="text-sm font-semibold text-ink">
                    {lang === "vi"
                      ? "Đăng nhập để lưu các món bạn thích. Sau khi xong, bạn sẽ quay lại đúng món này."
                      : "Sign in to save dishes you love. You'll come right back to this dish afterwards."}
                  </p>
                </div>
                <div className="flex-none border-t-2 border-border-soft bg-cream px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void navigate({ to: "/sign-in", search: { returnTo, lang } });
                      }}
                      className="inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-full bg-ink px-5 text-sm font-bold text-white transition hover:opacity-90"
                    >
                      {lang === "vi" ? "Đăng nhập" : "Sign in"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void navigate({ to: "/sign-up", search: { returnTo, lang } });
                      }}
                      className="inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white"
                    >
                      {lang === "vi" ? "Tạo tài khoản" : "Create account"}
                    </button>
                  </div>
                </div>
              </dialog>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function SaveDishButton({
  compact = false,
  dishId,
  lang,
  onSaveSheetOpenChange,
  returnTo,
  session,
  status,
}: {
  readonly compact?: boolean;
  readonly dishId: string;
  readonly lang: Locale;
  readonly onSaveSheetOpenChange?: ((open: boolean) => void) | undefined;
  readonly returnTo: string;
  readonly session: SessionState;
  readonly status: SaveButtonStatus;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(saveButtonTransition, initialSaveButtonState);
  const copy = messagesFor(lang);

  const userId = session.status === "signed-in" ? session.user.id : null;

  useEffect(() => {
    dispatch({ type: "identity-changed", owner: userId });
  }, [userId]);

  useEffect(() => {
    if (status.saved !== undefined && userId !== null) {
      dispatch({
        type: "resolved",
        owner: userId,
        saved: status.saved,
        updatedAt: status.updatedAt,
      });
    }
  }, [status.saved, status.updatedAt, userId]);

  const confirmSave = (): void => {
    if (userId !== null) {
      invalidateFavoriteCaches(queryClient, userId, dishId, true);
    }

    dispatch({ type: "save-succeeded" });
  };

  const confirmUnsave = (): void => {
    if (userId !== null) {
      invalidateFavoriteCaches(queryClient, userId, dishId, false);
    }

    dispatch({ type: "unsave-succeeded" });
  };

  const save = useMutation({
    mutationFn: () => addFavoriteFn({ data: { dish_id: dishId } }),
    onSuccess: () => {
      confirmSave();
    },
    onError: (error) => {
      if (favoriteExistsSchema.safeParse(error).success) {
        confirmSave();

        return;
      }

      dispatch({ type: "save-failed" });
    },
  });

  const unsave = useMutation({
    mutationFn: () => removeFavoriteFn({ data: { dish_id: dishId } }),
    onSuccess: () => {
      confirmUnsave();
    },
    onError: (error) => {
      if (favoriteNotFoundSchema.safeParse(error).success) {
        confirmUnsave();

        return;
      }

      dispatch({ type: "unsave-failed" });
    },
  });

  if (session.status === "unavailable") {
    return (
      <p role="note" className="text-sm font-semibold text-muted">
        {copy.saveDishPaused}
      </p>
    );
  }

  if (session.status !== "signed-in") {
    return (
      <>
        <button
          type="button"
          onClick={() => {
            void navigate({ to: "/sign-in", search: { returnTo, lang } });
          }}
          className="hidden min-h-11 cursor-pointer items-center rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white md:inline-flex"
        >
          {copy.saveDishSave}
        </button>
        <GuestSaveSheetButton
          compact={compact}
          dishLabel={compact ? copy.saveDishSaveShort : copy.saveDishSave}
          lang={lang}
          onOpenChange={onSaveSheetOpenChange}
          returnTo={returnTo}
        />
      </>
    );
  }

  const loading = status.pending && state.confirmed === undefined;
  const initialLoadFailed = status.failed && state.confirmed === undefined;
  const refreshFailed = status.failed && state.confirmed !== undefined;
  const pending = save.isPending || unsave.isPending || state.pending !== null;

  const onToggle = (): void => {
    if (pending || loading || initialLoadFailed) {
      return;
    }

    if (state.confirmed === true) {
      dispatch({ type: "unsave-requested" });
      unsave.mutate();
    } else {
      dispatch({ type: "save-requested" });
      save.mutate();
    }
  };

  const retry = (): void => {
    if (pending || loading || initialLoadFailed || state.failedAction === null) {
      return;
    }

    if (state.failedAction === "save") {
      dispatch({ type: "save-requested" });
      save.mutate();
    } else {
      dispatch({ type: "unsave-requested" });
      unsave.mutate();
    }
  };

  if (initialLoadFailed) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span role="alert" className="text-sm font-bold text-danger">
          {copy.saveDishLoadError}
        </span>
        <button
          type="button"
          onClick={() => {
            status.refetch();
          }}
          className="inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-danger bg-white px-4 text-sm font-bold text-danger transition hover:bg-danger hover:text-white"
        >
          {copy.saveDishRetry}
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onToggle}
        disabled={pending || loading}
        aria-pressed={state.confirmed === true}
        aria-busy={pending || loading}
        aria-label={compact ? saveLabel(state, loading, copy) : undefined}
        title={compact ? saveLabel(state, loading, copy) : undefined}
        className={
          compact
            ? "inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border-2 border-ink bg-white text-ink transition hover:bg-ink hover:text-white disabled:cursor-wait disabled:opacity-70 aria-pressed:border-food-orange-strong aria-pressed:bg-food-orange-strong aria-pressed:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            : "inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-ink bg-white px-5 text-sm font-bold text-ink transition hover:bg-ink hover:text-white disabled:cursor-wait disabled:opacity-70 aria-pressed:border-food-orange-strong aria-pressed:bg-food-orange-strong aria-pressed:text-white"
        }
      >
        {compact ? (
          <BookmarkIcon
            aria-hidden="true"
            className="size-4 flex-none"
            fill={state.confirmed === true ? "currentColor" : "none"}
          />
        ) : null}
        {compact ? null : saveLabel(state, loading, copy)}
      </button>
      {refreshFailed && !pending ? (
        <span className="inline-flex items-center gap-2 text-xs font-semibold text-muted">
          {copy.saveDishRefreshFailed}
          <button
            type="button"
            onClick={() => {
              status.refetch();
            }}
            className="underline underline-offset-4 hover:text-ink"
          >
            {copy.saveDishRetry}
          </button>
        </span>
      ) : null}
      {state.failedAction !== null && !pending ? (
        <span role="alert" className="inline-flex items-center gap-2 text-sm font-bold text-danger">
          {state.failedAction === "save" ? copy.saveDishSaveFailed : copy.saveDishRemoveFailed}
          <button
            type="button"
            onClick={retry}
            className="inline-flex min-h-11 cursor-pointer items-center rounded-full border-2 border-danger bg-white px-4 text-sm font-bold text-danger transition hover:bg-danger hover:text-white"
          >
            {copy.saveDishRetry}
          </button>
        </span>
      ) : null}
    </span>
  );
}
