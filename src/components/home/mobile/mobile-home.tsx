import { MapPinned } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DiscoverySection } from "@/components/home/discovery-section";
import { SURPRISE_DISH_EVENT } from "@/components/home/globe/food-locations";
import { GlobeCanvas } from "@/components/home/globe/globe-canvas";
import { MobileHomeProvider, useMobileHome } from "@/components/home/mobile/mobile-home-context";
import {
  computeMobileGlobeGeometry,
  mobileSheetHeightPx,
} from "@/components/home/mobile/mobile-home-state";
import { MobileSheet } from "@/components/home/mobile/mobile-sheet";
import { RecommendSection } from "@/components/home/recommend-section";
import type { Locale, Messages } from "@/shared/i18n";

function UtensilsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="h-5 w-5 flex-none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 2v20" />
      <path d="M4 2v7a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2V2" />
      <path d="M17 2c-2 0-3 2.5-3 6 0 2.5 1 4 3 4v10" />
      <path d="M17 2v20" />
    </svg>
  );
}

function MobileHomeInner({ copy, lang }: { copy: Messages; lang: Locale }) {
  const mobile = useMobileHome();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 390, height: 844 });
  const mode = mobile.state.mode;

  // Centralized scroll ownership: the fixed stage owns layout, the sheet
  // owns its internal scroll. Single cleanup restores document scrolling.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;

    if (stage === null) return undefined;

    const update = (): void => {
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const applyHash = (): void => {
      if (window.location.hash === "#recommend") mobile.openQuiz();

      if (window.location.hash === "#discover") mobile.openDiscovery();
    };

    applyHash();
    window.addEventListener("hashchange", applyHash);

    return () => window.removeEventListener("hashchange", applyHash);
    // Mount/hash only: actions are stable dispatch wrappers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sheetHeightPx = mobileSheetHeightPx(mode, stageSize.height);

  const geometry = computeMobileGlobeGeometry({
    viewportWidth: stageSize.width,
    viewportHeight: stageSize.height,
    sheetHeightPx,
  });

  const discoveryActive = mode === "discovery" || mode === "location";
  const quizActive = mode === "quiz" || mode === "results";

  return (
    <div
      ref={stageRef}
      data-mobile-home
      className="home hero relative isolate flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div aria-hidden="true" className="hero-stars" />
      <div
        aria-hidden="true"
        data-globe-lift
        data-globe-lift-px={geometry.globeLiftPx}
        className="absolute inset-0 motion-safe:transition-transform motion-safe:duration-[450ms] motion-safe:ease-[cubic-bezier(0.32,0.72,0,1)]"
        style={{ transform: `translate3d(0, ${-geometry.globeLiftPx}px, 0)` }}
      >
        <GlobeCanvas copy={copy} lang={lang} />
      </div>

      <div className="relative z-[2] mx-auto w-full max-w-3xl px-5 pt-[clamp(1.5rem,6vh,3rem)] text-center">
        <h1 className="font-display mb-4 text-[clamp(2.6rem,11vw,4rem)] leading-[1.02] tracking-[0.015em] text-balance text-white uppercase text-shadow-hero">
          {copy.heroHeading}
        </h1>
        <p className="mb-5 text-[clamp(1rem,4.5vw,1.25rem)] font-semibold text-balance text-white">
          {copy.heroSubExtra}
        </p>
        <div className="mx-auto flex w-full max-w-xs flex-col items-stretch gap-3">
          <button
            type="button"
            onClick={mobile.openQuiz}
            className="inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-full bg-food-orange-strong px-6 text-base font-bold text-white shadow-[0_10px_28px_rgba(194,65,12,0.45)] transition hover:bg-food-orange-dark"
          >
            <UtensilsIcon />
            {copy.ctaRecommend}
          </button>
          <button
            type="button"
            onClick={mobile.openDiscovery}
            className="inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-full border-2 border-mango bg-transparent px-6 text-base font-bold text-mango transition hover:bg-mango/10 [text-shadow:0_1px_2px_rgb(0_0_0/0.9),0_0_14px_rgb(0_0_0/0.65)]"
          >
            <MapPinned aria-hidden="true" className="h-5 w-5 flex-none" />
            {copy.ctaExplore}
          </button>
        </div>
      </div>

      {mode === "collapsed" ? (
        <button
          id="surprise-dish-button"
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent(SURPRISE_DISH_EVENT))}
          className="absolute right-4 z-[3] inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-white/40 bg-space-deep/80 px-4 text-sm font-bold text-white shadow-[0_8px_24px_rgba(3,10,30,0.45)] backdrop-blur transition hover:border-white/70"
          style={{ bottom: `calc(${sheetHeightPx}px + 0.75rem)` }}
        >
          {copy.previewShowAnother}
        </button>
      ) : null}

      <MobileSheet heightPx={sheetHeightPx} lang={lang} discoverLabel={copy.navDiscover}>
        <div
          className={
            discoveryActive
              ? `flex min-h-0 flex-1 flex-col ${mode === "location" ? "overflow-hidden" : "overflow-y-auto overscroll-contain"}`
              : "hidden"
          }
          aria-hidden={!discoveryActive}
        >
          <DiscoverySection copy={copy} lang={lang} variant="sheet" />
        </div>
        <div
          className={quizActive ? "flex min-h-0 flex-1 flex-col" : "hidden"}
          aria-hidden={!quizActive}
        >
          <RecommendSection />
        </div>
      </MobileSheet>
    </div>
  );
}

export function MobileHome({ copy, lang }: { copy: Messages; lang: Locale }) {
  return (
    <MobileHomeProvider>
      <MobileHomeInner copy={copy} lang={lang} />
    </MobileHomeProvider>
  );
}
