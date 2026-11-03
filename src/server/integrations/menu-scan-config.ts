import { z } from "zod";

import { DEFAULT_MODEL_BASE_URL, serverEnv, type ServerEnv } from "@/server/env";

const scannerConfigSchema = z.strictObject({
  apiKey: z.string().trim().min(1),
  model: z.literal("muse-spark-1.3"),
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
  timeoutMs: z.coerce.number().int().min(1000).max(45000),
  retries: z.coerce.number().int().min(0).max(1),
  maxResponseBytes: z.coerce.number().int().min(1024).max(2097152),
  maxImages: z.coerce.number().int().min(1).max(6),
  maxImageBytes: z.coerce.number().int().min(1024).max(8388608),
  maxCompletionTokens: z.coerce.number().int().min(1024).max(24000),
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

  if (!parsed.success) throw new Error("Menu scanner configuration is invalid.");

  return parsed.data;
}

export const menuScanConfig = (): MenuScanConfig | null => resolveMenuScanConfig(serverEnv());
