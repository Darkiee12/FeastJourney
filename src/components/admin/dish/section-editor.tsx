import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import {
  dishEditFnAvailable,
  invokeDishEdit,
  type DishEditFnName,
  type DishEditPayload,
} from "@/components/admin/dish/edit-contracts";
import { AdminDialog, AdminGhostButton, adminGhostButtonClass } from "@/components/admin/ui";
import { authorizeFn } from "@/modules/user/admin.functions";
import type { Locale, Messages } from "@/shared/i18n";

/**
 * Shared building blocks for the dish-detail section editors.
 *
 * Gating contract (never decorative controls):
 * - The section's server function is missing → the editor renders nothing
 *   (read-only card stays). Availability is a synchronous probe, so the
 *   first paint already knows — no layout jump.
 * - `food:update` is denied or still being checked → the Edit trigger is
 *   replaced by an `aria-hidden` placeholder of identical size while
 *   checking (no layout jump), and by nothing once denied. Server fns
 *   enforce `food:update` independently; this is display gating only.
 * - Save is disabled while the draft equals the snapshot (dirty-state),
 *   while a save is in flight (anti-double-submit), or while validation
 *   reports errors. Success refreshes detail data via `router.invalidate()`
 *   without a full reload, so list filters/pagination on the return
 *   breadcrumb are preserved.
 */

export interface FoodUpdateGate {
  readonly allowed: boolean;
  readonly checking: boolean;
}

export function useFoodUpdateAllowed(): FoodUpdateGate {
  const probe = useQuery({
    queryKey: ["admin", "can", "food:update"],
    queryFn: () => authorizeFn({ data: { checks: [{ resource: "food", actions: ["update"] }] } }),
    staleTime: 60_000,
    retry: false,
  });

  return {
    // Fail closed: errors and missing data mean no Edit affordance.
    allowed: probe.data?.allowed ?? false,
    checking: probe.isPending,
  };
}

export function EditTrigger({
  copy,
  hidden,
  label,
  onOpen,
}: {
  readonly copy: Messages;
  readonly hidden: boolean;
  readonly label?: string;
  readonly onOpen: () => void;
}): ReactNode {
  if (hidden) {
    // Size-matched placeholder keeps the panel header geometry stable while
    // the capability probe resolves or when editing is legitimately absent.
    return (
      <span
        aria-hidden="true"
        className={`${adminGhostButtonClass} invisible min-w-[4.5rem] shrink-0`}
      >
        {copy.adminEdit}
      </span>
    );
  }

  return (
    <AdminGhostButton
      type="button"
      onClick={onOpen}
      aria-label={label ?? copy.adminEdit}
      className="min-w-[4.5rem] shrink-0 text-sm"
    >
      {copy.adminEdit}
    </AdminGhostButton>
  );
}

export function GatedEdit({
  available,
  copy,
  onOpen,
}: {
  readonly available: boolean;
  readonly copy: Messages;
  readonly onOpen: () => void;
}): ReactNode {
  const { allowed, checking } = useFoodUpdateAllowed();

  if (!available) {
    return null;
  }

  if (checking) {
    return <EditTrigger copy={copy} hidden onOpen={onOpen} />;
  }

  if (!allowed) {
    return null;
  }

  return <EditTrigger copy={copy} hidden={false} onOpen={onOpen} />;
}

export function GatedEditTrigger({
  copy,
  fnName,
  onOpen,
}: {
  readonly copy: Messages;
  readonly fnName: DishEditFnName;
  readonly onOpen: () => void;
}): ReactNode {
  return <GatedEdit available={dishEditFnAvailable(fnName)} copy={copy} onOpen={onOpen} />;
}

export interface EditSaveHandle {
  readonly error: string | null;
  readonly pending: boolean;
  readonly save: (data: DishEditPayload) => void;
}

export function useEditSave(input: {
  readonly copy: Messages;
  readonly fnName: DishEditFnName;
  readonly onSaved: () => void;
}): EditSaveHandle {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (data: DishEditPayload) => invokeDishEdit(input.fnName, data),
    onSuccess: () => {
      setError(null);
      input.onSaved();
      void router.invalidate();
    },
    onError: () => {
      setError(input.copy.adminSaveFailed);
    },
  });

  return {
    save: (data: DishEditPayload) => {
      setError(null);
      mutation.mutate(data);
    },
    pending: mutation.isPending,
    error,
  };
}

export function SectionDialog({
  canSave,
  children,
  copy,
  dirty,
  error,
  lang,
  onClose,
  onSave,
  open,
  pending,
  title,
}: {
  readonly canSave: boolean;
  readonly children: ReactNode;
  readonly copy: Messages;
  readonly dirty: boolean;
  readonly error: string | null;
  readonly lang: Locale;
  readonly onClose: () => void;
  readonly onSave: () => void;
  readonly open: boolean;
  readonly pending: boolean;
  readonly title: string;
}): ReactNode {
  const hint = lang === "vi" ? "Chưa có thay đổi nào để lưu." : copy.adminNoChanges;

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
            {!dirty ? hint : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <AdminGhostButton type="button" disabled={pending} onClick={onClose}>
              {copy.commonCancel}
            </AdminGhostButton>
            <button
              type="button"
              disabled={pending || !dirty || !canSave}
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

export const sameDraft = <Draft,>(left: Draft, right: Draft): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
