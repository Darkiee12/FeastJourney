import { z } from "zod";

import {
  contributeScanSchema,
  createScanSchema,
  menuScanDocumentSchema,
  reviseScanSchema,
  scanIdSchema,
  scanReviewSchema,
} from "@/modules/restaurant-discovery/menu-scan.schema";
import { clientFailureSchema } from "@/shared/client-failure";

const scanAssetsSchema = z.array(
  z.object({ id: z.uuid(), page_number: z.number().int(), status: z.string() }),
);

/** Decode the same-origin HTTP boundary; private object keys are never accepted. */
export const scanViewSchema = z.object({
  scan: z.object({
    id: z.uuid(),
    status: z.string(),
    current_revision: z.number().int().nullable(),
    target_language: z.string(),
    venue_id: z.uuid().nullable(),
    venue_name: z.string().nullable(),
    expires_at: z.string(),
  }),
  assets: scanAssetsSchema,
  document: menuScanDocumentSchema.nullable(),
  revision: z
    .object({
      number: z.number().int(),
      origin: z.string(),
      model: z.string().nullable(),
    })
    .nullable(),
  contribution: z
    .object({ id: z.uuid(), status: z.string(), revision: z.number().int() })
    .nullable(),
});

export type ScanView = z.infer<typeof scanViewSchema>;

export const contributionQueueSchema = z.array(
  z.object({
    id: z.uuid(),
    session_id: z.uuid(),
    revision: z.number().int(),
    requested_venue_id: z.uuid().nullable(),
    venue_name: z.string().nullable(),
    consented_at: z.string(),
    status: z.string(),
  }),
);

export const contributionViewSchema = z.object({
  contribution: z.object({
    id: z.uuid(),
    session_id: z.uuid(),
    revision: z.number().int(),
    requested_venue_id: z.uuid().nullable(),
    status: z.string(),
    promoted_menu_id: z.uuid().nullable(),
    scan_status: z.string(),
    expires_at: z.string(),
    consent_terms: z.string(),
    consented_at: z.string(),
    reviewed_by: z.string().nullable().optional(),
    reviewed_at: z.string().nullable().optional(),
    review_notes: z.string().nullable().optional(),
  }),
  document: menuScanDocumentSchema,
  duplicates: z.array(
    z.object({ asset_id: z.uuid(), contribution_count: z.number().int().min(0) }),
  ),
  assets: scanAssetsSchema,
  menus: z.array(
    z.object({
      menu_id: z.uuid(),
      asset_id: z.uuid(),
      is_primary: z.boolean(),
    }),
  ),
});

export type ContributionView = z.infer<typeof contributionViewSchema>;

export class MenuScanClientError extends Error {
  readonly failure: z.infer<typeof clientFailureSchema> | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    retryable: boolean,
    retryAfterSeconds: number | null = null,
    failure?: z.infer<typeof clientFailureSchema>,
  ) {
    super(message);
    this.name = "MenuScanClientError";
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.failure = failure;
  }
}

const actionsSchema = z.discriminatedUnion("action", [
  createScanSchema.extend({ action: z.literal("create") }),
  scanIdSchema.extend({ action: z.literal("get") }),
  scanIdSchema.extend({ action: z.literal("extract") }),
  scanIdSchema.extend({ action: z.literal("delete") }),
  scanIdSchema.extend({ action: z.literal("claim") }),
  reviseScanSchema.extend({ action: z.literal("revise") }),
  contributeScanSchema.extend({ action: z.literal("contribute") }),
  z.strictObject({ action: z.literal("listContributions") }),
  z.strictObject({ action: z.literal("getContribution"), contributionId: z.uuid() }),
  scanReviewSchema.extend({ action: z.literal("review") }),
]);

async function decodeResponse<A>(response: Response, schema: z.ZodType<A>): Promise<A> {
  const raw: unknown = await response.json();

  if (!response.ok) {
    const failure = clientFailureSchema.safeParse(raw);

    if (failure.success)
      throw new MenuScanClientError(
        failure.data.message,
        failure.data.retryable,
        failure.data.retryAfterSeconds,
        failure.data,
      );
    throw new MenuScanClientError(
      "This request could not be completed. Please retry.",
      response.status >= 500,
    );
  }

  const parsed = schema.safeParse(raw);

  if (!parsed.success)
    throw new MenuScanClientError(
      "The server returned an unreadable menu response. Please reload.",
      true,
    );

  return parsed.data;
}

