import { XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

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
 * Mobile-only bottom sheet shell for the quiz. A sibling overlay fixed to
 * the viewport bottom — the globe stays mounted and keeps spinning behind
 * it. Fixed at ~46dvh (not content-sized) so the shell never jumps between
 * steps and never covers more than half the visible globe; the options
 * region scrolls internally (overscroll-contain) without moving the page,
 * and the primary action stays sticky at the bottom.
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
  readonly onClose: () => void;
  readonly open: boolean;
  readonly progress: ReactNode;
}) {
  const panelRef = useRef<HTMLDialogElement | null>(null);
  const previouslyFocusedRef = useRef<Element | null>(null);

  // Lock body scroll while open and preserve the exact scroll position on
  // close; restore focus to whatever opened the drawer.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    previouslyFocusedRef.current = document.activeElement;

    const scrollY = window.scrollY;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.querySelector<HTMLElement>("[data-drawer-focus]")?.focus({
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
  }, [open, onClose]);

  if (!open) {
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
        className="pointer-events-auto m-0 flex h-[46dvh] max-h-[46dvh] w-full max-w-none flex-col overflow-hidden rounded-t-3xl border-2 border-b-0 border-border-soft bg-cream p-0 shadow-[0_-12px_32px_rgba(3,10,30,0.35)] motion-safe:animate-rec-step-enter motion-reduce:animate-none"
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
