import { useEffect, useRef, useState, type ReactNode } from "react";

import { InteractiveMenuView } from "@/modules/restaurant-discovery/components/interactive-menu";
import {
  menuResultsCopy,
  menuScanResultsCopy,
} from "@/modules/restaurant-discovery/components/menu-copy";
import type { ScanMenuLocation } from "@/modules/restaurant-discovery/components/scan-capture";
import {
  ScanCurrencyControl,
  useScanCurrency,
} from "@/modules/restaurant-discovery/components/scan-currency-control";
import { ScanEditor } from "@/modules/restaurant-discovery/components/scan-editor";
import {
  ScanResultsHeading,
  ScanResultsSummary,
} from "@/modules/restaurant-discovery/components/scan-results-summary";
import { SearchableCurrencyPicker } from "@/modules/restaurant-discovery/components/searchable-currency-picker";
import {
  menuBcp47TagFor,
  presentScan,
  priceTrustOf,
} from "@/modules/restaurant-discovery/menu-presentation";
import { normalizeCurrencyContext } from "@/modules/restaurant-discovery/menu-price-evidence";
import { interpretPrintedPrice } from "@/modules/restaurant-discovery/menu-price-interpretation";
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
import { currencyMinorUnits } from "@/shared/currencies";

const sourceCurrenciesOf = (
  document: MenuScanDocument,
  menuCountry: string | null,
): ReadonlyArray<string | null> =>
  document.items.flatMap((item) =>
    item.variants.flatMap((variant) => {
      if (variant.price === null) return [];
      const price = interpretPrintedPrice(variant.price, menuCountry);

      return price.amount !== null &&
        price.currency !== null &&
        price.association !== "ambiguous" &&
        price.association !== "unavailable" &&
        priceTrustOf(price) !== "unknown"
        ? [price.currency]
        : [];
    }),
  );

