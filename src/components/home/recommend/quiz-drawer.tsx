import { XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { usePrefersReducedMotion } from "@/components/home/globe/use-prefers-reduced-motion";
import type { Locale } from "@/shared/i18n";

/**
 * Cross-component trigger for the mobile quiz drawer. The hero lives above
 * the quiz section with no shared parent this phase owns, so the hero
 * dispatches this event and the quiz flow listens for it. The draft is
 * never reset by opening or closing the drawer — the event only flips the
 * drawer's open flag.
 */
export const QUIZ_DRAWER_OPEN_EVENT = "feastjourney:open-quiz-drawer";

export const openQuizDrawer = (): void => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(QUIZ_DRAWER_OPEN_EVENT));
  }
};

/** Tailwind `md` breakpoint gate: true only below 768px. */
const MAX_MD_QUERY = "(max-width: 767.98px)";

/**
 * Client-only `max-md` mount gate. The drawer and the desktop card must
 * never mount together: shared radio `name` groups and control `id`s would
 * otherwise duplicate across the hidden tree. ClientOnly already shields
 * this quiz from SSR, so reading matchMedia in the initializer is safe.
 */
export function useIsMaxMd(): boolean {
  const [isMaxMd, setIsMaxMd] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MAX_MD_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(MAX_MD_QUERY);

    const onChange = (): void => {
      setIsMaxMd(media.matches);
    };

    media.addEventListener("change", onChange);

    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [setIsMaxMd]);

  return isMaxMd;
}

/**
 * Fallback close-animation length when the shared token cannot be resolved.
 * Must stay equal to `--drawer-spring-duration` in styles.css.
 */
export const DRAWER_SPRING_FALLBACK_MS = 450;

/**
 * Parse a CSS duration (`450ms`, `0.45s`) into milliseconds. Pure over its
 * input for unit-testing; anything unparsable, non-finite, or negative
 * falls back so the close timeout can never wedge the sheet open or unmount
 * it mid-slide.
 */
export function parseDrawerDurationMs(raw: string): number {
  const match = /^([\d.]+)\s*(m?s)$/.exec(raw.trim().toLowerCase());

  if (match?.[1] === undefined || match[2] === undefined) {
    return DRAWER_SPRING_FALLBACK_MS;
  }

  const value = Number(match[1]) * (match[2] === "s" ? 1000 : 1);

  if (!Number.isFinite(value) || value < 0) {
    return DRAWER_SPRING_FALLBACK_MS;
  }

  return value;
}

/**
 * Close-animation length, resolved live from the shared
 * `--drawer-spring-duration` token in styles.css — the timing source of
 * truth both the sheet exit and the globe push read. Falls back to 450ms
 * outside a browser or when the token is missing.
 */
function drawerSpringDurationMs(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return DRAWER_SPRING_FALLBACK_MS;
  }

  return parseDrawerDurationMs(
    window.getComputedStyle(document.documentElement).getPropertyValue("--drawer-spring-duration"),
  );
}

/**
 * Mobile-only bottom sheet shell for the quiz. A sibling overlay fixed to
 * the viewport bottom — the globe stays mounted and keeps spinning behind
 * it. Fixed at ~50dvh (not content-sized) so the shell never jumps between
 * steps and never covers more than about half the visible globe; the options
 * region scrolls internally (overscroll-contain) without moving the page,
 * and the primary action stays sticky at the bottom. The responsive clamp
 * keeps the sheet balanced on tall phones while the short-screen cap leaves
 * a visible globe strip on small viewports; the footer already pads for the
 * safe area.
 *
 * Enter/exit share the drawer-spring timing with the hero globe push (see
 * styles.css): the sheet slides up on open and back down on close, with a
 * delayed unmount spanning exactly one spring duration. Reduced motion
 * mounts/unmounts instantly with no animation and no delay.
 *
 * No dim backdrop by design: dimming would hide the globe the drawer is
 * meant to slide over. Dismissal is explicit (close button, Escape).
 * Hidden on `md` and up — the desktop card owns those widths.
 */
