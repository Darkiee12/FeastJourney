import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode, type TouchEvent } from "react";

import { useMobileHome } from "@/components/home/mobile/mobile-home-context";
import type { MobileSheetMode } from "@/components/home/mobile/mobile-home-state";
import type { Locale } from "@/shared/i18n";

export function sheetTitleFor(mode: MobileSheetMode, lang: Locale): string {
  if (lang === "vi") {
    if (mode === "discovery" || mode === "results") return "Khám phá món ăn";

    if (mode === "location") return "Chọn nơi khám phá";

    if (mode === "quiz") return "Tìm món của bạn";

    return "Khám phá";
  }

  if (mode === "discovery" || mode === "results") return "Discover dishes";

  if (mode === "location") return "Choose where to explore";

  if (mode === "quiz") return "Find your dish";

  return "Discover";
}

export function MobileSheet({
  children,
  heightPx,
  lang,
  discoverLabel,
}: {
  children: ReactNode;
  heightPx: number;
  lang: Locale;
  discoverLabel: string;
}) {
  const mobile = useMobileHome();
  const { mode, nestedDialogOpen } = mobile.state;
  const { back, closeSheet, openDiscovery } = mobile;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const prevModeRef = useRef(mode);
  const touchStartYRef = useRef<number | null>(null);
  const swipedRef = useRef(false);
  const collapsed = mode === "collapsed";
  const title = collapsed ? discoverLabel : sheetTitleFor(mode, lang);
  const collapseLabel = lang === "vi" ? "Thu gọn" : "Collapse";
  const closeLabel = lang === "vi" ? "Đóng" : "Close";

  useEffect(() => {
    if (collapsed) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nestedDialogOpen) return;

      if (mode === "location") back();
      else closeSheet();
    };

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [collapsed, mode, nestedDialogOpen, back, closeSheet]);

  useEffect(() => {
    if (mode !== "collapsed") headingRef.current?.focus({ preventScroll: true });
  }, [mode]);

  // Focus restoration on collapse: the open-state title and header buttons
  // unmount, so focus moves to the expand control instead of dropping to
  // the body. Skipped on first mount (the sheet starts collapsed).
  useEffect(() => {
    const previous = prevModeRef.current;
    prevModeRef.current = mode;

    if (previous !== "collapsed" && mode === "collapsed") {
      expandRef.current?.focus({ preventScroll: true });
    }
  }, [mode]);

  // A swipe ending over a header button must not also fire that button's
  // tap action: the swipe already navigated, so the follow-up click is a
  // no-op. Both dispatches are idempotent, this just avoids double work.
  const guarded = (action: () => void): (() => void) => {
    return () => {
      if (swipedRef.current) {
        swipedRef.current = false;

        return;
      }

      action();
    };
  };

  const handleTouchStart = (event: TouchEvent): void => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
    swipedRef.current = false;
  };

  const handleTouchEnd = (event: TouchEvent): void => {
    const start = touchStartYRef.current;
    const end = event.changedTouches[0]?.clientY ?? null;

    touchStartYRef.current = null;

    if (start === null || end === null) return;

    const delta = end - start;

    if (collapsed && delta < -40) {
      swipedRef.current = true;
      openDiscovery();
    } else if (!collapsed && delta > 40) {
      swipedRef.current = true;
      closeSheet();
    }
  };

  return (
    <section
      aria-label={title}
      data-mobile-sheet={mode}
      className="absolute inset-x-0 bottom-0 z-40 flex flex-col overflow-hidden rounded-t-3xl border-2 border-b-0 border-border-soft bg-cream shadow-[0_-12px_32px_rgba(3,10,30,0.35)] motion-safe:transition-[height] motion-safe:duration-[450ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0,1)]"
      style={{ height: `${heightPx}px` }}
    >
      <div
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className="flex min-h-[74px] w-full flex-none items-center gap-3 px-4 py-2"
      >
        <span
          aria-hidden="true"
          className="absolute top-2 left-1/2 h-1.5 w-12 -translate-x-1/2 rounded-full bg-border-soft"
        />
        {collapsed ? (
          <button
            type="button"
            ref={expandRef}
            onClick={guarded(openDiscovery)}
            aria-expanded={false}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 pt-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-extrabold text-ink">{title}</span>
              <span className="block text-sm text-muted">
                {lang === "vi"
                  ? "Vuốt lên hoặc chạm để khám phá"
                  : "Swipe up or tap to explore dishes"}
              </span>
            </span>
            <ChevronUpIcon aria-hidden="true" className="size-5 flex-none text-ink" />
          </button>
        ) : (
          <>
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="block min-w-0 flex-1 truncate pt-2 text-base font-extrabold text-ink outline-none"
            >
              {title}
            </h2>
            <span className="flex flex-none items-center gap-1 pt-2">
              <button
                type="button"
                onClick={guarded(back)}
                aria-label={collapseLabel}
                className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full text-ink transition hover:bg-border-soft/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                <ChevronDownIcon aria-hidden="true" className="size-5" />
              </button>
              <button
                type="button"
                onClick={guarded(closeSheet)}
                aria-label={closeLabel}
                className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-full text-ink transition hover:bg-border-soft/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
              >
                <XIcon aria-hidden="true" className="size-5" />
              </button>
            </span>
          </>
        )}
      </div>
      {/* Panes stay mounted across modes (state preservation); MobileHome
          hides the inactive pane, and collapsed mode hides both. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </section>
  );
}
