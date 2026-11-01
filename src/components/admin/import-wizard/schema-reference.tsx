import { Copy, Download, FileJson, FileSpreadsheet, Info } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import {
  CSV_COLUMNS,
  RECORD_FIELDS,
  SAMPLE_CSV,
  downloadSample,
  downloadTemplate,
} from "@/components/admin/import-wizard/helpers";
import type { ReferenceFieldRow } from "@/components/admin/import-wizard/helpers";
import { AdminDialog } from "@/components/admin/ui";
import {
  FEASTJOURNEY_JSON_TEMPLATE,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_RECORDS,
  SOURCE_REGISTRY,
  importLicenseSchema,
} from "@/modules/food-discovery/admin.schema";
import { formatFileSize } from "@/shared/format-file-size";
import type { Messages } from "@/shared/i18n";

const TABS = ["json", "csv", "fields"] as const;

type SchemaTab = (typeof TABS)[number];

/**
 * Schema discoverability for the Upload stage: a tabbed reference for the
 * REAL server contracts. The tables stay hand-maintained (never presented
 * as generated): RECORD_FIELDS mirrors `AuthoringDish` field by field and
 * CSV_COLUMNS mirrors the documented `csvToRecords` contract; drift is
 * pinned by `tests/admin-import-schema-dialog.test.ts`, which checks the
 * field set against the canonical struct, the CSV columns against the real
 * parser, and the vocabulary against the canonical id enums.
 *
 * No "Download JSON Schema" button: the installed Effect version does
 * ship `effect/JsonSchema`, but a trustworthy artifact needs build-time
 * codegen from the server-only ImportPayload plus a CI freshness check.
 * Shipping a checked-in snapshot without that pipeline would be exactly
 * the hand-maintained duplicate the spec forbids, so the template +
 * sample downloads plus this table stand in until that pipeline exists.
 */

const copyTextToClipboard = (text: string): Promise<boolean> => {
  const fallback = (): boolean => {
    try {
      const area = document.createElement("textarea");

      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");

      area.remove();

      return ok;
    } catch {
      return false;
    }
  };

  return navigator.clipboard.writeText(text).then(
    () => true,
    () => fallback(),
  );
};

const limitsLine = (copy: Messages): string => {
  const sizeLabel = formatFileSize(MAX_IMPORT_FILE_BYTES);

  return copy.adminImportSchemaLimits
    .replace("{records}", String(MAX_IMPORT_RECORDS))
    .replace("{mb}", sizeLabel)
    .replace("{bytes}", MAX_IMPORT_FILE_BYTES.toLocaleString());
};

function CopyButton({ copy, text }: { readonly copy: Messages; readonly text: string }): ReactNode {
  const [done, setDone] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void copyTextToClipboard(text).then((ok) => {
          if (ok) {
            setDone(true);
            window.setTimeout(() => {
              setDone(false);
            }, 2000);
          }
        });
      }}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border-soft bg-white px-4 text-sm font-semibold text-ink outline-none hover:bg-cream focus-visible:ring-2 focus-visible:ring-brand-blue motion-safe:transition-colors"
    >
      <Copy aria-hidden="true" className="size-4" />
      <span aria-live="polite">
        {done ? copy.adminImportSchemaCopied : copy.adminImportSchemaCopy}
      </span>
    </button>
  );
}

function DownloadButton({
  label,
  onDownload,
}: {
  readonly label: string;
  readonly onDownload: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onDownload}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border-soft bg-white px-4 text-sm font-semibold text-ink outline-none hover:bg-cream focus-visible:ring-2 focus-visible:ring-brand-blue motion-safe:transition-colors"
    >
      <Download aria-hidden="true" className="size-4" />
      {label}
    </button>
  );
}

