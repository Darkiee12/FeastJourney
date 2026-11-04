import { Data } from "effect";
import { z } from "zod";

import {
  contributeScanSchema,
  createScanSchema,
  menuCityIdSchema,
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
  /** Frozen transport-layer kind when this error came from decodeScanResponse. */
  readonly transportKind: ScanTransportKind | undefined;

  constructor(
    message: string,
    retryable: boolean,
    retryAfterSeconds: number | null = null,
    failure?: z.infer<typeof clientFailureSchema>,
    transportKind?: ScanTransportKind,
  ) {
    super(message);
    this.name = "MenuScanClientError";
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.failure = failure;
    this.transportKind = transportKind;
  }
}

/**
 * Transport failure union (§9). Tag literals are exact and owned by Lane S
 * rendering; this boundary only classifies. Fresh instances are built per
 * throw and never shared, so no freezing is needed. The union uses Effect
 * Data.TaggedEnum with _tag (never a hand-written kind union), so dispatch
 * goes through $match with complete type-level checking.
 */
export const scanTransportKinds = [
  "transport-unavailable",
  "unexpected-response",
  "unavailable",
  "too-slow",
  "rate-limited",
  "unauthorized",
  "not-found",
  "invalid-input",
  "empty",
] as const;

export type ScanTransportKind = (typeof scanTransportKinds)[number];

export const SCAN_TRANSPORT_KINDS: readonly ScanTransportKind[] = Object.freeze([
  ...scanTransportKinds,
]);

export type ScanTransportFailure = {
  readonly [K in ScanTransportKind]: {
    readonly _tag: K;
    readonly message: string;
    readonly retryable: boolean;
    readonly retryAfterSeconds: number | null;
    readonly status: number | null;
  };
}[ScanTransportKind];

const ScanTransport = Data.taggedEnum<ScanTransportFailure>();

const transportError = (failure: ScanTransportFailure): MenuScanClientError =>
  new MenuScanClientError(
    failure.message,
    failure.retryable,
    failure.retryAfterSeconds,
    undefined,
    failure._tag,
  );

/** Upper bound before parsing; bodies are never logged. */
const SCAN_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Bounded body reader mirroring the server's readBoundedBody: enforces the
 * byte cap while streaming (never materializes an unbounded string), cancels
 * the stream on overflow, and always releases the reader.
 */
async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (response.body === null) return { text: "", truncated: false };

  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let byteLength = 0;
  let truncated = false;

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- A stream reader advances one chunk at a time.
      const chunk = await reader.read();

      if (chunk.done) break;

      byteLength += chunk.value.byteLength;

      if (byteLength > maxBytes) {
        truncated = true;
        // oxlint-disable-next-line no-await-in-loop -- Single cancellation on the overflow path only.
        await reader.cancel().catch(() => undefined);
        break;
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder().decode(merged), truncated };
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(3600, Math.max(0, Math.ceil(seconds)));

  const date = Date.parse(value);

  if (!Number.isFinite(date)) return null;

  return Math.min(3600, Math.max(0, Math.ceil((date - Date.now()) / 1000)));
}

function classifyErrorStatus(
  status: number,
  retryAfterSeconds: number | null,
): ScanTransportFailure {
  if (status === 429)
    return ScanTransport["rate-limited"]({
      message: "Too many requests. Please wait before retrying.",
      retryable: true,
      retryAfterSeconds,
      status,
    });

  if (status === 401 || status === 403)
    return ScanTransport["unauthorized"]({
      message: "Your session expired. Sign in again, then continue.",
      retryable: false,
      retryAfterSeconds,
      status,
    });

  if (status === 404)
    return ScanTransport["not-found"]({
      message: "This private scan is unavailable or has expired.",
      retryable: false,
      retryAfterSeconds,
      status,
    });

  if (status === 408)
    return ScanTransport["too-slow"]({
      message: "The request took too long.",
      retryable: true,
      retryAfterSeconds,
      status,
    });

  if (status === 400 || status === 422)
    return ScanTransport["invalid-input"]({
      message: "Check the highlighted fields and photo limits, then try again.",
      retryable: false,
      retryAfterSeconds,
      status,
    });

  if (status === 502 || status === 503 || status === 504 || (status >= 500 && status <= 599))
    return ScanTransport["unavailable"]({
      message: "Menu reading is temporarily unavailable.",
      retryable: true,
      retryAfterSeconds,
      status,
    });

  return ScanTransport["unexpected-response"]({
    message: "The server returned an unexpected response. Please try again.",
    retryable: status >= 500,
    retryAfterSeconds,
    status,
  });
}

