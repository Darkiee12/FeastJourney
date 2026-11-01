import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ActionFooter, StageCard } from "@/components/admin/import-wizard/chrome";
import { AckCheckbox } from "@/components/admin/import-wizard/fields";
import { numberIssues, validationProgress } from "@/components/admin/import-wizard/types";
import type {
  IssueFilter,
  NumberedIssue,
  ValidationReport,
} from "@/components/admin/import-wizard/types";
import type { ImportLicense } from "@/modules/food-discovery/admin.schema";
import type { Locale, Messages } from "@/shared/i18n";

const ISSUES_PAGE_SIZE = 20;

const matchesQuery = (entry: NumberedIssue, query: string): boolean => {
  const needle = query.trim().toLowerCase();

  if (needle === "") {
    return true;
  }

  const haystacks = [
    entry.item.externalRef,
    entry.item.slug ?? "",
    entry.item.duplicateOf ?? "",
    entry.item.errors.join(" | "),
    String(entry.rowNumber),
  ];

  return haystacks.some((field) => field.toLowerCase().includes(needle));
};

function usePagedIssues(entries: ReadonlyArray<NumberedIssue>, page: number) {
  const pageCount = Math.max(1, Math.ceil(entries.length / ISSUES_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), pageCount - 1);

  return {
    pageCount,
    safePage,
    visible: entries.slice(
      safePage * ISSUES_PAGE_SIZE,
      safePage * ISSUES_PAGE_SIZE + ISSUES_PAGE_SIZE,
    ),
  };
}

interface IssuePagerProps {
  readonly copy: Messages;
  readonly from: number;
  readonly lang: Locale;
  readonly onPage: (page: number) => void;
  readonly page: number;
  readonly pageCount: number;
  readonly to: number;
  readonly total: number;
}

function IssuePager({
  copy,
  from,
  lang,
  onPage,
  page,
  pageCount,
  to,
  total,
}: IssuePagerProps): ReactNode {
  const range =
    lang === "vi" ? `Hiển thị ${from}–${to} / ${total}` : `Showing ${from}–${to} of ${total}`;

  return (
    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3">
      <p aria-live="polite" className="text-sm text-muted">
        {range}
      </p>
      {pageCount > 1 ? (
        <p className="flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-full border border-border-soft bg-white px-4 text-sm font-bold hover:bg-cream disabled:cursor-not-allowed disabled:opacity-60 motion-safe:transition-colors"
            disabled={page === 0}
            onClick={() => {
              onPage(page - 1);
            }}
          >
            {copy.adminImportPrevious}
          </button>
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-full border border-border-soft bg-white px-4 text-sm font-bold hover:bg-cream disabled:cursor-not-allowed disabled:opacity-60 motion-safe:transition-colors"
            disabled={page >= pageCount - 1}
            onClick={() => {
              onPage(page + 1);
            }}
          >
            {copy.adminImportNext}
          </button>
        </p>
      ) : null}
    </div>
  );
}

interface InvalidRowsProps {
  readonly copy: Messages;
  readonly entries: ReadonlyArray<NumberedIssue>;
  readonly lang: Locale;
  readonly page: number;
  readonly onPage: (page: number) => void;
}

