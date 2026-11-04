import { Link, getRouteApi, useRouter } from "@tanstack/react-router";
import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from "react";

import type { ImportJobStatus } from "@/modules/food-discovery/admin.schema";
import type { AdminCapabilities } from "@/modules/user/admin.functions";
import { messagesFor, type Messages } from "@/shared/i18n";

const STATUS_BADGE_CLASS: ReadonlyMap<ImportJobStatus, string> = new Map([
  ["applied", "border-green-200 bg-green-50 text-green-800"],
  ["applying", "border-amber-200 bg-amber-50 text-amber-800"],
  ["failed", "border-red-200 bg-red-50 text-red-800"],
  ["staged", "border-border-soft bg-cream text-muted"],
  ["validated", "border-brand-blue/20 bg-brand-blue/10 text-brand-blue"],
]);

const STATUS_BADGE_FALLBACK = "border-border-soft bg-cream text-muted";

/**
 * Single status badge used by every admin import surface so the "applying"
 * intermediate state (crash-resume window) renders exactly like every other
 * lifecycle state instead of crashing a local zod union or appearing raw.
 */
export function ImportStatusBadge({ status }: { readonly status: ImportJobStatus }): ReactNode {
  const tone = STATUS_BADGE_CLASS.get(status) ?? STATUS_BADGE_FALLBACK;

  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {status}
    </span>
  );
}

export const adminNavLinkClass =
  "inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-sm font-semibold whitespace-nowrap text-white/85 no-underline hover:bg-white/10 hover:text-white aria-[current=page]:bg-white/10 aria-[current=page]:text-white";

/**
 * One Feast Lab entry in the primary navbar. `to` is a static route path
 * (never a URL string), so the navbar can never point at an unregistered
 * admin surface. Visibility mirrors the same capability vocabulary the
 * server operations enforce — the menu is never a security boundary.
 */
export interface AdminNavEntry {
  readonly exact: boolean;
  readonly label: string;
  readonly to:
    | "/admin"
    | "/admin/dishes"
    | "/admin/places"
    | "/admin/imports"
    | "/admin/restaurants"
    | "/admin/reviews"
    | "/admin/users"
    | "/admin/roles"
    | "/admin/taxonomy";
}

/**
 * Single source of truth for the capability-gated Feast Lab sections.
 * Shared by the mode-switching navbar in `__root.tsx` and the admin shell
 * in `admin.tsx` so the two can never drift apart. Server authorization
 * is untouched: every admin route still enforces its own checks.
 */
export const adminNavEntries = (
  capabilities: AdminCapabilities,
  copy: Messages,
): ReadonlyArray<AdminNavEntry> => {
  const candidates: ReadonlyArray<{ readonly entry: AdminNavEntry; readonly visible: boolean }> = [
    {
      entry: { label: copy.adminDashboard, to: "/admin", exact: true },
      visible: capabilities.overview,
    },
    {
      entry: { label: copy.adminDishes, to: "/admin/dishes", exact: false },
      visible: capabilities.dishes,
    },
    {
      entry: { label: copy.adminPlaces, to: "/admin/places", exact: false },
      visible: capabilities.dishes,
    },
    {
      entry: { label: copy.adminImports, to: "/admin/imports", exact: false },
      visible: capabilities.imports,
    },
    {
      entry: { label: copy.adminRestaurants, to: "/admin/restaurants", exact: false },
      visible: capabilities.restaurants,
    },
    {
      entry: { label: copy.adminReviews, to: "/admin/reviews", exact: false },
      visible: capabilities.reviews,
    },
    {
      entry: { label: copy.adminMembers, to: "/admin/users", exact: false },
      visible: capabilities.members,
    },
    {
      entry: { label: copy.adminRoles, to: "/admin/roles", exact: false },
      visible: capabilities.roles,
    },
    {
      entry: { label: copy.adminTaxonomy, to: "/admin/taxonomy", exact: false },
      visible: capabilities.imports,
    },
  ];

  return candidates.flatMap((candidate) => (candidate.visible ? [candidate.entry] : []));
};

/**
 * True while any `/admin/*` route is matched. Determined from TanStack
 * Router's matched route ids (layout context), never from pathname string
 * hacks, so basepath or locale search params cannot fool it.
 */
export const isAdminRouteMatch = (routeIds: ReadonlyArray<string>): boolean =>
  routeIds.some((routeId) => routeId === "/admin" || routeId.startsWith("/admin/"));

export const adminPrimaryButtonClass =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-food-orange-dark px-4 py-2 text-sm font-bold text-white hover:bg-food-orange-strong disabled:opacity-50";

export const adminSecondaryButtonClass =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg bg-brand-blue px-4 py-2 text-sm font-bold text-white hover:bg-brand-blue-hover disabled:opacity-50";

export const adminGhostButtonClass =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-border-soft bg-white px-4 py-2 text-sm font-semibold text-ink hover:bg-cream disabled:opacity-50";

