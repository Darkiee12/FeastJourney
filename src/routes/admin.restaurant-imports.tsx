import { useMutation } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, Link, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import { z } from "zod";

import {
  AdminCard,
  AdminDialog,
  AdminEmptyState,
  AdminErrorState,
  AdminGhostButton,
  AdminPageHeading,
  AdminPrimaryButton,
  AdminSecondaryButton,
  AdminSection,
  AdminSelect,
  AdminTable,
  ImportStatusBadge,
} from "@/components/admin/ui";
import { importJobStatusSchema } from "@/modules/food-discovery/admin.schema";
import { authorizeFn } from "@/modules/user/admin.functions";
import { getSessionFn } from "@/modules/user/session.functions";
import { formatAdminDate } from "@/shared/format";
import { messagesFor } from "@/shared/i18n";

/**
 * Restaurant bulk-import wizard (Feast Lab). Route FILE only: registering
 * the path in `routeTree.gen.ts` is coordinator-owned and noted in the
 * phase report; this file must compile unchanged once registered.
 *
 * Transport only: every mutation validates input with Zod, resolves the
 * server-trusted actor, and delegates to the restaurant-discovery bulk
 * operations (dynamic server-only import, never a browser bundle import).
 * The wizard never auto-merges fuzzy duplicates and never presents source
 * confidence as a customer rating.
 */

const rootRoute = getRouteApi("__root__");

const TEMPLATE_FIELDS = [
  "businessName",
  "name",
  "address",
  "area",
  "countryCode",
  "longitude",
  "latitude",
  "cuisineSlugs",
  "sourceRecordId",
  "observedAt",
  "sourceUrl",
] as const;

const templateFieldSchema = z.enum([
  "businessName",
  "name",
  "address",
  "area",
  "countryCode",
  "longitude",
  "latitude",
  "cuisineSlugs",
  "sourceRecordId",
  "observedAt",
  "sourceUrl",
  "ignore",
]);

type TemplateField = z.infer<typeof templateFieldSchema>;

const adminActor = async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server");
  const { requireAuthenticatedActor } = await import("@/server/auth/session");
  const { Actor } = await import("@/server/auth/actor");
  const { withActor } = await import("@/server/auth/current-actor");
  const { runClientOperation } = await import("@/server/http/run-client-operation");
  const session = await runClientOperation(requireAuthenticatedActor(getRequestHeaders()), "admin");

  return { actor: Actor.Member({ userId: session.userId }), withActor, runClientOperation };
};

const loadBulkImport = () => import("@/modules/restaurant-discovery/server/operations/bulk-import");

const stageValidator = z
  .object({
    sourceName: z.string().trim().min(1).max(200),
    format: z.enum(["json", "csv"]),
    sourceVersion: z.string().max(200).nullable(),
    release: z.string().max(200).nullable(),
    license: z.string().max(200).nullable(),
    attribution: z.string().max(2000).nullable(),
    jobSourceUrl: z.string().max(2000).nullable(),
    jsonText: z.string().max(2_000_000).optional(),
    csvText: z.string().max(2_000_000).optional(),
    mapping: z
      .array(z.object({ column: z.string().min(1).max(200), field: templateFieldSchema }))
      .max(20)
      .optional(),
  })
  .superRefine((data, context) => {
    if (data.format === "json" && (data.jsonText === undefined || data.jsonText.trim() === "")) {
      context.addIssue({ code: "custom", message: "Paste JSON rows to stage" });
    }

    if (data.format === "csv" && (data.csvText === undefined || data.csvText.trim() === "")) {
      context.addIssue({ code: "custom", message: "Paste CSV text to stage" });
    }
  });

const detailValidator = z.object({
  jobId: z.uuid(),
  limit: z.number().int().min(1).max(500).default(200),
  offset: z.number().int().min(0).default(0),
});

const resolveValidator = z.object({
  jobId: z.uuid(),
  recordId: z.uuid(),
  decision: z.enum(["approved", "skipped"]),
  duplicateOf: z.uuid().optional(),
});

const applyValidator = z.object({
  jobId: z.uuid(),
  licenseAck: z.boolean(),
  reviewAck: z.boolean(),
  acknowledgedRefs: z.array(z.string().min(1).max(300)).max(1000).default([]),
});