/** One transport boundary owns timeouts, cancellation, input validation and safe failures. */
async function requestScan<A>(
  input: z.infer<typeof actionsSchema>,
  schema: z.ZodType<A>,
  signal?: AbortSignal,
): Promise<A> {
  const body = actionsSchema.parse(input);
  const signals = [AbortSignal.timeout(body.action === "extract" ? 65000 : 30000)];

  if (signal !== undefined) signals.push(signal);

  const response = await fetch("/api/menu-scans", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any(signals),
  });

  return decodeResponse(response, schema);
}

/**
 * Coalesces concurrent Analyze taps for the same scan into one extraction
 * request. Sharers receive the identical outcome, including typed
 * MenuScanClientError retryable/retryAfterSeconds failures, so a duplicate
 * tap never fires a duplicate scan and never masks retry guidance. The
 * originating signal governs the shared fetch; the entry clears on settle.
 */
const inFlightExtracts = new Map<string, Promise<ScanView>>();

function dedupedExtract(scanId: string, signal?: AbortSignal): Promise<ScanView> {
  const running = inFlightExtracts.get(scanId);

  if (running !== undefined) return running;

  const pending = requestScan({ action: "extract", scanId }, scanViewSchema, signal).finally(() => {
    if (inFlightExtracts.get(scanId) === pending) inFlightExtracts.delete(scanId);
  });

  inFlightExtracts.set(scanId, pending);

  return pending;
}

export const menuScanClient = {
  create: (input: z.infer<typeof createScanSchema>, signal?: AbortSignal) =>
    requestScan(
      { action: "create", ...input },
      z.object({ id: z.uuid(), expires_at: z.string() }),
      signal,
    ),
  get: (scanId: string, signal?: AbortSignal) =>
    requestScan({ action: "get", scanId }, scanViewSchema, signal),
  extract: (scanId: string, signal?: AbortSignal) => dedupedExtract(scanId, signal),
  revise: (input: z.infer<typeof reviseScanSchema>, signal?: AbortSignal) =>
    requestScan({ action: "revise", ...input }, scanViewSchema, signal),
  contribute: (input: z.infer<typeof contributeScanSchema>, signal?: AbortSignal) =>
    requestScan(
      { action: "contribute", ...input },
      z.object({ id: z.uuid(), status: z.string() }),
      signal,
    ),
  remove: (scanId: string, signal?: AbortSignal) =>
    requestScan({ action: "delete", scanId }, z.object({ deleted: z.literal(true) }), signal),
  claim: (scanId: string, signal?: AbortSignal) =>
    requestScan({ action: "claim", scanId }, scanViewSchema, signal),
  queue: (signal?: AbortSignal) =>
    requestScan({ action: "listContributions" }, contributionQueueSchema, signal),
  contribution: (contributionId: string, signal?: AbortSignal) =>
    requestScan({ action: "getContribution", contributionId }, contributionViewSchema, signal),
  review: (input: z.infer<typeof scanReviewSchema>, signal?: AbortSignal) =>
    requestScan(
      { action: "review", ...input },
      z.object({ id: z.uuid(), status: z.string(), promoted_menu_id: z.uuid().nullable() }),
      signal,
    ),
  attach: async (scanId: string, pageNumber: number, file: File, signal?: AbortSignal) => {
    const body = new FormData();
    body.set("action", "attach");
    body.set("scanId", z.uuid().parse(scanId));
    body.set("pageNumber", z.number().int().min(1).max(6).parse(pageNumber).toString());
    body.set("file", file);
    const signals = [AbortSignal.timeout(30000)];

    if (signal !== undefined) signals.push(signal);

    const response = await fetch("/api/menu-scans", {
      method: "POST",
      credentials: "same-origin",
      body,
      signal: AbortSignal.any(signals),
    });

    return decodeResponse(response, z.object({ assetId: z.uuid(), pageNumber: z.number().int() }));
  },
};

/** Client limits provide immediate feedback; the server verifies actual image bytes independently. */
export function validateMenuFiles(files: ReadonlyArray<File>): string | null {
  if (files.length > 6) return "Choose at most six menu photographs.";
  let totalBytes = 0;

  for (const file of files) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      return "Choose JPEG, PNG or WebP photographs.";

    if (file.size === 0 || file.size > 8 * 1024 * 1024)
      return "Each photograph must be between 1 byte and 8 MiB.";
    totalBytes += file.size;
  }

  if (totalBytes > 24 * 1024 * 1024)
    return "The photographs together must be no larger than 24 MiB.";

  return null;
}