export function AdminPrimaryButton(props: ComponentProps<"button">): ReactNode {
  const { type, className, ...rest } = props;

  return (
    <button
      type={type ?? "button"}
      {...rest}
      className={`${adminPrimaryButtonClass} ${className ?? ""}`}
    />
  );
}

export function AdminSecondaryButton(props: ComponentProps<"button">): ReactNode {
  const { type, className, ...rest } = props;

  return (
    <button
      type={type ?? "button"}
      {...rest}
      className={`${adminSecondaryButtonClass} ${className ?? ""}`}
    />
  );
}

export function AdminGhostButton(props: ComponentProps<"button">): ReactNode {
  const { type, className, ...rest } = props;

  return (
    <button
      type={type ?? "button"}
      {...rest}
      className={`${adminGhostButtonClass} ${className ?? ""}`}
    />
  );
}

export function AdminPageHeading({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-display text-4xl tracking-wide">{title}</h1>
        {description === undefined ? null : <p className="text-sm text-muted">{description}</p>}
      </div>
      {action === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      )}
    </div>
  );
}

export function AdminCard({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactNode {
  return (
    <div className={`rounded-2xl border border-border-soft bg-white p-4 ${className ?? ""}`}>
      {children}
    </div>
  );
}

export function AdminSection({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-2xl border border-border-soft bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-bold">
          {title}
        </h2>
        {action === undefined ? null : <div className="flex items-center gap-2">{action}</div>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function AdminToolbar({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">{children}</div>
  );
}

export function AdminTable({
  children,
  minWidthClass,
}: {
  readonly children: ReactNode;
  readonly minWidthClass?: string;
}): ReactNode {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border-soft bg-white">
      <table
        className={`w-full border-collapse text-left text-sm ${minWidthClass ?? "min-w-[28rem]"}`}
      >
        {children}
      </table>
    </div>
  );
}

export function AdminEmptyState({
  message,
  action,
}: {
  readonly message: string;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <AdminCard>
      <p className="text-sm text-muted">{message}</p>
      {action === undefined ? null : <div className="mt-3">{action}</div>}
    </AdminCard>
  );
}

export function AdminErrorState({
  message,
  retryLabel,
  onRetry,
  pending,
}: {
  readonly message: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
  readonly pending?: boolean;
}): ReactNode {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2"
    >
      <p className="text-sm font-semibold text-red-800">{message}</p>
      <AdminGhostButton
        type="button"
        disabled={pending ?? false}
        aria-busy={pending ?? false}
        onClick={onRetry}
      >
        {retryLabel}
      </AdminGhostButton>
    </div>
  );
}

/**
 * Shared centered modal for Feast Lab surfaces (import schema guide,
 * confirm dialogs). One Radix Dialog primitive so every modal shares the
 * same contract: portaled and truly modal, viewport-covering backdrop with
 * an inert background plus scroll lock, Escape and backdrop-click close,
 * automatic focus trap with restore, an always-visible X close button, and
 * an accessible title/description pair.
 *
 * Geometry: centered with `left-1/2 top-1/2` plus translate (never a
 * hand-rolled `<dialog open>` inside a flex wrapper, which UA stylesheets
 * left-anchor), `w: calc(100vw - 2rem)` inside viewport padding,
 * `max-w: 54rem` (~864px) on desktop, `max-h: min(85dvh, 900px)`, a sticky
 * header, an independently scrollable body (`min-h-0`/`min-w-0`), and an
 * optional sticky footer. No animation classes, so `prefers-reduced-motion`
 * needs no override. No page layout shift or horizontal overflow.
 *
 * Usage:
 *
 * ```tsx
 * const [open, setOpen] = useState(false);
 *
 * <AdminDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   title={copy.adminImportSchemaGuideTitle}
 *   description={limitsLine}
 *   closeLabel={copy.adminImportSchemaClose}
 * >
 *   <p>Body scrolls while the header and close button stay put.</p>
 * </AdminDialog>;
 * ```
 *
 * Focus: Radix traps focus while open. Restore is recorded here because
 * these dialogs open from plain buttons (controlled `open`, no Radix
 * Trigger child), and this Radix version only restores to a registered
 * Trigger — without one, focus fell back to `body` on close.
 */
export function AdminDialog({
  children,
  closeLabel,
  description,
  dismissOnBackdrop,
  footer,
  onOpenChange,
  open,
  title,
}: {
  readonly children: ReactNode;
  readonly closeLabel: string;
  readonly description?: string;
  readonly dismissOnBackdrop?: boolean;
  readonly footer?: ReactNode;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly title: string;
}): ReactNode {
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) {
      return () => undefined;
    }

    openerRef.current = document.activeElement;

    return () => {
      const opener = openerRef.current;

      openerRef.current = null;

      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40" />
        <Dialog.Content
          onInteractOutside={(event) => {
            if (dismissOnBackdrop === false) {
              event.preventDefault();
            }
          }}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(85dvh,900px)] min-h-0 w-[calc(100vw-2rem)] max-w-[54rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border-soft bg-white shadow-xl focus:outline-none"
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border-soft px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="font-display text-2xl tracking-wide">{title}</Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="mt-1 text-sm text-muted">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={closeLabel}
                title={closeLabel}
                className="inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border-soft bg-white text-ink hover:bg-cream focus-visible:ring-2 focus-visible:ring-brand-blue/40 focus-visible:outline-none"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer === undefined ? null : (
            <div className="shrink-0 border-t border-border-soft px-5 py-3">{footer}</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AdminConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  dangerous,
  pending,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly dangerous?: boolean;
  readonly pending?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const confirmClass = dangerous === true ? adminPrimaryButtonClass : adminSecondaryButtonClass;

  return (
    <AdminDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
        }
      }}
      title={title}
      description={description}
      closeLabel={cancelLabel}
      dismissOnBackdrop={!(pending ?? false)}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <AdminGhostButton type="button" onClick={onCancel}>
            {cancelLabel}
          </AdminGhostButton>
          <button
            type="button"
            disabled={pending ?? false}
            aria-busy={pending ?? false}
            onClick={onConfirm}
            className={confirmClass}
          >
            {confirmLabel}
          </button>
        </div>
      }
    >
      <p className="text-sm text-muted">{description}</p>
    </AdminDialog>
  );
}