function InvalidRows({ copy, entries, lang, onPage, page }: InvalidRowsProps): ReactNode {
  const rowLabel = lang === "vi" ? "Dòng" : "Row";
  const { pageCount, safePage, visible } = usePagedIssues(entries, page);

  if (entries.length === 0) {
    return <p className="mt-3 max-w-prose">{copy.adminImportNoInvalid}</p>;
  }

  const from = safePage * ISSUES_PAGE_SIZE + 1;
  const to = safePage * ISSUES_PAGE_SIZE + visible.length;

  return (
    <div className="mt-3 min-w-0">
      <div className="max-h-[30rem] min-w-0 overflow-auto rounded-lg border border-border-soft">
        <table className="w-full min-w-[44rem] border-collapse text-left text-sm">
          <caption className="bg-cream/60 px-3 py-2 text-left font-semibold">
            {copy.adminImportInvalidCaption}
          </caption>
          <thead>
            <tr className="border-b border-border-soft">
              <th scope="col" className="sticky top-0 bg-cream px-2 py-2">
                {rowLabel}
              </th>
              <th scope="col" className="sticky top-0 bg-cream px-2 py-2">
                {copy.adminImportExternalRef}
              </th>
              <th scope="col" className="sticky top-0 bg-cream px-2 py-2">
                {copy.adminSlug}
              </th>
              <th scope="col" className="sticky top-0 bg-cream px-2 py-2">
                {copy.adminImportErrorsCol}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => (
              <tr
                key={entry.item.externalRef}
                className="border-b border-border-soft align-top last:border-0"
              >
                <td className="px-2 py-2 tabular-nums">{entry.rowNumber}</td>
                <td className="px-2 py-2 break-words">{entry.item.externalRef}</td>
                <td className="px-2 py-2 break-words">{entry.item.slug ?? "—"}</td>
                <td className="px-2 py-2">
                  <ul className="list-disc space-y-1 pl-5">
                    {entry.item.errors.map((error) => (
                      <li key={error} className="break-words">
                        {error}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <IssuePager
        copy={copy}
        from={from}
        lang={lang}
        onPage={onPage}
        page={safePage}
        pageCount={pageCount}
        to={to}
        total={entries.length}
      />
    </div>
  );
}

interface DuplicateRowsProps {
  readonly acknowledged: ReadonlyArray<string>;
  readonly copy: Messages;
  readonly entries: ReadonlyArray<NumberedIssue>;
  readonly lang: Locale;
  readonly onPage: (page: number) => void;
  readonly onToggle: (externalRef: string) => void;
  readonly page: number;
}

function DuplicateRows({
  acknowledged,
  copy,
  entries,
  lang,
  onPage,
  onToggle,
  page,
}: DuplicateRowsProps): ReactNode {
  const rowLabel = lang === "vi" ? "Dòng" : "Row";
  const { pageCount, safePage, visible } = usePagedIssues(entries, page);

  if (entries.length === 0) {
    return <p className="mt-3 max-w-prose">{copy.adminImportNoDuplicates}</p>;
  }

  const from = safePage * ISSUES_PAGE_SIZE + 1;
  const to = safePage * ISSUES_PAGE_SIZE + visible.length;

  return (
    <div className="mt-3 min-w-0">
      <div className="max-h-[30rem] min-w-0 overflow-auto rounded-lg border border-border-soft">
        <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
          <caption className="bg-cream/60 px-3 py-2 text-left font-semibold">
            {copy.adminImportDuplicatesCaption}
          </caption>
          <thead>
            <tr className="border-b border-border-soft">
              <th scope="col" className="sticky top-0 bg-cream px-2 py-2">
                {rowLabel}
              </th>
              <th scope="col" className="sticky top-0 bg-cream px-2 py-2">
                {copy.adminImportExternalRef}
              </th>
              <th scope="col" className="sticky top-0 bg-cream px-2 py-2">
                {copy.adminSlug}
              </th>
              <th scope="col" className="sticky top-0 bg-cream px-2 py-2">
                {copy.adminImportDupOf}
              </th>
              <th scope="col" className="sticky top-0 bg-cream px-2 py-2">
                {copy.adminImportCreateAsNew}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => (
              <tr
                key={entry.item.externalRef}
                className="border-b border-border-soft align-top last:border-0"
              >
                <td className="px-2 py-2 tabular-nums">{entry.rowNumber}</td>
                <td className="px-2 py-2 break-words">{entry.item.externalRef}</td>
                <td className="px-2 py-2 break-words">{entry.item.slug ?? "—"}</td>
                <td className="px-2 py-2 break-words">{entry.item.duplicateOf ?? "—"}</td>
                <td className="px-2 py-2">
                  <label className="flex min-h-11 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={copy.adminImportCreateAsNewAck}
                      checked={acknowledged.includes(entry.item.externalRef)}
                      onChange={() => {
                        onToggle(entry.item.externalRef);
                      }}
                      className="h-5 w-5 shrink-0"
                    />
                    <span>{copy.adminImportCreateAsNewAck}</span>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <IssuePager
        copy={copy}
        from={from}
        lang={lang}
        onPage={onPage}
        page={safePage}
        pageCount={pageCount}
        to={to}
        total={entries.length}
      />
      <p className="mt-2 max-w-prose text-sm text-muted">{copy.adminImportMergeDisabled}</p>
    </div>
  );
}

function AdvancedSummary({
  copy,
  report,
}: {
  readonly copy: Messages;
  readonly report: ValidationReport;
}): ReactNode {
  return (
    <details className="mt-4 max-w-prose rounded-xl border border-border-soft p-4">
      <summary className="min-h-11 cursor-pointer font-semibold">
        {copy.adminImportViewValidationJob}: {report.jobId}
      </summary>
      <dl className="mt-2">
        <div className="flex flex-wrap gap-x-2 py-1">
          <dt className="font-semibold">{copy.adminImportValidCount}</dt>
          <dd>{report.validRecords}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2 py-1">
          <dt className="font-semibold">{copy.adminImportInvalidCount}</dt>
          <dd>{report.invalidRecords}</dd>
        </div>
      </dl>
    </details>
  );
}

interface IssuesStageProps {
  readonly acknowledged: ReadonlyArray<string>;
  readonly allAcked: boolean;
  readonly copy: Messages;
  readonly duplicateItems: ReadonlyArray<ValidationReport["items"][number]>;
  readonly invalidItems: ReadonlyArray<ValidationReport["items"][number]>;
  readonly lang: Locale;
  readonly onBack: () => void;
  readonly onContinue: () => void;
  readonly onToggleDuplicate: (externalRef: string) => void;
  readonly report: ValidationReport | null;
}

interface IssuesBodyProps {
  readonly acknowledged: ReadonlyArray<string>;
  readonly allAcked: boolean;
  readonly copy: Messages;
  readonly duplicateCount: number;
  readonly lang: Locale;
  readonly onBack: () => void;
  readonly onContinue: () => void;
  readonly onToggleDuplicate: (externalRef: string) => void;
  readonly report: ValidationReport;
}

function IssuesBody({
  acknowledged,
  allAcked,
  copy,
  duplicateCount,
  lang,
  onBack,
  onContinue,
  onToggleDuplicate,
  report,
}: IssuesBodyProps): ReactNode {
  const [filter, setFilter] = useState<IssueFilter>("all");
  const [query, setQuery] = useState("");
  const [invalidPage, setInvalidPage] = useState(0);
  const [duplicatePage, setDuplicatePage] = useState(0);

  const numbered = useMemo(() => numberIssues(report.items), [report]);

  const visibleInvalid = useMemo(() => {
    const base: ReadonlyArray<NumberedIssue> = numbered.filter(
      (entry) => entry.item.status === "invalid",
    );

    return base.filter((entry) => matchesQuery(entry, query));
  }, [numbered, query]);

  const visibleDuplicates = useMemo(
    () =>
      numbered
        .filter((entry) => entry.item.duplicateOf !== null && entry.item.status === "valid")
        .filter((entry) => matchesQuery(entry, query)),
    [numbered, query],
  );

  const showInvalid = filter !== "duplicates";
  const showDuplicates = filter !== "invalid";

  const searchLabel = lang === "vi" ? "Tìm trong các vấn đề" : "Search issues";

  const searchPlaceholder =
    lang === "vi" ? "ví dụ: mã ngoài, slug, lỗi…" : "e.g. external ref, slug, error…";

  const filterLabel = lang === "vi" ? "Lọc theo loại" : "Filter by kind";
  const filterAll = lang === "vi" ? "Tất cả" : "All";
  const filterInvalid = lang === "vi" ? "Không hợp lệ" : "Invalid";
  const filterDuplicates = lang === "vi" ? "Trùng lặp có thể" : "Possible duplicates";

  const noMatch =
    lang === "vi"
      ? "Không có vấn đề nào khớp bộ lọc hiện tại."
      : "No issues match the current filters.";

  const hasVisible =
    (showInvalid && visibleInvalid.length > 0) || (showDuplicates && visibleDuplicates.length > 0);

  return (
    <StageCard label={copy.adminStageIssues} title={copy.adminImportStepIssues}>
      <div className="min-w-0">
        <p aria-live="polite" className="mt-2 max-w-prose font-semibold">
          {report.validRecords} valid, {report.invalidRecords} invalid, {duplicateCount} possible
          duplicates.
        </p>
        <p className="mt-2 max-w-prose text-sm text-muted">{copy.adminImportPlacesFormat}</p>

        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:max-w-prose sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="min-w-0">
            <label htmlFor="import-issues-search" className="block text-sm font-semibold">
              {searchLabel}
            </label>
            <input
              id="import-issues-search"
              type="search"
              value={query}
              placeholder={searchPlaceholder}
              onChange={(event) => {
                setQuery(event.target.value);
                setInvalidPage(0);
                setDuplicatePage(0);
              }}
              className="mt-1 block min-h-11 w-full rounded-lg border border-border-soft bg-white px-3 text-sm text-ink outline-none focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40"
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="import-issues-filter" className="block text-sm font-semibold">
              {filterLabel}
            </label>
            <select
              id="import-issues-filter"
              value={filter}
              onChange={(event) => {
                const next = event.target.value;

                if (next === "invalid" || next === "duplicates" || next === "all") {
                  setFilter(next);
                  setInvalidPage(0);
                  setDuplicatePage(0);
                }
              }}
              className="mt-1 block min-h-11 w-full rounded-lg border border-border-soft bg-white px-3 text-sm text-ink outline-none focus-visible:border-brand-blue focus-visible:ring-2 focus-visible:ring-brand-blue/40 sm:w-auto"
            >
              <option value="all">{filterAll}</option>
              <option value="invalid">{filterInvalid}</option>
              <option value="duplicates">{filterDuplicates}</option>
            </select>
          </div>
        </div>

        {hasVisible ? null : <p className="mt-3 max-w-prose">{noMatch}</p>}

        {showInvalid ? (
          <InvalidRows
            copy={copy}
            entries={visibleInvalid}
            lang={lang}
            page={invalidPage}
            onPage={setInvalidPage}
          />
        ) : null}
        {showDuplicates ? (
          <DuplicateRows
            acknowledged={acknowledged}
            copy={copy}
            entries={visibleDuplicates}
            lang={lang}
            onPage={setDuplicatePage}
            onToggle={onToggleDuplicate}
            page={duplicatePage}
          />
        ) : null}

        <AdvancedSummary copy={copy} report={report} />
        <ActionFooter>
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-full border border-border-soft px-5 font-bold"
            onClick={onBack}
          >
            {copy.adminImportBack}
          </button>
          <button
            type="button"
            className="inline-flex min-h-11 items-center rounded-full bg-brand-blue px-5 font-bold text-white disabled:opacity-50"
            disabled={!allAcked}
            onClick={onContinue}
          >
            {copy.adminImportContinueConfirm}
          </button>
        </ActionFooter>
        {allAcked ? null : <p className="mt-2 text-sm">{copy.adminImportAckAll}</p>}
      </div>
    </StageCard>
  );
}

// Keyed by job so filter/query/page state resets with each fresh report
// instead of syncing state in an effect.
export function IssuesStage(props: IssuesStageProps): ReactNode {
  const { report } = props;

  if (report === null) {
    return (
      <StageCard label={props.copy.adminStageIssues} title={props.copy.adminImportStepIssues}>
        <p className="mt-2 max-w-prose">{props.copy.adminImportNoReport}</p>
      </StageCard>
    );
  }

  return (
    <IssuesBody
      key={report.jobId}
      acknowledged={props.acknowledged}
      allAcked={props.allAcked}
      copy={props.copy}
      duplicateCount={props.duplicateItems.length}
      lang={props.lang}
      onBack={props.onBack}
      onContinue={props.onContinue}
      onToggleDuplicate={props.onToggleDuplicate}
      report={report}
    />
  );
}

interface ConfirmStageProps {
  readonly applyError: boolean;
  readonly applyReady: boolean;
  readonly copy: Messages;
  readonly duplicateCount: number;
  readonly freshStatus: string | null;
  readonly isRefreshing: boolean;
  readonly lang: Locale;
  readonly license: ImportLicense;
  readonly licenseAck: boolean;
  readonly licenseReview: boolean;
  readonly onApply: () => void;
  readonly onBack: () => void;
  readonly onLicenseAck: (checked: boolean) => void;
  readonly onRefresh: () => void;
  readonly onReviewAck: (checked: boolean) => void;
  readonly report: ValidationReport | null;
  readonly reviewAck: boolean;
  readonly sourceName: string;
}

export function ConfirmStage({
  applyError,
  applyReady,
  copy,
  duplicateCount,
  freshStatus,
  isRefreshing,
  lang,
  license,
  licenseAck,
  licenseReview,
  onApply,
  onBack,
  onLicenseAck,
  onRefresh,
  onReviewAck,
  report,
  reviewAck,
  sourceName,
}: ConfirmStageProps): ReactNode {
  const stale = freshStatus !== null && freshStatus !== "validated" && !isRefreshing;
  const incomplete = report !== null && validationProgress(report).hasMore;

  const incompleteNote =
    lang === "vi"
      ? "Kiểm tra chưa xong: hãy tiếp tục kiểm tra cho đến khi hết đợt rồi mới áp dụng."
      : "Validation is incomplete: continue validation until every batch is processed before applying.";

  return (
    <StageCard label={copy.adminStageConfirm} title={copy.adminImportStepConfirm}>
      {report === null ? (
        <p className="mt-2 max-w-prose">{copy.adminImportNoReport}</p>
      ) : (
        <div className="min-w-0">
          <dl className="mt-2 max-w-prose rounded-xl border border-border-soft p-4">
            <div className="flex flex-wrap gap-x-2 py-1">
              <dt className="font-semibold">{copy.adminImportValidCount}</dt>
              <dd>{report.validRecords}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2 py-1">
              <dt className="font-semibold">{copy.adminImportInvalidSkipped}</dt>
              <dd>{report.invalidRecords}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2 py-1">
              <dt className="font-semibold">{copy.adminImportDupCount}</dt>
              <dd>{duplicateCount}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2 py-1">
              <dt className="font-semibold">{copy.adminImportSourceRow}</dt>
              <dd className="break-words">{sourceName}</dd>
            </div>
            <div className="flex flex-wrap gap-x-2 py-1">
              <dt className="font-semibold">{copy.adminImportLicenseRow}</dt>
              <dd className="break-words">{license}</dd>
            </div>
          </dl>

          <p aria-live="polite" className="mt-3 max-w-prose">
            {copy.adminImportFreshStatus}{" "}
            {isRefreshing
              ? copy.adminImportRefreshingShort
              : (freshStatus ?? copy.adminImportUnknown)}
          </p>

          {stale ? (
            <p role="alert" className="mt-2 max-w-prose font-semibold text-red-700">
              Job {report.jobId} is {freshStatus}, not validated. Apply is refused until the job is
              validated; fix the dataset and run validation again.
            </p>
          ) : null}

          {incomplete ? (
            <p role="alert" className="mt-2 max-w-prose font-semibold text-amber-700">
              {incompleteNote}
            </p>
          ) : null}

          <p className="mt-3 max-w-prose">{copy.adminImportReviewNotice}</p>

          {licenseReview ? (
            <AckCheckbox
              id="import-license-ack"
              label={copy.adminImportLicenseAck}
              checked={licenseAck}
              onChange={onLicenseAck}
            />
          ) : null}

          <AckCheckbox
            id="import-review-ack"
            label={copy.adminImportReviewAck}
            checked={reviewAck}
            onChange={onReviewAck}
          />

          {applyError ? (
            <p role="alert" className="mt-2 max-w-prose font-semibold text-red-700">
              {copy.adminImportApplyFailed}
            </p>
          ) : null}

          <ActionFooter>
            <button
              type="button"
              className="inline-flex min-h-11 items-center rounded-full border border-border-soft px-5 font-bold"
              onClick={onRefresh}
            >
              {copy.adminImportRefreshStatus}
            </button>
            <button
              type="button"
              className="inline-flex min-h-11 items-center rounded-full bg-food-orange-strong px-5 font-bold text-white disabled:opacity-50"
              disabled={!applyReady}
              onClick={onApply}
            >
              Apply {report.validRecords} validated records
            </button>
          </ActionFooter>

          <p className="mt-3 max-w-prose">
            <button
              type="button"
              className="inline-flex min-h-11 items-center rounded-full border border-border-soft px-5 font-bold"
              onClick={onBack}
            >
              {copy.adminImportBackToIssues}
            </button>
          </p>
        </div>
      )}
    </StageCard>
  );
}