/** Private menu browsing with separate correction and currency-confirmation dialogs. */
export function ScanResults({
  locale: interfaceLocale,
  scanId,
  menuLocation,
  onEditDish,
  onRevisionSaved,
  toolsTrigger,
}: {
  readonly locale?: string | undefined;
  readonly scanId: string;
  readonly menuLocation?: ScanMenuLocation | null | undefined;
  readonly onEditDish?: ((itemKey: string) => void) | undefined;
  readonly onRevisionSaved?: ((view: ScanView) => void) | undefined;
  /** Secondary-workspace trigger rendered in the results header row. */
  readonly toolsTrigger?: ReactNode | undefined;
}) {
  const [view, setView] = useState<ScanView | null>(null);
  const [document, setDocument] = useState<MenuScanDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const correctionsRef = useRef<HTMLDialogElement | null>(null);
  const currencyDialog = useRef<HTMLDialogElement | null>(null);
  const [editItemId, setEditItemId] = useState<string | null>(null);
  const [confirmedCurrency, setConfirmedCurrency] = useState("");

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

  const locale = interfaceLocale ?? view?.scan.target_language ?? "en";
  const ui = menuResultsCopy(locale);
  const copy = menuScanResultsCopy(locale);

  // Weak visitor-indicated menu country (server-resolved place evidence
  // lives server-side only). Threaded identically through presentation,
  // currency sources, and the correction editor so display, summary, and
  // repair never disagree about what the printed text means.
  const menuCountry = normalizeCurrencyContext({
    menuCountry: menuLocation?.country ?? null,
  }).menuCountry;

  const currency = useScanCurrency(
    document === null ? [] : sourceCurrenciesOf(document, menuCountry),
  );

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

    setEditItemId(itemKey);
    correctionsRef.current?.showModal();
  };

  const saveRevision = (nextDocument: MenuScanDocument | null = document): void => {
    if (document === null || view === null || view.scan.current_revision === null) return;

    const parsed = menuScanDocumentSchema.safeParse(nextDocument);

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
          onRevisionSaved?.(next);
          setSaveNotice(copy.saved);
          correctionsRef.current?.close();
          currencyDialog.current?.close();
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

  const assets = [...view.assets].toSorted((a, b) => a.page_number - b.page_number);

  const documentSource = document.sourceLanguage;

  const languageNames = new Intl.DisplayNames(locale, { type: "language" });

  const sourceName =
    documentSource === null ? null : (languageNames.of(documentSource) ?? documentSource);

  const targetName = languageNames.of(document.targetLanguage) ?? document.targetLanguage;

  const menu = presentScan(document, venueName, menuCountry);

  const noticeText = copy.dietNote;

  const unresolved = document.items
    .flatMap((item) => item.variants)
    .filter((variant) => {
      const price = variant.price === null ? null : interpretPrintedPrice(variant.price);

      return (
        price !== null &&
        price.rawText.trim() !== "" &&
        ((price.currency === null &&
          /^[\d.,\s]+[kK]?(?:\s*\/[^/]+)?$/.test(price.rawText.trim())) ||
          price.currencyProvenance === "inferred") &&
        price.association !== "ambiguous" &&
        price.association !== "unavailable"
      );
    });

  const observedCurrencies = [
    ...new Set(
      unresolved.flatMap((variant) => (variant.price?.currency ? [variant.price.currency] : [])),
    ),
  ];

  let suggestedCurrency = "";

  if (observedCurrencies.length === 1) suggestedCurrency = observedCurrencies[0] ?? "";
  else if (menuLocation?.country === "VN") suggestedCurrency = "VND";
  const menuCurrency = confirmedCurrency || suggestedCurrency;

  const confirmCurrency = (): void => {
    if (menuCurrency === "") return;

    const eligible = new Set(
      unresolved
        .filter(
          (variant) => variant.price?.currency === null || variant.price?.currency === menuCurrency,
        )
        .map((variant) => variant.id),
    );

    const next = {
      ...document,
      items: document.items.map((item) => ({
        ...item,
        variants: item.variants.map((variant) => {
          if (!eligible.has(variant.id) || variant.price === null) return variant;

          return {
            ...variant,
            price: {
              ...interpretPrintedPrice(variant.price, menuCountry),
              currency: menuCurrency,
              currencyProvenance: "user-confirmed" as const,
            },
          };
        }),
      })),
    };

    saveRevision(next);
  };

  return (
    <article className="grid min-w-0 gap-5 break-words text-ink" lang={menuBcp47TagFor(locale)}>
      <ScanResultsHeading
        locale={locale}
        itemCount={document.items.length}
        onEditMenu={() => handleEditDish(document.items[0]?.id ?? "")}
        toolsTrigger={toolsTrigger}
      />
      <ScanResultsSummary
        menu={menu}
        photos={assets.map((asset) => ({ assetId: asset.id, page: asset.page_number }))}
        photoUrl={(assetId) => `/api/menu-scans?scanId=${view.scan.id}&assetId=${assetId}`}
        sourceName={sourceName}
        targetName={targetName}
        locale={locale}
        location={menuLocation?.label ?? venueName}
      />
      {sourceCurrenciesOf(document, menuCountry).length > 0 && (
        <ScanCurrencyControl
          sources={sourceCurrenciesOf(document, menuCountry)}
          locale={locale}
          state={currency}
        />
      )}
      <p className="m-0 text-xs leading-relaxed text-muted">{noticeText}</p>
      {unresolved.length > 0 && (
        <>
          <button
            type="button"
            className="menu-results-edit"
            onClick={() => currencyDialog.current?.showModal()}
          >
            {ui.confirmCurrency}
          </button>
          <dialog
            ref={currencyDialog}
            className="menu-waiter-dialog"
            aria-label={ui.confirmCurrency}
          >
            <form method="dialog">
              <button className="menu-order-back">{ui.close}</button>
            </form>
            <section
              className="grid gap-3 py-4 [&_p]:m-0 [&_p]:text-sm [&_p]:leading-relaxed"
              aria-label={ui.confirmCurrency}
            >
              <p>{ui.confirmExplanation}</p>
              {suggestedCurrency !== "" && (
                <p>
                  {ui.suggestion}: {suggestedCurrency}. {ui.confirmSuggestion}
                </p>
              )}
              <SearchableCurrencyPicker
                value={menuCurrency}
                codes={[...currencyMinorUnits.keys()]}
                locale={locale}
                label={ui.currency}
                placeholder={ui.currency}
                onChange={setConfirmedCurrency}
              />
              <button
                type="button"
                className="menu-order-back"
                disabled={saving || menuCurrency === ""}
                onClick={confirmCurrency}
              >
                {ui.confirmCurrency}
              </button>
            </section>
          </dialog>
        </>
      )}
      {saveNotice !== null && <output aria-live="polite">{saveNotice}</output>}
      {saveError !== null && <p role="alert">{saveError}</p>}
      <InteractiveMenuView
        key={view.scan.id}
        menu={menu}
        locale={locale}
        photoUrl={(assetId) => `/api/menu-scans?scanId=${view.scan.id}&assetId=${assetId}`}
        rates={currency.rates}
        onEditDish={handleEditDish}
      />
      <dialog
        ref={correctionsRef}
        className="menu-waiter-dialog"
        aria-label={copy.corrections}
        onCancel={(event) => {
          if (saving) {
            event.preventDefault();

            return;
          }

          setDocument(view.document);
          setDirty(false);
        }}
      >
        <button
          type="button"
          className="menu-order-back"
          disabled={saving}
          onClick={() => {
            setDocument(view.document);
            setDirty(false);
            correctionsRef.current?.close();
          }}
        >
          {ui.cancel}
        </button>
        <ScanEditor
          locale={locale}
          key={editItemId}
          initialItemId={editItemId}
          document={document}
          menuCountry={menuCountry}
          onChange={(next) => {
            setDocument(next);
            setDirty(true);
            setSaveNotice(null);
          }}
        />
        {dirty && <output>{copy.unsavedChanges}</output>}
        {saveError !== null && <p role="alert">{saveError}</p>}
        <button
          type="button"
          className="menu-order-primary"
          disabled={saving || !dirty}
          onClick={() => saveRevision()}
        >
          {copy.saveFixes}
        </button>
      </dialog>
    </article>
  );
}
