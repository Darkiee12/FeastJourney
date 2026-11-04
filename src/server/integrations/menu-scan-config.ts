import { z } from "zod";

import { DEFAULT_MODEL_BASE_URL, serverEnv, type ServerEnv } from "@/server/env";

/**
 * Menu-scanner operator configuration. Every numeric knob is
 * operator-owned: a valid explicitly configured value flows through exactly
 * as set and defaults apply only when the variable is unset. There is
 * intentionally no upper bound on any knob — provider-side limits are the
 * provider's responsibility and surface as provider failures, never as
 * silent configuration rewrites. Lower bounds are intrinsic validity only:
 * timeouts/byte counts/counts must be positive (a zero/negative budget can
 * never succeed) and retries must be nonnegative. Invalid explicit values
 * fail loudly naming field + reason, without exposing values.
 */
const scannerConfigSchema = z.strictObject({
  apiKey: z.string().trim().min(1),
  // Operator-chosen model id (plain string, never validated against a
  // hardcoded allowlist): the provider is the authority on which model
  // ids exist. A wrong id fails loudly at the scanner boundary via the
  // provider's 4xx, not silently at startup.
  model: z.string().trim().min(1).max(120),
  endpoint: z.url().refine((value) => {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }),
  timeoutMs: z.coerce.number().int().min(1),
  retries: z.coerce.number().int().min(0),
  maxResponseBytes: z.coerce.number().int().min(1),
  maxImages: z.coerce.number().int().min(1),
  maxImageBytes: z.coerce.number().int().min(1),
  maxCompletionTokens: z.coerce.number().int().min(1),
});

export type MenuScanConfig = z.infer<typeof scannerConfigSchema>;

/** Disabled by default; invalid enabled configuration fails at the scanner boundary. */
export function resolveMenuScanConfig(env: ServerEnv): MenuScanConfig | null {
  const enabled = z.enum(["true", "false"]).safeParse(env.MENU_SCANNER_ENABLED ?? "false");

  if (!enabled.success) throw new Error("MENU_SCANNER_ENABLED must be true or false.");

  if (enabled.data === "false") return null;

  const parsed = scannerConfigSchema.safeParse({
    apiKey: env.MODEL_API_KEY,
    model: env.MENU_SCAN_MODEL ?? "muse-spark-1.3",
    endpoint: env.MODEL_BASE_URL ?? DEFAULT_MODEL_BASE_URL,
    timeoutMs: env.MENU_SCAN_TIMEOUT_MS ?? "20000",
    retries: env.MENU_SCAN_RETRIES ?? "1",
    maxResponseBytes: env.MENU_SCAN_MAX_RESPONSE_BYTES ?? "1048576",
    maxImages: env.MENU_SCAN_MAX_IMAGES ?? "6",
    maxImageBytes: env.MENU_SCAN_MAX_IMAGE_BYTES ?? "8388608",
    maxCompletionTokens: env.MENU_SCAN_MAX_COMPLETION_TOKENS ?? "12000",
  });

  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");

    throw new Error(
      `Menu scanner configuration is invalid${fields.length > 0 ? ` (${fields})` : ""}: check the named MENU_SCAN_* variable.`,
    );
  }

  return parsed.data;
}

export const menuScanConfig = (): MenuScanConfig | null => resolveMenuScanConfig(serverEnv());
