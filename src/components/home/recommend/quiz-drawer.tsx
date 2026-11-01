import { useEffect, useState } from "react";

/** Tailwind `md` breakpoint gate: true only below 768px. */
const MAX_MD_QUERY = "(max-width: 767.98px)";

/**
 * Client-only `max-md` mount gate. Mobile and desktop homepage trees must
 * never mount together: shared radio `name` groups and control `id`s would
 * otherwise duplicate across the hidden tree.
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
  }, []);

  return isMaxMd;
}

/** Fallback sheet timing when the shared token cannot be resolved. */
export const DRAWER_SPRING_FALLBACK_MS = 450;

/** Parse a CSS duration (`450ms`, `0.45s`) into milliseconds. */
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