type AdminFieldProps = {
  readonly id: string;
  readonly label: string;
  readonly error?: string | null;
} & Omit<ComponentProps<"input">, "id" | "aria-invalid" | "aria-describedby">;

export function AdminField({ id, label, error, ...rest }: AdminFieldProps): ReactNode {
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null && error !== "";

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <input
        id={id}
        {...rest}
        aria-invalid={hasError}
        aria-describedby={hasError ? errorId : undefined}
        className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink"
      />
      {hasError ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * @deprecated Prefer the canonical Radix primitive
 * (`@/components/admin/select` AdminSelect/AdminSelectField) for every
 * standard single-value select. This native `<select>` has no remaining
 * consumers (the imports toolbar was the last one; it now uses
 * `AdminSelectField`) and is kept only so external imports keep compiling.
 * Do not extend it — remove it once deletion is approved.
 *
 * One consistent select presentation for every Feast Lab surface (import
 * toolbar, wizard stages). A styled native `<select>` with
 * `appearance-none` plus a single decorative chevron — never a second
 * native chevron, never a div-dropdown. Keyboard, labels, disabled,
 * invalid, and focus-visible states are identical everywhere.
 */
export function AdminSelect({
  error,
  hint,
  id,
  label,
  onChange,
  options,
  value,
  ...rest
}: {
  readonly error?: string | null;
  readonly hint?: string;
  readonly id: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly options: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly value: string;
} & Omit<ComponentProps<"select">, "id" | "onChange" | "value" | "aria-invalid">): ReactNode {
  const failure = error ?? null;
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy = [hintId, failure !== null ? errorId : undefined]
    .filter((part) => part !== undefined)
    .join(" ");

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      )}
      <span className="relative block">
        <select
          id={id}
          value={value}
          aria-invalid={failure !== null}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          {...rest}
          className="min-h-11 w-full appearance-none rounded-lg border border-border-soft bg-white pr-10 pl-3 text-sm text-ink outline-none focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-red-400"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-muted"
        >
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {failure !== null ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-red-800">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

export function AdminSkeleton({ label }: { readonly label?: string }): ReactNode {
  return (
    <output className="flex flex-col gap-2 rounded-2xl border border-border-soft bg-white p-4">
      <span className="sr-only">{label ?? "Loading…"}</span>
      <div aria-hidden="true" className="h-6 w-1/3 animate-pulse rounded-lg bg-cream" />
      <div aria-hidden="true" className="h-4 w-full animate-pulse rounded-lg bg-cream" />
      <div aria-hidden="true" className="h-4 w-5/6 animate-pulse rounded-lg bg-cream" />
    </output>
  );
}

const rootRoute = getRouteApi("__root__");

/**
 * Shared route-level failure surface for Feast Lab workspaces. Shows a
 * human-readable heading, a safe description, a Retry action, and a way back
 * to Feast Lab. Never renders raw errors, SQL, or stack traces.
 */
export function AdminRouteError(): ReactNode {
  const { lang } = rootRoute.useSearch();
  const router = useRouter();
  const copy = messagesFor(lang);

  const heading = lang === "vi" ? "Không tải được mục này" : "This section could not be loaded";

  const description =
    lang === "vi"
      ? "Đã xảy ra sự cố phía chúng tôi. Dữ liệu của bạn không bị thay đổi."
      : "Something went wrong on our side. None of your data was changed.";

  return (
    <AdminCard>
      <h1 className="font-display text-4xl tracking-wide">{heading}</h1>
      <p className="mt-2 text-sm text-muted">{description}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <AdminSecondaryButton
          type="button"
          onClick={() => {
            void router.invalidate();
          }}
        >
          {copy.commonRetry}
        </AdminSecondaryButton>
        <Link
          to="/admin"
          search={{ lang }}
          className="inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-semibold text-brand-blue underline"
        >
          ← {copy.adminWorkspace}
        </Link>
      </div>
    </AdminCard>
  );
}
