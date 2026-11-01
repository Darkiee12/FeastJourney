import { ClientOnly } from "@tanstack/react-router";
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { GlobeOverlayBridge } from "@/components/home/globe/geo-utils";
import { GlobeFallback } from "@/components/home/globe/globe-fallback";
import { usePrefersReducedMotion } from "@/components/home/globe/use-prefers-reduced-motion";
import type { Locale, Messages } from "@/shared/i18n";

const LazyGlobeScene = lazy(() =>
  import("@/components/home/globe/globe-scene").then((module) => ({ default: module.GlobeScene })),
);

type GlobeErrorState = {
  failed: boolean;
};

class GlobeErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  GlobeErrorState
> {
  override state: GlobeErrorState = { failed: false };

  static getDerivedStateFromError(): GlobeErrorState {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Slow-chunk safety net: after this long without resolving the WebGL chunk,
 * show the static planet instead of an empty slot. The scene below keeps
 * loading and swaps in when ready (automatic retry/upgrade).
 */
const CHUNK_LOAD_TIMEOUT_MS = 8000;

/**
 * Client-only branch of the four-stage reveal:
 * - Reduced motion: the static planet only, without ever downloading the
 *   WebGL chunk (Stage D).
 * - Otherwise: no duplicate static while the chunk loads (the single static
 *   owner is GlobeScene, Stage C); the 8s timeout static above for slow
 *   networks; the error-boundary static for chunk/WebGL failures (Stage D).
 * Runs inside ClientOnly so the first client render matches the server HTML.
 */
function GlobeContent({
  copy,
  lang,
  bridgeRef,
}: {
  copy: Messages;
  lang: Locale;
  bridgeRef: RefObject<GlobeOverlayBridge>;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [chunkTimedOut, setChunkTimedOut] = useState(false);
  const fallback = <GlobeFallback label={copy.globeStaticLabel} lang={lang} />;

  useEffect(() => {
    if (reducedMotion) {
      return () => undefined;
    }

    const timer = window.setTimeout(() => {
      setChunkTimedOut(true);
    }, CHUNK_LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [reducedMotion]);

  if (reducedMotion) {
    return fallback;
  }

  return (
    <GlobeErrorBoundary fallback={fallback}>
      <Suspense fallback={chunkTimedOut ? fallback : null}>
        <LazyGlobeScene copy={copy} lang={lang} bridgeRef={bridgeRef} />
      </Suspense>
    </GlobeErrorBoundary>
  );
}

/**
 * SSR-safe globe slot: an empty slot on the server, the static planet while
 * three.js loads, WebGL on the client. WebGL failures fall back to the same
 * static planet.
 */
export function GlobeCanvas({ copy, lang }: { copy: Messages; lang: Locale }) {
  const bridgeRef = useRef<GlobeOverlayBridge>({
    activeId: null,
    x: 0,
    y: 0,
    anchored: false,
    paused: false,
    node: null,
  });

  return (
    // data-globe-lift is the stable motion hook for the synchronized
    // globe-push: while the quiz drawer is open, styles.css lifts this whole
    // wrapper (Canvas, overlays, pins, static fallback together) with a
    // transform-only transition. Never animate inner scene parts from here;
    // the rAF loop, textures and camera stay untouched.
    <div className="hero-globe pointer-events-none absolute inset-0" data-globe-lift>
      <ClientOnly fallback={null}>
        <GlobeContent copy={copy} lang={lang} bridgeRef={bridgeRef} />
      </ClientOnly>
    </div>
  );
}