function ReferenceTable({
  copy,
  rows,
}: {
  readonly copy: Messages;
  readonly rows: ReadonlyArray<ReferenceFieldRow>;
}): ReactNode {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-border-soft">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border-soft bg-cream/60">
            <th scope="col" className="px-3 py-2 font-semibold">
              {copy.adminImportSchemaField}
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              {copy.adminImportSchemaRequirement}
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              {copy.adminImportSchemaType}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.field} className="border-b border-border-soft align-top last:border-0">
              <th scope="row" className="px-3 py-2 font-mono text-[13px] font-semibold">
                {row.field}
              </th>
              <td className="px-3 py-2 whitespace-nowrap">
                {row.required ? (
                  <span className="inline-flex min-h-7 items-center rounded-full border border-brand-blue/30 bg-brand-blue/10 px-2.5 text-xs font-bold text-brand-blue">
                    {copy.adminImportSchemaRequired}
                  </span>
                ) : (
                  <span className="inline-flex min-h-7 items-center rounded-full border border-border-soft bg-cream px-2.5 text-xs font-semibold text-muted">
                    {copy.adminImportSchemaOptional}
                  </span>
                )}
              </td>
              <td className="px-3 py-2">
                <p>{row.type}</p>
                {row.members === undefined ? null : (
                  <ul className="mt-1.5 space-y-1 border-l-2 border-border-soft pl-2.5">
                    {row.members.map((member) => (
                      <li key={member.name} className="text-[13px]">
                        <code className="font-mono font-semibold">{member.name}</code>
                        <span className="text-muted"> — {member.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeExample({ code }: { readonly code: string }): ReactNode {
  return (
    <div className="mt-3 min-w-0 overflow-x-auto rounded-lg border border-border-soft bg-ink/[0.03]">
      <pre className="p-3 text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const tabIcon = (tab: SchemaTab): ReactNode => {
  if (tab === "csv") {
    return <FileSpreadsheet aria-hidden="true" className="size-4" />;
  }

  if (tab === "fields") {
    return <Info aria-hidden="true" className="size-4" />;
  }

  return <FileJson aria-hidden="true" className="size-4" />;
};

const tabLabel = (copy: Messages, tab: SchemaTab): string => {
  if (tab === "csv") {
    return copy.adminImportSchemaTabCsv;
  }

  if (tab === "fields") {
    return copy.adminImportSchemaTabFields;
  }

  return copy.adminImportSchemaTabJson;
};

/**
 * Place-reference grammar preview for the field reference tab. Mirrors the
 * server `parsePlaceEntry` contract plus the new `City@ISO` form: a bare
 * reference means associated, only `:origin` claims origin.
 */
const PLACE_REF_EXAMPLES = `VN                   associated with Vietnam
VN:origin            origin: Vietnam
place:45             associated with registry place 45
place:45:popular     popular in registry place 45
Hanoi@VN             associated with Hanoi, Vietnam
Hanoi@VN:associated  associated with Hanoi, Vietnam`;

export function SchemaReference({ copy }: { readonly copy: Messages }): ReactNode {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<SchemaTab>("json");

  const selectTab = (next: SchemaTab): void => {
    setTab(next);
    document.getElementById(`schema-tab-${next}`)?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();

      const forward = event.key === "ArrowRight";

      if (tab === "json") {
        selectTab(forward ? "csv" : "fields");
      } else if (tab === "csv") {
        selectTab(forward ? "fields" : "json");
      } else {
        selectTab(forward ? "json" : "csv");
      }

      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      selectTab("json");

      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      selectTab("fields");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        aria-haspopup="dialog"
        className="inline-flex min-h-11 items-center rounded-full border border-border-soft bg-white px-5 text-sm font-bold text-ink outline-none hover:bg-cream focus-visible:ring-2 focus-visible:ring-brand-blue motion-safe:transition-colors"
      >
        {copy.adminImportSchemaButton}
      </button>
      <AdminDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);

          if (next) {
            setTab("json");
          }
        }}
        title={copy.adminImportSchemaGuideTitle}
        description={`${copy.adminImportSchemaGuideIntro} ${limitsLine(copy)}`}
        closeLabel={copy.adminImportSchemaClose}
      >
        <p className="text-sm font-semibold">{copy.adminImportSchemaQuickStart}</p>
        <p className="mt-2 flex flex-wrap gap-2">
          <DownloadButton label={copy.adminImportDownloadTemplate} onDownload={downloadTemplate} />
          <DownloadButton label={copy.adminImportDownloadSample} onDownload={downloadSample} />
        </p>

        <div
          role="tablist"
          aria-label={copy.adminImportSchemaTabsLabel}
          className="mt-4 flex flex-wrap gap-1 rounded-full border border-border-soft bg-cream/60 p-1"
        >
          {TABS.map((id) => {
            const selected = id === tab;

            return (
              <button
                key={id}
                id={`schema-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`schema-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  setTab(id);
                }}
                onKeyDown={onTabKeyDown}
                className={
                  selected
                    ? "inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-white px-4 text-sm font-bold text-ink shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-blue"
                    : "inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-semibold text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-brand-blue"
                }
              >
                {tabIcon(id)}
                {tabLabel(copy, id)}
              </button>
            );
          })}
        </div>

        {tab === "json" ? (
          <div id="schema-panel-json" role="tabpanel" aria-labelledby="schema-tab-json">
            <p className="mt-3 text-sm text-muted">{copy.adminImportSchemaJsonNote}</p>
            <p className="mt-1 text-sm font-semibold">{copy.adminImportSchemaJsonRequired}</p>
            <CodeExample code={FEASTJOURNEY_JSON_TEMPLATE.trim()} />
            <p className="mt-3 flex flex-wrap gap-2">
              <CopyButton copy={copy} text={FEASTJOURNEY_JSON_TEMPLATE} />
              <DownloadButton
                label={copy.adminImportDownloadTemplate}
                onDownload={downloadTemplate}
              />
            </p>
          </div>
        ) : null}

        {tab === "csv" ? (
          <div id="schema-panel-csv" role="tabpanel" aria-labelledby="schema-tab-csv">
            <p className="mt-3 text-sm text-muted">{copy.adminImportSchemaCsvRules}</p>
            <CodeExample code={SAMPLE_CSV.trim()} />
            <p className="mt-3 flex flex-wrap gap-2">
              <CopyButton copy={copy} text={SAMPLE_CSV} />
              <DownloadButton label={copy.adminImportDownloadSample} onDownload={downloadSample} />
            </p>
          </div>
        ) : null}

        {tab === "fields" ? (
          <div id="schema-panel-fields" role="tabpanel" aria-labelledby="schema-tab-fields">
            <ReferenceTable copy={copy} rows={RECORD_FIELDS} />
            <ReferenceTable
              copy={copy}
              rows={CSV_COLUMNS.map((column) => ({
                field: column.name,
                required: column.name === "name",
                type: column.detail,
              }))}
            />

            <h3 className="mt-5 text-base font-bold">{copy.adminPlaceGrammarTitle}</h3>
            <p className="mt-2 text-sm">{copy.adminImportPlacesFormat}</p>
            <p className="mt-1 text-sm">{copy.adminPlaceGrammarIntro}</p>
            <p className="mt-1 text-sm text-muted">{copy.adminPlaceGrammarCity}</p>
            <CodeExample code={PLACE_REF_EXAMPLES} />

            <h3 className="mt-5 text-base font-bold">{copy.adminImportSchemaSourcesTitle}</h3>
            <ul className="mt-2 space-y-1.5 text-sm">
              {SOURCE_REGISTRY.map((entry) => (
                <li key={entry.id}>
                  <span className="font-semibold">{entry.label}</span>
                  <span className="text-muted"> — {entry.reuseRule}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm">
              <span className="font-semibold">{copy.adminImportLicenseRow}: </span>
              {importLicenseSchema.options.join(", ")}.
            </p>
            <p className="mt-2 text-sm text-muted">{copy.adminImportSchemaLifecycle}</p>
          </div>
        ) : null}
      </AdminDialog>
    </>
  );
}