/**
 * The single bounded transport decoder for the scanner. Handles valid JSON,
 * structured API errors, HTML error pages, wrong content types, empty and
 * truncated bodies, malformed JSON, valid-JSON/bad-schema, and status-driven
 * auth/rate-limit/gateway failures. Raw SyntaxError and HTML never surface;
 * response bodies are bounded and never logged.
 */
export async function decodeScanResponse<A>(response: Response, schema: z.ZodType<A>): Promise<A> {
  const status = response.status;
  const contentType = response.headers.get("content-type") ?? "";
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
  const declaredLength = response.headers.get("content-length");

  if (declaredLength !== null && Number(declaredLength) > SCAN_RESPONSE_MAX_BYTES) {
    throw transportError(
      ScanTransport["unexpected-response"]({
        message: "The server returned an unexpected response. Please try again.",
        retryable: true,
        retryAfterSeconds,
        status,
      }),
    );
  }

  let text: string;

  try {
    const body = await readBoundedText(response, SCAN_RESPONSE_MAX_BYTES);

    if (body.truncated) {
      throw transportError(
        ScanTransport["unexpected-response"]({
          message: "The server returned an unexpected response. Please try again.",
          retryable: true,
          retryAfterSeconds,
          status,
        }),
      );
    }

    text = body.text;
  } catch (error) {
    if (error instanceof MenuScanClientError) throw error;
    throw transportError(
      ScanTransport["transport-unavailable"]({
        message: "FeastJourney couldn't reach the menu service. Your photos are still available.",
        retryable: true,
        retryAfterSeconds,
        status,
      }),
    );
  }

  if (text.trim().length === 0) {
    throw transportError(
      ScanTransport["empty"]({
        message: "The server returned an empty response. Please try again.",
        retryable: true,
        retryAfterSeconds,
        status,
      }),
    );
  }

  // Proxy HTML error pages, login redirects, and explicit wrong content
  // types are a transport problem, never invalid menu-photo input. A missing
  // content-type still decodes as JSON (legacy wire payloads and stripped
  // headers); the HTML sniff below still rejects error pages in that case.
  if ((contentType !== "" && !contentType.includes("application/json")) || /^\s*</.test(text)) {
    throw transportError(
      ScanTransport["unexpected-response"]({
        message: "The server returned an unexpected response. Please try again.",
        retryable: true,
        retryAfterSeconds,
        status,
      }),
    );
  }

  let raw: unknown;

  try {
    // SAFETY: JSON.parse returns any; the value stays unknown until the
    // clientFailureSchema/schema safeParse below either validates or rejects it.
    raw = JSON.parse(text) as unknown;
  } catch {
    throw transportError(
      ScanTransport["unexpected-response"]({
        message: "The server returned an unreadable response. Please try again.",
        retryable: true,
        retryAfterSeconds,
        status,
      }),
    );
  }

  if (!response.ok) {
    const failure = clientFailureSchema.safeParse(raw);

    if (failure.success) {
      const classified = classifyErrorStatus(status, failure.data.retryAfterSeconds);
      throw new MenuScanClientError(
        failure.data.message,
        classified.retryable,
        classified.retryAfterSeconds,
        failure.data,
      );
    }

    throw transportError(classifyErrorStatus(status, retryAfterSeconds));
  }

  const parsed = schema.safeParse(raw);

  if (!parsed.success)
    throw transportError(
      ScanTransport["unexpected-response"]({
        message: "The server returned an unreadable menu response. Please reload.",
        retryable: true,
        retryAfterSeconds,
        status,
      }),
    );

  return parsed.data;
}