export function QuizDrawer({
  children,
  cityChip,
  closeLabel,
  footer,
  headerAction = null,
  headingId,
  label,
  lang,
  nestedDialogOpen = false,
  onClose,
  open,
  progress,
}: {
  readonly children: ReactNode;
  readonly cityChip: ReactNode | null;
  readonly closeLabel: string;
  readonly footer: ReactNode;
  readonly headerAction: ReactNode | null;
  readonly headingId: string;
  readonly label: string;
  readonly lang: Locale;
  /** True while a nested dialog (e.g. the guest sign-in sheet) owns Escape. */
  readonly nestedDialogOpen?: boolean;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly progress: ReactNode;
}) {
  const panelRef = useRef<HTMLDialogElement | null>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  // Delayed unmount for the close slide-down: when `open` flips false the
  // sheet keeps rendering with the exit animation for exactly one spring
  // duration, then unmounts. State transitions below are render-phase
  // adjustments (same pattern as the rail index reset in quiz-flow), so the
  // exit starts synchronously in the closing commit: reopening mid-close
  // drops the exit state and replays enter, and reduced motion skips the
  // exit state entirely. The effect only owns the timeout (an external
  // system); route-change unmount clears it via effect cleanup.
  const [hasOpened, setHasOpened] = useState(open);
  const [exiting, setExiting] = useState(false);

  if (open && !hasOpened) {
    setHasOpened(true);
  }

  if (open && exiting) {
    setExiting(false);
  }

  if (!open && hasOpened && !reducedMotion && !exiting) {
    setExiting(true);
  }

  if (!open && hasOpened && reducedMotion && exiting) {
    setHasOpened(false);
    setExiting(false);
  }

  useEffect(() => {
    if (!exiting) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setHasOpened(false);
      setExiting(false);
    }, drawerSpringDurationMs());

    return () => {
      window.clearTimeout(timer);
    };
  }, [exiting]);

  const rendered = open || exiting;

  // Lock body scroll while rendered (including the exit animation) and
  // preserve the exact scroll position on close; restore focus to whatever
  // opened the drawer. Runs once per mount cycle: nested-dialog toggles must
  // not re-trigger scroll or focus side effects while the drawer stays open.
  // Cleanup on final unmount also covers route changes, so a mid-animation
  // navigation never leaves a stuck scroll lock.
  useEffect(() => {
    if (!rendered) {
      return undefined;
    }

    previouslyFocusedRef.current = document.activeElement;

    const scrollY = window.scrollY;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("[data-drawer-focus]")?.focus({
      preventScroll: true,
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      window.scrollTo({ top: scrollY, behavior: "auto" });

      const previous = previouslyFocusedRef.current;

      if (previous instanceof HTMLElement) {
        previous.focus({ preventScroll: true });
      }
    };
    // Mount/unmount only: re-running on nested-dialog toggles would yank
    // focus out of the sheet and unlock/relock scrolling mid-session.
  }, [rendered]);

  // Escape closes the topmost layer only: a nested dialog (e.g. the guest
  // sign-in sheet) owns the key while open and reports that through
  // onSaveSheetOpenChange; both sheets listen on document, so without this
  // guard one keypress would dismiss both layers.
  useEffect(() => {
    if (!rendered) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nestedDialogOpen) {
        return;
      }

      onClose();
    };

    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [rendered, nestedDialogOpen, onClose]);

  if (!rendered) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center md:hidden">
      <dialog
        ref={panelRef}
        open
        aria-modal="true"
        aria-label={label}
        lang={lang}
        className={`pointer-events-auto m-0 flex h-[clamp(18rem,50dvh,34rem)] max-h-[calc(100dvh-3.5rem)] w-full max-w-none flex-col overflow-hidden rounded-t-3xl border-2 border-b-0 border-border-soft bg-cream p-0 shadow-[0_-12px_32px_rgba(3,10,30,0.35)] motion-reduce:animate-none ${
          exiting ? "motion-safe:animate-drawer-exit" : "motion-safe:animate-drawer-enter"
        }`}
      >
        <div className="mx-auto mt-2 h-1.5 w-12 flex-none rounded-full bg-border-soft" />
        <div className="flex flex-none items-center justify-between gap-2 px-4 pt-2">
          <div
            id={headingId}
            data-drawer-focus
            tabIndex={-1}
            className="min-w-0 flex-1 outline-none"
          >
            {progress}
          </div>
          {headerAction === null ? null : <div className="flex-none">{headerAction}</div>}
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="inline-flex min-h-11 min-w-11 flex-none cursor-pointer items-center justify-center rounded-full border-2 border-border-soft bg-white px-3 text-sm font-bold text-ink transition hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </button>
        </div>
        {cityChip !== null ? <div className="flex-none px-4 pt-2">{cityChip}</div> : null}
        <div
          data-drawer-body
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
        >
          {children}
        </div>
        {footer === null || footer === undefined ? null : (
          <div className="flex-none border-t-2 border-border-soft bg-cream px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </dialog>
    </div>
  );
}
