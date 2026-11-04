/**
 * Build-time MapLibre style URL contract.
 *
 * `VITE_MAP_STYLE_URL` is a public browser-visible vector-style URL. Vite
 * embeds `import.meta.env.VITE_MAP_STYLE_URL` into the client bundle at
 * build time, so the value must be resolved and validated BEFORE
 * `bun run build` (CI does this from the Actions repository variable, see
 * `.github/workflows/scripts/resolve-map-style-url.ts`). A runtime Swarm
 * value cannot fix a bundle built without it.
 *
 * Single source of truth for the validated safe default (CARTO Positron,
 * no key required, previously QA-tested). Docs, Compose, and workflow
 * files repeat the literal with a comment pointing here; they cannot
 * import it.
 */
export const DEFAULT_MAP_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

export interface ValidMapStyleUrl {
  readonly success: true;
  readonly url: string;
}

export interface InvalidMapStyleUrl {
  readonly success: false;
  readonly reason: string;
}

export type MapStyleUrlValidation = ValidMapStyleUrl | InvalidMapStyleUrl;

const MISSING_REASON =
  "VITE_MAP_STYLE_URL is not set. Set the GitHub Actions repository variable " +
  "VITE_MAP_STYLE_URL to a public https map style URL, or leave it unset to use " +
  "the validated CARTO Positron default.";

const EMPTY_REASON =
  "VITE_MAP_STYLE_URL is empty. Set the GitHub Actions repository variable " +
  "VITE_MAP_STYLE_URL to a public https map style URL, or clear it to use " +
  "the validated CARTO Positron default.";

const MALFORMED_REASON =
  "VITE_MAP_STYLE_URL is not a valid absolute URL. Set the GitHub Actions " +
  "repository variable VITE_MAP_STYLE_URL to a public https style JSON URL " +
  "(for example the CARTO Positron default), or clear it to use that default. " +
  "Rebuild the image for the change to take effect.";

const NON_HTTPS_REASON =
  "VITE_MAP_STYLE_URL must use https. Set the GitHub Actions repository " +
  "variable VITE_MAP_STYLE_URL to a public https style JSON URL, or clear it " +
  "to use the validated CARTO Positron default. Rebuild the image for the " +
  "change to take effect.";

/**
 * Strictly validate a candidate style URL. Rejects missing, empty,
 * malformed, and non-HTTPS values. Reasons name the variable and the fix
 * but never echo the value, so the validator stays safe to log even if a
 * secret was pasted into the variable by mistake.
 */
export function validateMapStyleUrl(value: string | undefined): MapStyleUrlValidation {
  if (value === undefined) {
    return { success: false, reason: MISSING_REASON };
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    return { success: false, reason: EMPTY_REASON };
  }

  let protocol: string;

  try {
    protocol = new URL(trimmed).protocol;
  } catch {
    return { success: false, reason: MALFORMED_REASON };
  }

  if (protocol !== "https:") {
    return { success: false, reason: NON_HTTPS_REASON };
  }

  return { success: true, url: trimmed };
}

/**
 * Resolve the build-time style URL: a set and valid override wins,
 * missing/blank falls back to the validated default, and malformed or
 * non-HTTPS overrides throw an actionable error naming the variable and
 * the fix. Deterministic: never silently map-less.
 */
export function resolveMapStyleUrl(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_MAP_STYLE_URL;
  }

  if (value.trim() === "") {
    return DEFAULT_MAP_STYLE_URL;
  }

  const validated = validateMapStyleUrl(value);

  if (!validated.success) {
    throw new Error(validated.reason);
  }

  return validated.url;
}