export const listRestaurantImportsFn = createServerFn({ method: "GET" })
  .validator(
    z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }),
  )
  .handler(async ({ data }) => {
    const { actor, withActor, runClientOperation } = await adminActor();
    const bulk = await loadBulkImport();

    return runClientOperation(withActor(actor, bulk.listRestaurantImportJobs(data)), null);
  });

export const stageRestaurantImportFn = createServerFn({ method: "POST" })
  .validator(stageValidator)
  .handler(async ({ data }) => {
    const { actor, withActor, runClientOperation } = await adminActor();
    const bulk = await loadBulkImport();

    let jsonRecords: ReadonlyArray<unknown> | undefined;

    if (data.format === "json" && data.jsonText !== undefined) {
      const parsed: unknown = JSON.parse(data.jsonText);

      if (!Array.isArray(parsed)) throw new Error("JSON payload must be an array of rows");
      jsonRecords = parsed;
    }

    return runClientOperation(
      withActor(
        actor,
        bulk.stageRestaurantImport({
          sourceName: data.sourceName,
          format: data.format,
          sourceVersion: data.sourceVersion,
          release: data.release,
          license: data.license,
          attribution: data.attribution,
          jobSourceUrl: data.jobSourceUrl,
          jsonRecords,
          csvText: data.csvText,
          mapping: data.mapping,
        }),
      ),
      null,
    );
  });

export const validateRestaurantImportFn = createServerFn({ method: "POST" })
  .validator(z.object({ jobId: z.uuid() }))
  .handler(async ({ data }) => {
    const { actor, withActor, runClientOperation } = await adminActor();
    const bulk = await loadBulkImport();

    return runClientOperation(withActor(actor, bulk.validateRestaurantImport(data)), null);
  });

export const restaurantImportDetailFn = createServerFn({ method: "GET" })
  .validator(detailValidator)
  .handler(async ({ data }) => {
    const { actor, withActor, runClientOperation } = await adminActor();
    const bulk = await loadBulkImport();

    return runClientOperation(withActor(actor, bulk.getRestaurantImportJob(data)), null);
  });

export const resolveRestaurantImportFn = createServerFn({ method: "POST" })
  .validator(resolveValidator)
  .handler(async ({ data }) => {
    const { actor, withActor, runClientOperation } = await adminActor();
    const bulk = await loadBulkImport();

    return runClientOperation(withActor(actor, bulk.resolveImportRecord(data)), null);
  });

export const applyRestaurantImportFn = createServerFn({ method: "POST" })
  .validator(applyValidator)
  .handler(async ({ data }) => {
    const { actor, withActor, runClientOperation } = await adminActor();
    const bulk = await loadBulkImport();

    return runClientOperation(withActor(actor, bulk.applyRestaurantImport(data)), null);
  });

type WizardStep = "source" | "acquire" | "review" | "results";

export const Route = createFileRoute("/admin/restaurant-imports")({
  beforeLoad: async ({ search }) => {
    const session = await getSessionFn();

    if (session.user === null) {
      throw redirect({
        to: "/sign-in",
        search: { returnTo: "/admin/restaurant-imports", lang: search.lang },
      });
    }

    const { allowed } = await authorizeFn({
      data: { checks: [{ resource: "restaurant", actions: ["manage"] }] },
    });

    if (!allowed) {
      throw redirect({ to: "/", search: { lang: search.lang } });
    }

    return {};
  },
  loader: () => listRestaurantImportsFn({ data: { limit: 20, offset: 0 } }),
  component: RestaurantImports,
});

/**
 * Transport-boundary schemas: server-function results cross the network, so
 * the wizard parses them here instead of asserting their shape. This mirrors
 * the food import studio's `*Schema.parse(Route.useLoaderData())` pattern.
 */
