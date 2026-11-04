import { useEffect, useRef, useState } from "react";

import { InteractiveMenuView } from "@/modules/restaurant-discovery/components/interactive-menu";
import {
  menuLanguageNames,
  menuScanResultsCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import { MenuPhotoViewer } from "@/modules/restaurant-discovery/components/menu-item-detail";
import type { ScanMenuLocation } from "@/modules/restaurant-discovery/components/scan-capture";
import {
  ScanCurrencyControl,
  useScanCurrency,
} from "@/modules/restaurant-discovery/components/scan-currency-control";
import { ScanEditor } from "@/modules/restaurant-discovery/components/scan-editor";
import { menuBcp47TagFor, presentScan } from "@/modules/restaurant-discovery/menu-presentation";
import {
  MenuScanClientError,
  menuScanClient,
} from "@/modules/restaurant-discovery/menu-scan-client";
import type { ScanView } from "@/modules/restaurant-discovery/menu-scan-client";
import {
  menuScanDocumentSchema,
  scanIdSchema,
} from "@/modules/restaurant-discovery/menu-scan.schema";
import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";
import { isAmount, isCurrency } from "@/shared/money";

type ResultsCopy = ReturnType<typeof menuScanResultsCopy>;

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * "Expires tomorrow" only when the stored expiry lands on the next local
 * calendar day. Any other day renders the full date; an unreadable timestamp
 * renders nothing rather than inventing urgency.
 */
const expiryText = (expiresAt: string, locale: string, copy: ResultsCopy): string | null => {
  const expiry = new Date(expiresAt);

  if (Number.isNaN(expiry.getTime())) return null;

  const diffDays = Math.round((startOfDay(expiry) - startOfDay(new Date())) / 86_400_000);

  if (diffDays === 1) return copy.expiresTomorrow;

  return `${copy.expiresLabel}: ${expiry.toLocaleString(locale)}`;
};

const priceUnclear = (document: MenuScanDocument): boolean =>
  document.items.some((item) =>
    item.variants.some(
      (variant) =>
        variant.price === null ||
        variant.price.amount === null ||
        variant.price.currency === null ||
        !isAmount(variant.price.amount) ||
        !isCurrency(variant.price.currency),
    ),
  );

const sourceCurrenciesOf = (document: MenuScanDocument): ReadonlyArray<string | null> =>
  document.items.flatMap((item) => item.variants.map((variant) => variant.price?.currency ?? null));

/** Two-step delete confirmation inside the overflow disclosure. */
function ScanDeleteAction({
  label,
  confirm,
  yes,
  no,
  busy,
  onDelete,
}: {
  readonly label: string;
  readonly confirm: string;
  readonly yes: string;
  readonly no: string;
  readonly busy: boolean;
  readonly onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming)
    return (
      <button type="button" className="scan-delete" onClick={() => setConfirming(true)}>
        {label}
      </button>
    );

  return (
    <span className="scan-delete-confirm">
      <span role="alert">{confirm}</span>
      <button type="button" className="scan-delete" disabled={busy} onClick={onDelete}>
        {yes}
      </button>
      <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
        {no}
      </button>
    </span>
  );
}

/**
 * Post-analysis results shell. Visible success heading ("Your menu is ready"
 * + "Choose what you'd like to order"), then one compact context summary
 * (venue / menu location / source → target language / dish count / currency
 * status) with a quiet expiry line, the single compact menu-wide currency
 * control, and one concise scan-wide notice (allergy/dietary always, price
 * clarity only when unclear). Dishes are the dominant element: the shared
 * InteractiveMenuView/MenuItemRow board renders immediately after the
 * notice, with MenuItemDetail on demand. Supporting groups follow —
 * Menu tools (photo thumbnails via MenuPhotoViewer, corrections), then
 * More (overflow: scan another / reload / delete with confirmation;
 * collapsed scan details). IDs, model, revision, provenance, and expiry
 * detail stay collapsed; the visible UI keeps only concise lines.
 *
 * Price research is intentionally NOT rendered here: the single research
 * trigger per screen stays with S1's ScanPriceResearch, mounted as a sibling
 * directly below this component with the same locale + items (see mount
 * note in the coordinator report). Printed prices are never replaced.
 */
export function ScanResults({
  scanId,
  menuLocation,
  onEditDish,
  onScanAnother,
  onDeleteScan,
}: {
  readonly scanId: string;
  readonly menuLocation?: ScanMenuLocation | null | undefined;
  readonly onEditDish?: ((itemKey: string) => void) | undefined;
  readonly onScanAnother?: (() => void) | undefined;
  readonly onDeleteScan?: (() => void) | undefined;
}) {
  const [view, setView] = useState<ScanView | null>(null);
  const [document, setDocument] = useState<MenuScanDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [correctionsOpen, setCorrectionsOpen] = useState(false);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const correctionsRef = useRef<HTMLDetailsElement | null>(null);

  const idValid = scanIdSchema.safeParse({ scanId }).success;

  // Render-adjust pattern (no set-state-in-effect): per-scan state resets
  // synchronously during render, so the fetch effect below only synchronizes
  // with the network and never calls setState itself.
  if (loadedId !== scanId) {
    setLoadedId(scanId);
    setView(null);
    setDocument(null);
    setDirty(false);
    setSaveError(null);
    setSaveNotice(null);
    setFailure(null);
    setLoading(true);
    setCorrectionsOpen(false);
  }

  useEffect(() => {
    const abort = new AbortController();

    if (loadedId === scanId && idValid) {
      menuScanClient.get(scanId, abort.signal).then(
        (next) => {
          if (abort.signal.aborted) return;
          setView(next);
          setDocument(next.document);
          setLoading(false);
        },
        (error) => {
          if (abort.signal.aborted) return;
          setFailure(
            error instanceof MenuScanClientError ? error.message : menuScanResultsCopy("en").failed,
          );
          setLoading(false);
        },
      );
    }

    return () => abort.abort();
  }, [scanId, loadedId, idValid]);

  const locale = view?.scan.target_language ?? "en";
  const copy = menuScanResultsCopy(locale);
  const currency = useScanCurrency(document === null ? [] : sourceCurrenciesOf(document));

  const reload = (): void => {
    setLoading(true);
    setFailure(null);
    menuScanClient.get(scanId).then(
      (next) => {
        setView(next);
        setDocument(next.document);
        setLoading(false);
      },
      (error) => {
        setFailure(error instanceof MenuScanClientError ? error.message : copy.failed);
        setLoading(false);
      },
    );
  };

  const handleEditDish = (itemKey: string): void => {
    if (onEditDish !== undefined) {
      onEditDish(itemKey);

      return;
    }

    setCorrectionsOpen(true);
    correctionsRef.current?.scrollIntoView();
  };

  const saveRevision = (): void => {
    if (document === null || view === null || view.scan.current_revision === null) return;

    const parsed = menuScanDocumentSchema.safeParse(document);

    if (!parsed.success) {
      setSaveNotice(null);
      setSaveError(parsed.error.issues.map((issue) => issue.message).join("; "));

      return;
    }

    const expectedRevision = view.scan.current_revision;
    const currentId = view.scan.id;
    setSaving(true);
    setSaveError(null);
    setSaveNotice(null);
    void menuScanClient
      .revise({ scanId: currentId, expectedRevision, document: parsed.data })
      .then(
        (next) => {
          setView(next);
          setDocument(next.document);
          setDirty(false);
          setSaveNotice(copy.saved);
        },
        (error) => {
          setSaveError(error instanceof Error ? error.message : copy.failed);
        },
      )
      .finally(() => setSaving(false));
  };

  if (!idValid)
    return (
      <div role="alert" className="scan-results-error">
        <p>{menuScanResultsCopy("en").failed}</p>
      </div>
    );

  if (loading) return <output aria-live="polite">{copy.loading}</output>;

  if (failure !== null || view === null)
    return (
      <div role="alert" className="scan-results-error">
        <p>{failure ?? copy.failed}</p>
        <button type="button" className="menu-order-primary" onClick={reload}>
          {copy.retry}
        </button>
      </div>
    );

  if (document === null) return <output aria-live="polite">{copy.notReady}</output>;

  const venueName = view.scan.venue_name;

  const expiry = expiryText(view.scan.expires_at, locale, copy);

  const assets = [...view.assets].toSorted((a, b) => a.page_number - b.page_number);

  const revisionModelText = view.revision?.model ?? "";
  const revisionModel = revisionModelText.trim() !== "" ? revisionModelText : null;

  const revisionNumber = view.revision?.number ?? view.scan.current_revision;

  const documentSource = document.sourceLanguage;

  const sourceName =
    documentSource === null ? null : (menuLanguageNames.get(documentSource) ?? documentSource);

  const targetName = menuLanguageNames.get(document.targetLanguage) ?? document.targetLanguage;

  const contextLine = [
    venueName === null ? null : copy.atVenue.replace("{name}", venueName),
    menuLocation?.label ?? null,
    sourceName === null
      ? null
      : copy.contextLanguages.replace("{source}", sourceName).replace("{target}", targetName),
    document.items.length.toLocaleString(locale),
    currency.enabled && currency.target !== ""
      ? copy.currencyConverted.replace("{target}", currency.target)
      : copy.currencyOriginalOnly,
  ]
    .flatMap((part) => (part === null ? [] : [part]))
    .join(" · ");

  // One concise scan-wide notice: allergy/dietary wording is always
  // visible but quiet; the unclear-price sentence joins it only when at
  // least one variant lacks a usable price.
  const noticeText = priceUnclear(document)
    ? `${copy.dietNote} ${copy.priceUnclear}`
    : copy.dietNote;

  return (
    <article className="scan-results" lang={menuBcp47TagFor(locale)}>
      <header className="scan-results-head">
        <h1 id="scan-results-title" tabIndex={-1} className="font-display">
          {copy.ready}
        </h1>
        <p>{copy.subtitle}</p>
        <p className="scan-results-context">{contextLine}</p>
        <ScanCurrencyControl
          sources={sourceCurrenciesOf(document)}
          locale={locale}
          state={currency}
        />
        {expiry !== null && <p className="scan-results-expiry">{expiry}</p>}
      </header>
      <p className="scan-results-diet">{noticeText}</p>
      <InteractiveMenuView
        key={`${view.scan.id}:${view.scan.current_revision ?? "draft"}`}
        menu={presentScan(document, venueName)}
        locale={locale}
        photoUrl={(assetId) => `/api/menu-scans?scanId=${view.scan.id}&assetId=${assetId}`}
        rates={currency.rates}
        onEditDish={handleEditDish}
      />
      {/* Price-research mount point (S1): render ScanPriceResearch as a
          page-level sibling of ScanResults (aside column of the results
          grid) with locale + items. ScanResults renders no research
          trigger so the screen keeps exactly one (single-trigger rule). */}
      {assets.length > 0 && (
        <section className="scan-results-photos" aria-label={copy.photosTitle}>
          <h2>{copy.photosTitle}</h2>
          <p>{copy.photosHelp}</p>
          <MenuPhotoViewer
            photos={assets.map((asset) => ({ assetId: asset.id, page: asset.page_number }))}
            photoUrl={(assetId) => `/api/menu-scans?scanId=${view.scan.id}&assetId=${assetId}`}
            locale={locale}
          />
        </section>
      )}
      <details
        ref={correctionsRef}
        className="scan-results-corrections"
        open={correctionsOpen}
        onToggle={(event) => setCorrectionsOpen(event.currentTarget.open)}
      >
        <summary>{copy.corrections}</summary>
        <p>{copy.correctionsHelp}</p>
        <ScanEditor
          document={document}
          onChange={(next) => {
            setDocument(next);
            setDirty(true);
            setSaveNotice(null);
          }}
        />
        {dirty && <output>{copy.unsavedChanges}</output>}
        {saveNotice !== null && <output aria-live="polite">{saveNotice}</output>}
        {saveError !== null && <p role="alert">{saveError}</p>}
        <button
          type="button"
          className="menu-order-primary"
          disabled={saving || !dirty}
          onClick={saveRevision}
        >
          {copy.saveFixes}
        </button>
      </details>
      <details className="scan-results-overflow">
        <summary>{copy.overflowLabel}</summary>
        <div className="scan-results-overflow-actions">
          {onScanAnother !== undefined && (
            <button type="button" onClick={onScanAnother}>
              {copy.scanAnother}
            </button>
          )}
          <button type="button" onClick={reload}>
            {copy.reloadAction}
          </button>
          {onDeleteScan !== undefined && (
            <ScanDeleteAction
              label={copy.deleteAction}
              confirm={copy.deleteConfirm}
              yes={copy.deleteYes}
              no={copy.deleteNo}
              busy={loading}
              onDelete={onDeleteScan}
            />
          )}
        </div>
      </details>
      <details className="scan-results-meta">
        <summary>{copy.techDetails}</summary>
        <dl>
          <div>
            <dt>{copy.metaScan}</dt>
            <dd>{view.scan.id}</dd>
          </div>
          {revisionNumber !== null && (
            <div>
              <dt>{copy.metaRevision}</dt>
              <dd>{revisionNumber}</dd>
            </div>
          )}
          {revisionModel !== null && (
            <div>
              <dt>{copy.metaModel}</dt>
              <dd>{revisionModel}</dd>
            </div>
          )}
          <div>
            <dt>{copy.detailsProvenance}</dt>
            <dd>{view.revision?.origin ?? copy.notReady}</dd>
          </div>
          <div>
            <dt>{copy.detailsExpiry}</dt>
            <dd>
              <time dateTime={view.scan.expires_at}>
                {new Date(view.scan.expires_at).toLocaleString(locale)}
              </time>
            </dd>
          </div>
          {assets.length > 0 && (
            <div>
              <dt>{copy.metaPhotos}</dt>
              <dd>
                <ul>
                  {assets.map((asset) => (
                    <li key={asset.id}>{asset.id}</li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>
      </details>
    </article>
  );
}
