import { Link } from "@tanstack/react-router";
import { MapPinned } from "lucide-react";

import { SURPRISE_DISH_EVENT } from "@/components/home/globe/food-locations";
import { GlobeCanvas } from "@/components/home/globe/globe-canvas";
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

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5 flex-none">
      <path
        d="M12 3l1.9 5.4L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.6z"
        fill="currentColor"
      />
      <path d="M19 15.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" fill="currentColor" />
    </svg>
  );
}

function surprise() {
  // Contextual globe control only: spotlight another featured dish through
  // the globe scheduler. Never navigate or scroll as a fallback — when the
  // WebGL globe is absent the static preview owns its own rotation.
  window.dispatchEvent(new CustomEvent(SURPRISE_DISH_EVENT));
}

export function HomeHero({ copy, lang }: { copy: Messages; lang: Locale }) {
  return (
    <section
      aria-label={copy.globeLabel}
      className="hero relative isolate flex min-h-[max(36rem,calc(100dvh-4rem))] flex-col overflow-hidden"
    >
      <div aria-hidden="true" className="hero-stars" />

      <div
        data-hero-copy
        className="relative z-[2] mx-auto w-full max-w-3xl px-5 pt-[clamp(2rem,7vh,4rem)] text-center"
      >
        <h1 className="font-display mb-4 text-[clamp(2.9rem,9vw,5.25rem)] leading-[1.02] tracking-[0.015em] text-balance text-white uppercase text-shadow-hero">
          {copy.heroHeading}
        </h1>

        <p className="mb-6 text-[clamp(1.1rem,2.6vw,1.35rem)] font-semibold text-balance text-white">
          {copy.heroSubExtra}
        </p>

        <div className="mx-auto flex w-full max-w-xs flex-col items-stretch gap-3 sm:max-w-none sm:flex-row sm:items-center sm:justify-center">
          {/* Desktop keeps the scroll-to-#recommend link; phones open the
              quiz drawer sliding over the globe instead of scrolling away. */}
          <Link
            to="/"
            search={{ lang }}
            hash="recommend"
            resetScroll={false}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-food-orange-strong px-6 text-base font-bold text-white no-underline shadow-[0_10px_28px_rgba(194,65,12,0.45)] transition hover:-translate-y-px hover:bg-food-orange-dark active:translate-y-0 sm:min-h-13 sm:px-8 sm:text-lg"
          >
            <UtensilsIcon />
            {copy.ctaRecommend}
          </Link>

          <Link
            to="/"
            search={{ lang }}
            hash="discover"
            resetScroll={false}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border-2 border-mango bg-transparent px-6 text-base font-bold text-mango transition hover:bg-mango/10 [text-shadow:0_1px_2px_rgb(0_0_0/0.9),0_0_14px_rgb(0_0_0/0.65)] sm:min-h-13 sm:px-8 sm:text-lg"
          >
            <MapPinned aria-hidden="true" className="h-5 w-5 flex-none" />
            {copy.ctaExplore}
          </Link>
        </div>
      </div>

      {/* Contextual globe control: a small floating action at a safe edge of
          the globe — deliberately quieter than the hero CTAs. It spotlights
          another featured dish without scrolling or opening the wizard. */}
      <button
        id="surprise-dish-button"
        type="button"
        onClick={surprise}
        className="absolute right-4 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-[3] inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-white/40 bg-space-deep/80 px-4 text-sm font-bold text-white shadow-[0_8px_24px_rgba(3,10,30,0.45)] backdrop-blur transition hover:border-white/70 hover:bg-space-deep sm:right-8"
      >
        <SparkleIcon />
        {copy.previewShowAnother}
      </button>

      <GlobeCanvas copy={copy} lang={lang} />
    </section>
  );
}