const importJobViewSchema = z.object({
  id: z.string(),
  source_name: z.string(),
  source_version: z.string().nullable(),
  release: z.string().nullable(),
  license: z.string().nullable(),
  attribution: z.string().nullable(),
  format: z.string(),
  status: importJobStatusSchema,
  total_records: z.number(),
  valid_records: z.number(),
  invalid_records: z.number(),
  applied_count: z.number(),
  license_ack: z.boolean(),
  review_ack: z.boolean(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

const importRecordViewSchema = z.object({
  id: z.string(),
  external_ref: z.string(),
  status: z.string(),
  errors: z.string().nullable(),
  warnings: z.string().nullable(),
  venue_id: z.string().nullable(),
  duplicate_of: z.string().nullable(),
  dedup_key: z.string().nullable(),
  payload: z.string(),
});

const importDetailSchema = z.object({
  job: importJobViewSchema,
  records: z.array(importRecordViewSchema),
  counts: z.object({
    staged: z.number(),
    valid: z.number(),
    invalid: z.number(),
    needsReview: z.number(),
    approved: z.number(),
    applied: z.number(),
    skippedDuplicate: z.number(),
    failed: z.number(),
  }),
});

type Detail = z.infer<typeof importDetailSchema>;

const stageReportSchema = z.object({ jobId: z.string(), status: z.string() });

const applyReportSchema = z.object({
  status: z.string(),
  applied: z.number(),
  failed: z.number(),
  pendingReview: z.number(),
  done: z.boolean(),
});

interface CandidatePreview {
  readonly name?: string | undefined;
  readonly longitude?: number | undefined;
  readonly latitude?: number | undefined;
}

/** Best-effort preview: staged rows carry numeric coordinates, invalid
 * drafts may carry only a name. Anything unparseable previews as empty;
 * the row's errors and warnings always render alongside. */
const candidatePayloadSchema = z
  .object({
    name: z.string(),
    longitude: z.number(),
    latitude: z.number(),
  })
  .partial();

const EMPTY_CANDIDATE: CandidatePreview = {};

const stringListSchema = z.array(z.string());

const decodeNoteList = (text: string | null): Array<string> => {
  if (text === null) return [];

  try {
    const parsed = stringListSchema.safeParse(JSON.parse(text));

    return parsed.success ? [...parsed.data] : [text];
  } catch {
    return [text];
  }
};

const parseCandidatePayload = (payload: string): CandidatePreview => {
  let raw: unknown;

  try {
    raw = JSON.parse(payload);
  } catch {
    return EMPTY_CANDIDATE;
  }

  const parsed = candidatePayloadSchema.safeParse(raw);

  if (!parsed.success) return EMPTY_CANDIDATE;

  return parsed.data;
};

const wizardStepLabel = (step: WizardStep, vietnamese: boolean): string => {
  if (step === "source") return vietnamese ? "Bước 1/2: Nguồn" : "Step 1/2: Source";

  return vietnamese ? "Bước 2/2: Dữ liệu" : "Step 2/2: Acquire";
};

const acquireLabel = (format: "json" | "csv", vietnamese: boolean): string => {
  if (format === "json") return vietnamese ? "Dán các dòng JSON (mảng)" : "Paste JSON rows (array)";

  return vietnamese ? "Dán nội dung CSV" : "Paste CSV text";
};

function RestaurantImports(): ReactNode {
  const { lang } = rootRoute.useSearch();
  const copy = messagesFor(lang);
  const vi = lang === "vi";
  const initial = z.array(importJobViewSchema).parse(Route.useLoaderData());

  const [jobs, setJobs] = useState(initial);
  const [step, setStep] = useState<WizardStep>("source");
  const [sourceName, setSourceName] = useState("Overture Maps Places");
  const [format, setFormat] = useState<"json" | "csv">("json");
  const [sourceVersion, setSourceVersion] = useState("");
  const [release, setRelease] = useState("");
  const [license, setLicense] = useState("other");
  const [attribution, setAttribution] = useState("");
  const [jobSourceUrl, setJobSourceUrl] = useState("");
  const [payloadText, setPayloadText] = useState("");

  const [mapping, setMapping] = useState<Array<{ column: string; field: TemplateField }>>(
    TEMPLATE_FIELDS.map((field) => ({ column: field, field })),
  );

  const [jobId, setJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [licenseAck, setLicenseAck] = useState(false);
  const [reviewAck, setReviewAck] = useState(false);
  const [ackRefs, setAckRefs] = useState("");
  const [confirmApply, setConfirmApply] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const refreshJobs = useMutation({
    mutationFn: () => listRestaurantImportsFn({ data: { limit: 20, offset: 0 } }),
    onSuccess: (page) => {
      const parsed = z.array(importJobViewSchema).safeParse(page);

      if (parsed.success) {
        setJobs(parsed.data);

        return;
      }

      setFailure(vi ? "Dữ liệu đợt nhập không hợp lệ." : "Import job data was invalid.");
    },
  });

  const loadDetail = useMutation({
    mutationFn: (id: string) =>
      restaurantImportDetailFn({ data: { jobId: id, limit: 200, offset: 0 } }),
    onSuccess: (result) => {
      const parsed = importDetailSchema.safeParse(result);

      if (!parsed.success) {
        setFailure(vi ? "Dữ liệu đợt nhập không hợp lệ." : "Import job data was invalid.");

        return;
      }

      setDetail(parsed.data);
      setFailure(null);
      setStep("review");
    },
    onError: () => {
      setFailure(vi ? "Không tải được tác vụ." : "Could not load the import job.");
    },
  });

  const stage = useMutation({
    mutationFn: () =>
      stageRestaurantImportFn({
        data: {
          sourceName,
          format,
          sourceVersion: sourceVersion === "" ? null : sourceVersion,
          release: release === "" ? null : release,
          license: license === "" ? null : license,
          attribution: attribution === "" ? null : attribution,
          jobSourceUrl: jobSourceUrl === "" ? null : jobSourceUrl,
          jsonText: format === "json" ? payloadText : undefined,
          csvText: format === "csv" ? payloadText : undefined,
          mapping: format === "csv" ? mapping : undefined,
        },
      }),
    onSuccess: (result) => {
      const parsed = stageReportSchema.safeParse(result);

      if (!parsed.success) {
        setFailure(vi ? "Dữ liệu đợt nhập không hợp lệ." : "Import job data was invalid.");

        return;
      }

      setJobId(parsed.data.jobId);
      setFailure(null);
      loadDetail.mutate(parsed.data.jobId);
      refreshJobs.mutate();
    },
    onError: (error) => {
      setFailure(error instanceof Error ? error.message : String(error));
    },
  });

  const validate = useMutation({
    mutationFn: (id: string) => validateRestaurantImportFn({ data: { jobId: id } }),
    onSuccess: (_result, id) => {
      setFailure(null);
      loadDetail.mutate(id);
    },
    onError: (error) => {
      setFailure(error instanceof Error ? error.message : String(error));
    },
  });

  const resolve = useMutation({
    mutationFn: (input: { recordId: string; decision: "approved" | "skipped" }) =>
      resolveRestaurantImportFn({
        data: { jobId: jobId ?? "", recordId: input.recordId, decision: input.decision },
      }),
    onSuccess: () => {
      setFailure(null);

      if (jobId !== null) loadDetail.mutate(jobId);
    },
    onError: (error) => {
      setFailure(error instanceof Error ? error.message : String(error));
    },
  });

  const apply = useMutation({
    mutationFn: (id: string) =>
      applyRestaurantImportFn({
        data: {
          jobId: id,
          licenseAck,
          reviewAck,
          acknowledgedRefs: ackRefs
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0),
        },
      }),
    onSuccess: (result) => {
      const parsed = applyReportSchema.safeParse(result);

      if (!parsed.success) {
        setConfirmApply(false);
        setFailure(vi ? "Dữ liệu kết quả không hợp lệ." : "Apply result was invalid.");

        return;
      }

      const report = parsed.data;

      setApplyResult(
        vi
          ? `Áp dụng: ${report.applied} tạo mới, ${report.failed} lỗi, ${report.pendingReview} chờ duyệt.`
          : `Applied ${report.applied}, failed ${report.failed}, ${report.pendingReview} awaiting review.`,
      );
      setConfirmApply(false);
      setStep("results");

      if (jobId !== null) loadDetail.mutate(jobId);
      refreshJobs.mutate();
    },
    onError: (error) => {
      setConfirmApply(false);
      setFailure(error instanceof Error ? error.message : String(error));
    },
  });

  const title = vi ? "Nhập hàng loạt nhà hàng" : "Restaurant bulk imports";

  const subtitle = vi
    ? "Ứng viên địa điểm theo từng đợt: dàn dựng, kiểm tra, đối chiếu trùng, duyệt rồi mới áp dụng. Xuất bản vẫn là bước duyệt riêng."
    : "Venue candidates in batches: stage, validate, deduplicate, review, then apply. Publication stays a separate review.";

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeading
        title={title}
        description={subtitle}
        action={
          <AdminSecondaryButton type="button" onClick={() => setStep("source")}>
            {vi ? "Đợt nhập mới" : "New import"}
          </AdminSecondaryButton>
        }
      />

      {failure === null ? null : (
        <AdminErrorState
          message={failure}
          retryLabel={copy.commonRetry}
          onRetry={() => setFailure(null)}
        />
      )}

      <AdminSection title={vi ? "Lịch sử đợt nhập" : "Import job history"}>
        {jobs.length === 0 ? (
          <AdminEmptyState message={vi ? "Chưa có đợt nhập nào." : "No import jobs yet."} />
        ) : (
          <AdminTable>
            <thead>
              <tr className="border-y border-border-soft bg-cream/60">
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  {vi ? "Nguồn" : "Source"}
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  {vi ? "Phiên bản" : "Release"}
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  {copy.adminStatus}
                </th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">
                  {vi ? "Tổng" : "Total"}
                </th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">
                  {vi ? "Hợp lệ" : "Valid"}
                </th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">
                  {vi ? "Đã áp dụng" : "Applied"}
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  {copy.adminCreated}
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  {copy.adminActions}
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-border-soft last:border-0">
                  <td className="max-w-56 truncate px-4 py-3 font-medium" title={job.source_name}>
                    {job.source_name}
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {job.release ?? job.source_version ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <ImportStatusBadge status={job.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{job.total_records}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{job.valid_records}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{job.applied_count}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted">
                    {formatAdminDate(job.created_at, lang)}
                  </td>
                  <td className="px-4 py-3">
                    <AdminGhostButton
                      type="button"
                      onClick={() => {
                        setJobId(job.id);
                        loadDetail.mutate(job.id);
                      }}
                    >
                      {vi ? "Xem" : "Open"}
                    </AdminGhostButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
        )}
      </AdminSection>

      {step === "source" || step === "acquire" ? (
        <AdminSection
          title={vi ? "Đợt nhập mới" : "New import batch"}
          action={
            <span className="text-xs font-semibold text-muted">{wizardStepLabel(step, vi)}</span>
          }
        >
          {step === "source" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1 sm:col-span-2">
                <label htmlFor="ri-source" className="text-sm font-semibold">
                  {vi ? "Nguồn dữ liệu" : "Dataset source"}
                </label>
                <input
                  id="ri-source"
                  value={sourceName}
                  onChange={(event) => setSourceName(event.target.value)}
                  className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink"
                />
                <p className="text-xs text-muted">
                  {vi
                    ? "Dùng “Overture Maps Places” cho đợt Overture đã ghim, hoặc tên nguồn thủ công."
                    : "Use “Overture Maps Places” for a pinned Overture release, or a manual source name."}
                </p>
              </div>
              <AdminSelect
                id="ri-format"
                label={vi ? "Định dạng" : "Format"}
                value={format}
                onChange={(value) => {
                  if (value === "json" || value === "csv") setFormat(value);
                }}
                options={[
                  { label: "JSON", value: "json" },
                  { label: "CSV", value: "csv" },
                ]}
              />
              <div className="flex flex-col gap-1">
                <label htmlFor="ri-release" className="text-sm font-semibold">
                  {vi ? "Phiên bản phát hành (ghim)" : "Pinned release"}
                </label>
                <input
                  id="ri-release"
                  value={release}
                  onChange={(event) => setRelease(event.target.value)}
                  placeholder="2026-10.0"
                  className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="ri-version" className="text-sm font-semibold">
                  {vi ? "Phiên bản dataset" : "Dataset version"}
                </label>
                <input
                  id="ri-version"
                  value={sourceVersion}
                  onChange={(event) => setSourceVersion(event.target.value)}
                  placeholder="2026-10.0"
                  className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="ri-license" className="text-sm font-semibold">
                  {vi ? "Giấy phép" : "License"}
                </label>
                <input
                  id="ri-license"
                  value={license}
                  onChange={(event) => setLicense(event.target.value)}
                  placeholder="other"
                  className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink"
                />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <label htmlFor="ri-attribution" className="text-sm font-semibold">
                  {vi ? "Ghi công" : "Attribution"}
                </label>
                <input
                  id="ri-attribution"
                  value={attribution}
                  onChange={(event) => setAttribution(event.target.value)}
                  className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink"
                />
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2">
                <label htmlFor="ri-url" className="text-sm font-semibold">
                  {vi ? "URL nguồn (dự phòng provenance)" : "Source URL (provenance fallback)"}
                </label>
                <input
                  id="ri-url"
                  value={jobSourceUrl}
                  onChange={(event) => setJobSourceUrl(event.target.value)}
                  placeholder="https://…"
                  className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink"
                />
              </div>
              <div className="sm:col-span-2">
                <AdminPrimaryButton type="button" onClick={() => setStep("acquire")}>
                  {vi ? "Tiếp tục: dữ liệu" : "Continue: acquire"}
                </AdminPrimaryButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="ri-payload" className="text-sm font-semibold">
                  {acquireLabel(format, vi)}
                </label>
                <textarea
                  id="ri-payload"
                  value={payloadText}
                  onChange={(event) => setPayloadText(event.target.value)}
                  rows={10}
                  spellCheck={false}
                  className="rounded-lg border border-border-soft bg-white px-3 py-2 font-mono text-xs text-ink"
                />
                <p className="text-xs text-muted">
                  {vi
                    ? "Từ vựng cột mẫu: businessName, name, address, area, countryCode, longitude, latitude, cuisineSlugs, sourceRecordId, observedAt, sourceUrl."
                    : "Template column vocabulary: businessName, name, address, area, countryCode, longitude, latitude, cuisineSlugs, sourceRecordId, observedAt, sourceUrl."}
                </p>
              </div>
              {format === "csv" ? (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-bold">{vi ? "Ánh xạ cột" : "Field mapping"}</h3>
                  {mapping.map((entry, index) => (
                    <div key={entry.field} className="grid grid-cols-2 gap-2">
                      <span className="inline-flex min-h-11 items-center rounded-lg bg-cream px-3 text-sm font-semibold">
                        {entry.field}
                      </span>
                      <input
                        aria-label={entry.field}
                        value={entry.column}
                        onChange={(event) => {
                          setMapping((previous) =>
                            previous.map((item, position) =>
                              position === index ? { ...item, column: event.target.value } : item,
                            ),
                          );
                        }}
                        className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 text-sm text-ink"
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <AdminGhostButton type="button" onClick={() => setStep("source")}>
                  {vi ? "Quay lại" : "Back"}
                </AdminGhostButton>
                <AdminPrimaryButton
                  type="button"
                  disabled={stage.isPending}
                  aria-busy={stage.isPending}
                  onClick={() => stage.mutate()}
                >
                  {vi ? "Dàn dựng đợt nhập" : "Stage import"}
                </AdminPrimaryButton>
              </div>
            </div>
          )}
        </AdminSection>
      ) : null}

      {step === "review" && detail !== null ? (
        <ImportReview
          detail={detail}
          vi={vi}
          validating={validate.isPending}
          resolving={resolve.isPending}
          applying={apply.isPending}
          licenseAck={licenseAck}
          reviewAck={reviewAck}
          ackRefs={ackRefs}
          onValidate={() => validate.mutate(detail.job.id)}
          onResolve={(recordId, decision) => resolve.mutate({ recordId, decision })}
          onLicenseAck={setLicenseAck}
          onReviewAck={setReviewAck}
          onAckRefs={setAckRefs}
          onApply={() => setConfirmApply(true)}
        />
      ) : null}

      {step === "results" ? (
        <AdminCard>
          <p className="text-sm font-semibold">{applyResult ?? (vi ? "Hoàn tất." : "Done.")}</p>
          <p className="mt-2 text-sm text-muted">
            {vi
              ? "Các địa điểm mới ở trạng thái nháp; xuất bản vẫn cần duyệt riêng. Không có điểm tin cậy nào được hiển thị như đánh giá của khách."
              : "New venues are drafts; publication still needs a separate review. No source confidence is shown as a customer rating."}
          </p>
          <p className="mt-3">
            <Link
              to="/admin/restaurants"
              search={{ lang }}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-blue-hover underline underline-offset-4"
            >
              {vi ? "Mở duyệt nhà hàng" : "Open restaurant review"}
            </Link>
          </p>
        </AdminCard>
      ) : null}

      <AdminDialog
        open={confirmApply}
        onOpenChange={setConfirmApply}
        title={vi ? "Xác nhận áp dụng hàng loạt" : "Confirm bulk apply"}
        description={
          vi
            ? "Các dòng hợp lệ/đã duyệt sẽ tạo địa điểm nháp mới. Không ghi đè sửa tay của curator."
            : "Valid and approved rows will create new draft venues. Curator edits are never overwritten."
        }
        closeLabel={vi ? "Đóng" : "Close"}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <AdminGhostButton type="button" onClick={() => setConfirmApply(false)}>
              {vi ? "Hủy" : "Cancel"}
            </AdminGhostButton>
            <AdminPrimaryButton
              type="button"
              disabled={apply.isPending || jobId === null}
              aria-busy={apply.isPending}
              onClick={() => {
                if (jobId !== null) apply.mutate(jobId);
              }}
            >
              {vi ? "Áp dụng" : "Apply"}
            </AdminPrimaryButton>
          </div>
        }
      >
        <p className="text-sm text-muted">
          {vi
            ? "Áp dụng hàng loạt cần cả hai quyền quản lý và duyệt. Mọi thao tác đều ghi audit trong cùng transaction."
            : "Bulk apply requires both manage and review grants. Every write is audited in the same transaction."}
        </p>
      </AdminDialog>
    </div>
  );
}

function ImportReview({
  detail,
  vi,
  validating,
  resolving,
  applying,
  licenseAck,
  reviewAck,
  ackRefs,
  onValidate,
  onResolve,
  onLicenseAck,
  onReviewAck,
  onAckRefs,
  onApply,
}: {
  readonly detail: Detail;
  readonly vi: boolean;
  readonly validating: boolean;
  readonly resolving: boolean;
  readonly applying: boolean;
  readonly licenseAck: boolean;
  readonly reviewAck: boolean;
  readonly ackRefs: string;
  readonly onValidate: () => void;
  readonly onResolve: (recordId: string, decision: "approved" | "skipped") => void;
  readonly onLicenseAck: (value: boolean) => void;
  readonly onReviewAck: (value: boolean) => void;
  readonly onAckRefs: (value: string) => void;
  readonly onApply: () => void;
}): ReactNode {
  const { job, records, counts } = detail;
  const needsValidation = job.status === "staged";
  const canApply = job.status === "validated" || job.status === "applying";

  return (
    <div className="flex flex-col gap-4">
      <AdminSection
        title={vi ? "Tóm tắt kiểm tra" : "Validation summary"}
        action={
          needsValidation ? (
            <AdminPrimaryButton
              type="button"
              disabled={validating}
              aria-busy={validating}
              onClick={onValidate}
            >
              {vi ? "Chạy kiểm tra" : "Run validation"}
            </AdminPrimaryButton>
          ) : undefined
        }
      >
        <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <div className="rounded-lg bg-cream px-3 py-2">
            <dt className="text-muted">{vi ? "Tổng" : "Total"}</dt>
            <dd className="text-lg font-bold tabular-nums">{job.total_records}</dd>
          </div>
          <div className="rounded-lg bg-cream px-3 py-2">
            <dt className="text-muted">{vi ? "Hợp lệ" : "Valid"}</dt>
            <dd className="text-lg font-bold tabular-nums">{counts.valid + counts.approved}</dd>
          </div>
          <div className="rounded-lg bg-cream px-3 py-2">
            <dt className="text-muted">{vi ? "Chờ duyệt trùng" : "Needs review"}</dt>
            <dd className="text-lg font-bold tabular-nums">{counts.needsReview}</dd>
          </div>
          <div className="rounded-lg bg-cream px-3 py-2">
            <dt className="text-muted">{vi ? "Lỗi / Trùng" : "Invalid / Duplicate"}</dt>
            <dd className="text-lg font-bold tabular-nums">
              {counts.invalid + counts.skippedDuplicate}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted">
          {vi ? "Nguồn" : "Source"}: {job.source_name}
          {job.release === null ? "" : ` · ${job.release}`}
          {job.source_version === null ? "" : ` · ${job.source_version}`} ·{" "}
          {vi ? "Giấy phép" : "License"}: {job.license ?? "—"} · {vi ? "Ghi công" : "Attribution"}:{" "}
          {job.attribution ?? "—"}
        </p>
      </AdminSection>

      <AdminSection title={vi ? "Ứng viên (xem trước tọa độ)" : "Candidates (coordinate preview)"}>
        {records.length === 0 ? (
          <AdminEmptyState message={vi ? "Chưa có dòng nào." : "No records staged."} />
        ) : (
          <AdminTable minWidthClass="min-w-[52rem]">
            <thead>
              <tr className="border-y border-border-soft bg-cream/60">
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  Ref
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  {vi ? "Tên" : "Name"}
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  {vi ? "Tọa độ" : "Coordinates"}
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  {vi ? "Trạng thái" : "Status"}
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  Dedup
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  {vi ? "Ghi chú" : "Notes"}
                </th>
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  {vi ? "Duyệt" : "Resolve"}
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => {
                const preview = parseCandidatePayload(record.payload);
                const name = preview.name ?? "—";
                const lon = preview.longitude;
                const lat = preview.latitude;

                const notes = [
                  ...decodeNoteList(record.errors),
                  ...decodeNoteList(record.warnings),
                  ...(record.duplicate_of === null
                    ? []
                    : [`candidate venue: ${record.duplicate_of}`]),
                  ...(record.venue_id === null ? [] : [`venue: ${record.venue_id}`]),
                ];

                return (
                  <tr key={record.id} className="border-b border-border-soft last:border-0">
                    <td
                      className="max-w-40 truncate px-4 py-3 font-medium"
                      title={record.external_ref}
                    >
                      {record.external_ref}
                    </td>
                    <td className="max-w-56 truncate px-4 py-3" title={name}>
                      {name}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                      {lon === undefined || lat === undefined
                        ? "—"
                        : `${lat.toFixed(5)}, ${lon.toFixed(5)}`}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-block rounded-full border border-border-soft bg-cream px-2 py-0.5 text-xs font-semibold text-muted">
                        {record.status}
                      </span>
                    </td>
                    <td
                      className="max-w-48 truncate px-4 py-3 text-xs text-muted"
                      title={record.dedup_key ?? ""}
                    >
                      {record.dedup_key ?? "—"}
                    </td>
                    <td className="max-w-64 px-4 py-3 text-xs text-muted">
                      {notes.join(" · ") || "—"}
                    </td>
                    <td className="px-4 py-3">
                      {record.status === "needs_review" ? (
                        <span className="flex flex-wrap gap-1">
                          <AdminGhostButton
                            type="button"
                            disabled={resolving}
                            onClick={() => onResolve(record.id, "approved")}
                          >
                            {vi ? "Tạo mới" : "Accept new"}
                          </AdminGhostButton>
                          <AdminGhostButton
                            type="button"
                            disabled={resolving}
                            onClick={() => onResolve(record.id, "skipped")}
                          >
                            {vi ? "Trùng" : "Duplicate"}
                          </AdminGhostButton>
                        </span>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </AdminTable>
        )}
      </AdminSection>

      {canApply ? (
        <AdminSection title={vi ? "Duyệt hàng loạt & áp dụng" : "Bulk review and apply"}>
          <div className="flex flex-col gap-3">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={licenseAck}
                onChange={(event) => onLicenseAck(event.target.checked)}
                className="size-5"
              />
              {vi
                ? "Tôi đã xem xét giấy phép/tái sử dụng của nguồn này."
                : "I reviewed this source's license and reuse terms."}
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={reviewAck}
                onChange={(event) => onReviewAck(event.target.checked)}
                className="size-5"
              />
              {vi
                ? "Tôi đã xem lại các dòng và ứng viên trùng."
                : "I reviewed the rows and duplicate candidates."}
            </label>
            <div className="flex flex-col gap-1">
              <label htmlFor="ri-ackrefs" className="text-sm font-semibold">
                {vi
                  ? "Chấp nhận trùng theo ref (phân tách dấu phẩy, tùy chọn)"
                  : "Acknowledge duplicates by ref (comma-separated, optional)"}
              </label>
              <input
                id="ri-ackrefs"
                value={ackRefs}
                onChange={(event) => onAckRefs(event.target.value)}
                placeholder=" overture-id-1, overture-id-2"
                className="min-h-11 rounded-lg border border-border-soft bg-white px-3 py-2 font-mono text-xs text-ink"
              />
            </div>
            <div>
              <AdminPrimaryButton
                type="button"
                disabled={applying}
                aria-busy={applying}
                onClick={onApply}
              >
                {vi ? "Áp dụng đợt nhập" : "Apply import"}
              </AdminPrimaryButton>
            </div>
            <p className="text-xs text-muted">
              {vi
                ? "Áp dụng tạo địa điểm nháp mới; không bao giờ ghi đè sửa tay của curator và không suy ra món ăn từ tên."
                : "Apply creates new draft venues; it never overwrites curator edits and never infers dishes from names."}
            </p>
          </div>
        </AdminSection>
      ) : null}
    </div>
  );
}