/**
 * Shared fetch guard: network failures, request timeouts, and caller
 * cancellation are classified once. A fired request timeout becomes
 * too-slow; an explicit caller abort propagates untouched so cancellation
 * semantics survive; any other fetch rejection is transport-unavailable.
 */
async function fetchScan(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = [timeoutSignal];

  if (signal !== undefined) signals.push(signal);

  try {
    return await fetch(input, { ...init, signal: AbortSignal.any(signals) });
  } catch (error) {
    if (signal?.aborted === true && !timeoutSignal.aborted) throw error;

    if (timeoutSignal.aborted)
      throw transportError(
        ScanTransport["too-slow"]({
          message: "The request took too long.",
          retryable: true,
          retryAfterSeconds: null,
          status: null,
        }),
      );

    throw transportError(
      ScanTransport["transport-unavailable"]({
        message: "FeastJourney couldn't reach the menu service. Your photos are still available.",
        retryable: true,
        retryAfterSeconds: null,
        status: null,
      }),
    );
  }
}

const actionsSchema = z.discriminatedUnion("action", [
  createScanSchema.extend({ action: z.literal("create") }),
  scanIdSchema.extend({ action: z.literal("get") }),
  scanIdSchema.extend({
    action: z.literal("extract"),
    menuCityId: menuCityIdSchema.optional(),
  }),
  scanIdSchema.extend({ action: z.literal("delete") }),
  scanIdSchema.extend({ action: z.literal("claim") }),
  reviseScanSchema.extend({ action: z.literal("revise") }),
  contributeScanSchema.extend({ action: z.literal("contribute") }),
  z.strictObject({ action: z.literal("listContributions") }),
  z.strictObject({ action: z.literal("getContribution"), contributionId: z.uuid() }),
  scanReviewSchema.extend({ action: z.literal("review") }),
]);

/** One transport boundary owns timeouts, cancellation, input validation and safe failures. */
async function requestScan<A>(
  input: z.infer<typeof actionsSchema>,
  schema: z.ZodType<A>,
  signal?: AbortSignal,
): Promise<A> {
  const body = actionsSchema.parse(input);

  const response = await fetchScan(
    "/api/menu-scans",
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    body.action === "extract" ? 65000 : 30000,
    signal,
  );

  return decodeScanResponse(response, schema);
}

/**
 * Coalesces concurrent Analyze taps for the same scan into one extraction
 * request. Sharers receive the identical outcome, including typed
 * MenuScanClientError retryable/retryAfterSeconds failures, so a duplicate
 * tap never fires a duplicate scan and never masks retry guidance. The
 * originating signal governs the shared fetch; the entry clears on settle.
 */
const inFlightExtracts = new Map<string, Promise<ScanView>>();

function dedupedExtract(
  scanId: string,
  signal?: AbortSignal,
  menuCityId?: string,
): Promise<ScanView> {
  // The visitor's city selection rides the dedupe key: re-analyzing the same
  // scan under a different city is a different request, never a shared one.
  const key = `${scanId}:${menuCityId ?? ""}`;
  const running = inFlightExtracts.get(key);

  if (running !== undefined) return running;

  const pending = requestScan(
    { action: "extract", scanId, menuCityId },
    scanViewSchema,
    signal,
  ).finally(() => {
    if (inFlightExtracts.get(key) === pending) inFlightExtracts.delete(key);
  });

  inFlightExtracts.set(key, pending);

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
  /**
   * Analyze the uploaded photographs. The visitor-selected menu city id is
   * already validated client-side against menuCityIdSchema (curated preset,
   * `geo:<name>`, or `place:<decimalId>` registry identity) and threads
   * through unchanged; the server re-validates at its boundary and resolves
   * `place:` ids against the place catalog (unknown ids degrade to null,
   * never geography).
   */
  extract: (scanId: string, signal?: AbortSignal, menuCityId?: string) =>
    dedupedExtract(scanId, signal, menuCityId),
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

    const response = await fetchScan(
      "/api/menu-scans",
      { method: "POST", credentials: "same-origin", body },
      30000,
      signal,
    );

    return decodeScanResponse(
      response,
      z.object({ assetId: z.uuid(), pageNumber: z.number().int() }),
    );
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
