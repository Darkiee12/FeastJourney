import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { useMobileHome } from "@/components/home/mobile/mobile-home-context";
import type { MobileSheetMode } from "@/components/home/mobile/mobile-home-state";
import type { Locale } from "@/shared/i18n";

export function sheetTitleFor(mode: MobileSheetMode, lang: Locale): string {
  if (lang === "vi") {
    if (mode === "discovery") return "Khám phá món ăn";

    if (mode === "location") return "Chọn nơi khám phá";

    if (mode === "quiz") return "Tìm món của bạn";

    if (mode === "results") return "Món gợi ý";

    return "Khám phá";
  }

  if (mode === "discovery") return "Discover food";

  if (mode === "location") return "Choose where to explore";

  if (mode === "quiz") return "Find your dish";

  if (mode === "results") return "Recommended dishes";

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
  const { back, closeSheet } = mobile;
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const swipedRef = useRef(false);
  const collapsed = mode === "collapsed";

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

  return (
    <section
      aria-label={sheetTitleFor(mode, lang)}
      data-mobile-sheet={mode}
      className="absolute inset-x-0 bottom-0 z-40 flex flex-col overflow-hidden rounded-t-3xl border-2 border-b-0 border-border-soft bg-cream shadow-[0_-12px_32px_rgba(3,10,30,0.35)] motion-safe:transition-[height] motion-safe:duration-[450ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0,1)]"
      style={{ height: `${heightPx}px` }}
    >
      <button
        type="button"
        onTouchStart={(event) => {
          touchStartYRef.current = event.touches[0]?.clientY ?? null;
          swipedRef.current = false;
        }}
        onTouchEnd={(event) => {
          const start = touchStartYRef.current;
          const end = event.changedTouches[0]?.clientY ?? null;

          touchStartYRef.current = null;

          if (start === null || end === null) return;

          const delta = end - start;

          if (collapsed && delta < -40) {
            swipedRef.current = true;
            mobile.openDiscovery();
          } else if (!collapsed && delta > 40) {
            swipedRef.current = true;
            mobile.closeSheet();
          }
        }}
        onClick={() => {
          if (swipedRef.current) {
            swipedRef.current = false;

            return;
          }

          if (collapsed) mobile.openDiscovery();
          else mobile.closeSheet();
        }}
        aria-expanded={!collapsed}
        className="flex min-h-[74px] w-full flex-none cursor-pointer items-center gap-3 px-4 py-2 text-left"
      >
        <span
          aria-hidden="true"
          className="absolute top-2 left-1/2 h-1.5 w-12 -translate-x-1/2 rounded-full bg-border-soft"
        />
        <span className="min-w-0 flex-1 pt-2">
          <span
            ref={headingRef}
            tabIndex={-1}
            className="block truncate text-base font-extrabold text-ink outline-none"
          >
            {collapsed ? discoverLabel : sheetTitleFor(mode, lang)}
          </span>
          {collapsed ? (
            <span className="block text-sm text-muted">
              {lang === "vi"
                ? "Vuốt lên hoặc chạm để khám phá"
                : "Swipe up or tap to explore dishes"}
            </span>
          ) : null}
        </span>
        {collapsed ? (
          <ChevronUpIcon aria-hidden="true" className="size-5 flex-none" />
        ) : (
          <span className="flex flex-none items-center gap-1">
            {mode === "location" ? null : <ChevronDownIcon aria-hidden="true" className="size-5" />}
            <XIcon aria-hidden="true" className="size-5" />
          </span>
        )}
      </button>
      {/* Panes stay mounted across modes (state preservation); MobileHome
          hides the inactive pane, and collapsed mode hides both. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </section>
  );
}
