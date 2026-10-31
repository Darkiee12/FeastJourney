import { useState } from "react";

import { InteractiveMenuView } from "@/modules/restaurant-discovery/components/interactive-menu";
import { menuCopy, menuLanguageNames } from "@/modules/restaurant-discovery/components/menu-copy";
import { presentDraft } from "@/modules/restaurant-discovery/menu-presentation";
import type {
  MenuDraft,
  MenuDraftItem,
  MenuDraftVariant,
} from "@/modules/restaurant-discovery/menu-presentation";
import {
  menuLanguages,
  menuScanDocumentSchema,
  scanPriceSchema,
} from "@/modules/restaurant-discovery/menu-scan.schema";
import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";
import { isAmount, isCurrency } from "@/shared/money";

type ScanItem = MenuScanDocument["items"][number];

type ScanVariant = ScanItem["variants"][number];

function VariantEditor({
  variant,
  locale,
  sourceLanguage,
  onChange,
}: {
  readonly variant: ScanVariant;
  readonly locale: string;
  readonly sourceLanguage: string;
  readonly onChange: (variant: ScanVariant) => void;
}) {
  const copy = menuCopy(locale);
  const price = variant.price;
  const priceValid = price === null || scanPriceSchema.safeParse(price).success;

  return (
    <div className="scan-editor-variant">
      {variant.customerAdded === true && <p>{copy.customerAdded}</p>}
      <label htmlFor={`edit-variant-${variant.id}`}>{copy.originalVariant}</label>
      <input
        id={`edit-variant-${variant.id}`}
        lang={sourceLanguage}
        maxLength={200}
        value={variant.originalLabel}
        onChange={(event) => onChange({ ...variant, originalLabel: event.target.value })}
      />
      <label htmlFor={`edit-variant-translation-${variant.id}`}>{copy.translatedVariant}</label>
      <input
        id={`edit-variant-translation-${variant.id}`}
        lang={locale}
        maxLength={300}
        value={variant.translatedLabel ?? ""}
        onChange={(event) =>
          onChange({
            ...variant,
            translatedLabel: event.target.value === "" ? null : event.target.value,
          })
        }
      />
      {price === null ? (
        <>
          <p>{copy.noPrice}</p>
          <button
            type="button"
            onClick={() =>
              onChange({
                ...variant,
                price: { rawText: "", amount: null, currency: null, taxTreatment: "unknown" },
              })
            }
          >
            {copy.enterPrice}
          </button>
        </>
      ) : (
        <>
          <label htmlFor={`edit-raw-price-${variant.id}`}>{copy.rawPrice}</label>
          <input
            id={`edit-raw-price-${variant.id}`}
            maxLength={200}
            value={price.rawText}
            onChange={(event) =>
              onChange({ ...variant, price: { ...price, rawText: event.target.value } })
            }
          />
          <label htmlFor={`edit-amount-${variant.id}`}>{copy.exactAmount}</label>
          <input
            id={`edit-amount-${variant.id}`}
            inputMode="decimal"
            maxLength={49}
            aria-invalid={!priceValid}
            value={price.amount ?? ""}
            onChange={(event) =>
              onChange({
                ...variant,
                price: { ...price, amount: event.target.value === "" ? null : event.target.value },
              })
            }
          />
          <label htmlFor={`edit-currency-${variant.id}`}>{copy.currency}</label>
          <input
            id={`edit-currency-${variant.id}`}
            maxLength={3}
            autoCapitalize="characters"
            aria-invalid={!priceValid}
            value={price.currency ?? ""}
            onChange={(event) =>
              onChange({
                ...variant,
                price: {
                  ...price,
                  currency: event.target.value === "" ? null : event.target.value.toUpperCase(),
                },
              })
            }
          />
          <label htmlFor={`edit-tax-${variant.id}`}>{copy.taxes}</label>
          <select
            id={`edit-tax-${variant.id}`}
            value={price.taxTreatment}
            onChange={(event) => {
              const treatment = scanPriceSchema.shape.taxTreatment.parse(event.target.value);
              onChange({ ...variant, price: { ...price, taxTreatment: treatment } });
            }}
          >
            <option value="unknown">{copy.unknown}</option>
            <option value="included">{copy.included}</option>
            <option value="excluded">{copy.excluded}</option>
          </select>
          <button type="button" onClick={() => onChange({ ...variant, price: null })}>
            {copy.clearPrice}
          </button>
        </>
      )}
    </div>
  );
}

export function ScanEditor({
  document,
  onChange,
}: {
  readonly document: MenuScanDocument;
  readonly onChange: (document: MenuScanDocument) => void;
}) {
  const copy = menuCopy(document.targetLanguage);
  const valid = menuScanDocumentSchema.safeParse(document).success;

  const updateItem = (next: ScanItem): void =>
    onChange({
      ...document,
      items: document.items.map((item) => (item.id === next.id ? next : item)),
    });

  return (
    <section
      className="scan-editor"
      aria-label={copy.edit}
      lang={document.targetLanguage === "vi" ? "vi" : "en"}
    >
      <h2 className="font-display text-3xl">{copy.edit}</h2>
      <p>{copy.editHelp}</p>
      <output>{valid ? copy.valid : copy.invalid}</output>
      {document.items.map((item) => (
        <details className="scan-editor-item" key={item.id}>
          <summary lang={document.sourceLanguage ?? "und"}>{item.originalName}</summary>
          <label htmlFor={`edit-name-${item.id}`}>{copy.originalName}</label>
          <input
            id={`edit-name-${item.id}`}
            required
            maxLength={300}
            lang={document.sourceLanguage ?? "und"}
            value={item.originalName}
            onChange={(event) => updateItem({ ...item, originalName: event.target.value })}
          />
          <label htmlFor={`edit-translation-${item.id}`}>{copy.translatedName}</label>
          <input
            id={`edit-translation-${item.id}`}
            maxLength={300}
            lang={document.targetLanguage}
            value={item.translatedName ?? ""}
            onChange={(event) =>
              updateItem({
                ...item,
                translatedName: event.target.value === "" ? null : event.target.value,
              })
            }
          />
          <label htmlFor={`edit-description-${item.id}`}>{copy.originalDescription}</label>
          <textarea
            id={`edit-description-${item.id}`}
            maxLength={3000}
            lang={document.sourceLanguage ?? "und"}
            value={item.originalDescription ?? ""}
            onChange={(event) =>
              updateItem({
                ...item,
                originalDescription: event.target.value === "" ? null : event.target.value,
              })
            }
          />
          <label htmlFor={`edit-description-translation-${item.id}`}>
            {copy.translatedDescription}
          </label>
          <textarea
            id={`edit-description-translation-${item.id}`}
            maxLength={3000}
            lang={document.targetLanguage}
            value={item.translatedDescription ?? ""}
            onChange={(event) =>
              updateItem({
                ...item,
                translatedDescription: event.target.value === "" ? null : event.target.value,
              })
            }
          />
          {item.variants.map((variant) => (
            <VariantEditor
              key={variant.id}
              variant={variant}
              locale={document.targetLanguage}
              sourceLanguage={document.sourceLanguage ?? "und"}
              onChange={(next) =>
                updateItem({
                  ...item,
                  variants: item.variants.map((entry) => (entry.id === next.id ? next : entry)),
                })
              }
            />
          ))}
          <div className="scan-editor-actions">
            <button
              type="button"
              onClick={() =>
                updateItem({
                  ...item,
                  variants: [
                    ...item.variants,
                    {
                      id: crypto.randomUUID(),
                      customerAdded: true,
                      originalLabel: "",
                      translatedLabel: null,
                      price: null,
                    },
                  ],
                })
              }
            >
              {copy.addVariant}
            </button>
            {item.variants.length > 1 &&
              item.variants.map((entry) => (
                <button
                  key={`remove-${entry.id}`}
                  type="button"
                  aria-label={`${copy.removeVariant}: ${entry.originalLabel}`}
                  onClick={() =>
                    updateItem({
                      ...item,
                      variants: item.variants.filter((variant) => variant.id !== entry.id),
                    })
                  }
                >
                  {copy.removeVariant}: {entry.originalLabel || entry.id.slice(0, 8)}
                </button>
              ))}
          </div>
          {item.customerAdded === true && <p>{copy.customerAdded}</p>}
          <button
            type="button"
            onClick={() =>
              onChange({
                ...document,
                items: document.items.filter((entry) => entry.id !== item.id),
              })
            }
          >
            {copy.removeDish}
          </button>
        </details>
      ))}
      <button
        type="button"
        onClick={() => {
          const page = document.pages[0];

          if (page === undefined) return;

          onChange({
            ...document,
            items: [
              ...document.items,
              {
                id: crypto.randomUUID(),
                customerAdded: true,
                originalName: "",
                translatedName: null,
                originalDescription: null,
                translatedDescription: null,
                explanatorySummary: null,
                ingredients: null,
                sourceReferences: [{ assetId: page.assetId, region: null }],
                uncertainties: [],
                variants: [
                  {
                    id: crypto.randomUUID(),
                    customerAdded: true,
                    originalLabel: "",
                    translatedLabel: null,
                    price: null,
                  },
                ],
              },
            ],
          });
        }}
      >
        {copy.addDish}
      </button>
    </section>
  );
}

export interface DishCandidate {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly categories: ReadonlyArray<string>;
  readonly places: ReadonlyArray<string>;
}

const draftPriceValid = (variant: MenuDraftVariant): boolean => {
  const price = variant.price;

  if (price === null) return true;

  if (price.amount !== null && !isAmount(price.amount)) return false;

  if (price.currency !== null && !isCurrency(price.currency)) return false;

  return true;
};

const draftValid = (draft: MenuDraft): boolean =>
  draft.menuName.trim() !== "" &&
  draft.items.length > 0 &&
  draft.items.every(
    (item) =>
      item.name.trim() !== "" && item.variants.length > 0 && item.variants.every(draftPriceValid),
  );

function DraftVariantEditor({
  variant,
  locale,
  sourceLanguage,
  onChange,
  onRemove,
  canRemove,
}: {
  readonly variant: MenuDraftVariant;
  readonly locale: string;
  readonly sourceLanguage: string;
  readonly onChange: (variant: MenuDraftVariant) => void;
  readonly onRemove: () => void;
  readonly canRemove: boolean;
}) {
  const copy = menuCopy(locale);
  const price = variant.price;
  const valid = draftPriceValid(variant);

  return (
    <div className="scan-editor-variant">
      <label htmlFor={`draft-variant-${variant.clientKey}`}>{copy.originalVariant}</label>
      <input
        id={`draft-variant-${variant.clientKey}`}
        lang={sourceLanguage}
        maxLength={200}
        value={variant.label}
        onChange={(event) => onChange({ ...variant, label: event.target.value })}
      />
      <label htmlFor={`draft-variant-translation-${variant.clientKey}`}>
        {copy.translatedVariant}
      </label>
      <input
        id={`draft-variant-translation-${variant.clientKey}`}
        lang={locale}
        maxLength={300}
        value={variant.translatedLabel ?? ""}
        onChange={(event) =>
          onChange({
            ...variant,
            translatedLabel: event.target.value === "" ? undefined : event.target.value,
          })
        }
      />
      {price === null ? (
        <>
          <p>{copy.noPrice}</p>
          <button
            type="button"
            onClick={() =>
              onChange({
                ...variant,
                price: {
                  rawText: "",
                  amount: null,
                  currency: null,
                  channel: "dine_in",
                  taxTreatment: "unknown",
                },
              })
            }
          >
            {copy.enterPrice}
          </button>
        </>
      ) : (
        <>
          <label htmlFor={`draft-raw-price-${variant.clientKey}`}>{copy.rawPrice}</label>
          <input
            id={`draft-raw-price-${variant.clientKey}`}
            maxLength={200}
            value={price.rawText}
            onChange={(event) =>
              onChange({ ...variant, price: { ...price, rawText: event.target.value } })
            }
          />
          <label htmlFor={`draft-amount-${variant.clientKey}`}>{copy.exactAmount}</label>
          <input
            id={`draft-amount-${variant.clientKey}`}
            inputMode="decimal"
            maxLength={49}
            aria-invalid={!valid}
            value={price.amount ?? ""}
            onChange={(event) =>
              onChange({
                ...variant,
                price: { ...price, amount: event.target.value === "" ? null : event.target.value },
              })
            }
          />
          <label htmlFor={`draft-currency-${variant.clientKey}`}>{copy.currency}</label>
          <input
            id={`draft-currency-${variant.clientKey}`}
            maxLength={3}
            autoCapitalize="characters"
            aria-invalid={!valid}
            value={price.currency ?? ""}
            onChange={(event) =>
              onChange({
                ...variant,
                price: {
                  ...price,
                  currency: event.target.value === "" ? null : event.target.value.toUpperCase(),
                },
              })
            }
          />
          <label htmlFor={`draft-channel-${variant.clientKey}`}>
            {locale === "vi" ? "Giá này áp dụng ở đâu" : "Where this price applies"}
          </label>
          <select
            id={`draft-channel-${variant.clientKey}`}
            value={price.channel}
            onChange={(event) =>
              onChange({ ...variant, price: { ...price, channel: event.target.value } })
            }
          >
            <option value="dine_in">{locale === "vi" ? "Tại quán" : "Dine in"}</option>
            <option value="takeaway">{locale === "vi" ? "Mang đi" : "Takeaway"}</option>
            <option value="delivery">{locale === "vi" ? "Giao hàng" : "Delivery"}</option>
          </select>
          <label htmlFor={`draft-tax-${variant.clientKey}`}>{copy.taxes}</label>
          <select
            id={`draft-tax-${variant.clientKey}`}
            value={price.taxTreatment}
            onChange={(event) =>
              onChange({ ...variant, price: { ...price, taxTreatment: event.target.value } })
            }
          >
            <option value="unknown">{copy.unknown}</option>
            <option value="included">{copy.included}</option>
            <option value="excluded">{copy.excluded}</option>
          </select>
          <button type="button" onClick={() => onChange({ ...variant, price: null })}>
            {copy.clearPrice}
          </button>
        </>
      )}
      {canRemove && (
        <button type="button" onClick={onRemove}>
          {copy.removeVariant}
        </button>
      )}
    </div>
  );
}

function DraftItemEditor({
  item,
  sections,
  locale,
  sourceLanguage,
  candidates,
  lookupFor,
  suppressedIds,
  resolving,
  onResolveDish,
  onChange,
  onRemove,
}: {
  readonly item: MenuDraftItem;
  readonly sections: ReadonlyArray<string>;
  readonly locale: string;
  readonly sourceLanguage: string;
  readonly candidates: ReadonlyArray<DishCandidate>;
  readonly lookupFor: string | null;
  readonly suppressedIds: ReadonlyArray<string>;
  readonly resolving: boolean;
  readonly onResolveDish: (clientKey: string, query: string) => void;
  readonly onChange: (item: MenuDraftItem) => void;
  readonly onRemove: () => void;
}) {
  const copy = menuCopy(locale);
  const [lookup, setLookup] = useState("");
  const showingCandidates = lookupFor === item.clientKey;

  return (
    <details className="scan-editor-item">
      <summary lang={sourceLanguage}>{item.name === "" ? copy.noPrice : item.name}</summary>
      <label htmlFor={`draft-name-${item.clientKey}`}>{copy.originalName}</label>
      <input
        id={`draft-name-${item.clientKey}`}
        required
        maxLength={300}
        lang={sourceLanguage}
        value={item.name}
        onChange={(event) => onChange({ ...item, name: event.target.value })}
      />
      <label htmlFor={`draft-translation-${item.clientKey}`}>{copy.translatedName}</label>
      <input
        id={`draft-translation-${item.clientKey}`}
        maxLength={300}
        lang={locale}
        value={item.translatedName ?? ""}
        onChange={(event) =>
          onChange({
            ...item,
            translatedName: event.target.value === "" ? undefined : event.target.value,
          })
        }
      />
      <label htmlFor={`draft-description-${item.clientKey}`}>{copy.originalDescription}</label>
      <textarea
        id={`draft-description-${item.clientKey}`}
        maxLength={3000}
        lang={sourceLanguage}
        value={item.description}
        onChange={(event) => onChange({ ...item, description: event.target.value })}
      />
      <label htmlFor={`draft-description-translation-${item.clientKey}`}>
        {copy.translatedDescription}
      </label>
      <textarea
        id={`draft-description-translation-${item.clientKey}`}
        maxLength={3000}
        lang={locale}
        value={item.translatedDescription ?? ""}
        onChange={(event) =>
          onChange({
            ...item,
            translatedDescription: event.target.value === "" ? undefined : event.target.value,
          })
        }
      />
      <label htmlFor={`draft-section-${item.clientKey}`}>{copy.sectionLabel}</label>
      <input
        id={`draft-section-${item.clientKey}`}
        maxLength={80}
        list={`draft-sections-${item.clientKey}`}
        value={item.section ?? ""}
        aria-describedby={`draft-section-help-${item.clientKey}`}
        onChange={(event) =>
          onChange({
            ...item,
            section: event.target.value.trim() === "" ? null : event.target.value.trim(),
          })
        }
      />
      <datalist id={`draft-sections-${item.clientKey}`} aria-label={copy.sectionLabel}>
        {sections.map((section) => (
          <option key={section} value={section}>
            {section}
          </option>
        ))}
      </datalist>
      <p id={`draft-section-help-${item.clientKey}`}>{copy.sectionHelp}</p>
      <div className="scan-editor-dish-link">
        <h4>{copy.dishLink}</h4>
        {item.dish === undefined || item.dish === null ? (
          <>
            <label htmlFor={`draft-dish-${item.clientKey}`}>{copy.dishLookup}</label>
            <input
              id={`draft-dish-${item.clientKey}`}
              maxLength={100}
              value={lookup}
              aria-describedby={`draft-dish-help-${item.clientKey}`}
              onChange={(event) => setLookup(event.target.value)}
            />
            <p id={`draft-dish-help-${item.clientKey}`}>{copy.dishLookupHelp}</p>
            <button
              type="button"
              disabled={resolving || lookup.trim() === ""}
              onClick={() => onResolveDish(item.clientKey, lookup.trim())}
            >
              {copy.resolveDish}
            </button>
            {showingCandidates && (
              <ul>
                {candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <strong lang={sourceLanguage}>{candidate.displayName}</strong>
                    {candidate.categories.length > 0 && (
                      <span> · {candidate.categories.join(", ")}</span>
                    )}
                    {candidate.places.length > 0 && <span> · {candidate.places.join(", ")}</span>}
                    <button
                      type="button"
                      onClick={() =>
                        onChange({
                          ...item,
                          dish: {
                            id: candidate.id,
                            slug: candidate.slug,
                            displayName: candidate.displayName,
                          },
                        })
                      }
                    >
                      {copy.dishLink}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {showingCandidates && suppressedIds.length > 0 && (
              <p>
                {copy.suppressedNote}: {suppressedIds.join(", ")}
              </p>
            )}
          </>
        ) : (
          <>
            <p>
              <strong>{item.dish.displayName}</strong> · {item.dish.slug}
            </p>
            <button type="button" onClick={() => onChange({ ...item, dish: null })}>
              {copy.unlinkDish}
            </button>
          </>
        )}
      </div>
      {item.variants.map((variant) => (
        <DraftVariantEditor
          key={variant.clientKey}
          variant={variant}
          locale={locale}
          sourceLanguage={sourceLanguage}
          onChange={(next) =>
            onChange({
              ...item,
              variants: item.variants.map((entry) =>
                entry.clientKey === next.clientKey ? next : entry,
              ),
            })
          }
          onRemove={() =>
            onChange({
              ...item,
              variants: item.variants.filter((entry) => entry.clientKey !== variant.clientKey),
            })
          }
          canRemove={item.variants.length > 1}
        />
      ))}
      <div className="scan-editor-actions">
        <button
          type="button"
          onClick={() =>
            onChange({
              ...item,
              variants: [
                ...item.variants,
                {
                  clientKey: crypto.randomUUID(),
                  label: "",
                  price: null,
                },
              ],
            })
          }
        >
          {copy.addVariant}
        </button>
        <button type="button" onClick={onRemove}>
          {copy.removeDish}
        </button>
      </div>
    </details>
  );
}

export function CuratorMenuEditor({
  draft,
  onChange,
  candidates,
  lookupFor,
  suppressedIds,
  resolving,
  onResolveDish,
  canSubmit,
  submitting,
  onSubmit,
  submitError,
}: {
  readonly draft: MenuDraft;
  readonly onChange: (draft: MenuDraft) => void;
  readonly candidates: ReadonlyArray<DishCandidate>;
  readonly lookupFor: string | null;
  readonly suppressedIds: ReadonlyArray<string>;
  readonly resolving: boolean;
  readonly onResolveDish: (clientKey: string, query: string) => void;
  readonly canSubmit: boolean;
  readonly submitting: boolean;
  readonly onSubmit: () => void;
  readonly submitError: string | null;
}) {
  const copy = menuCopy(draft.targetLanguage);
  const valid = draftValid(draft);
  const sourceLanguage = draft.sourceLanguage ?? "und";

  const sections = [
    ...new Set(draft.items.flatMap((item) => (item.section === null ? [] : [item.section]))),
  ];

  const updateItem = (next: MenuDraftItem): void =>
    onChange({
      ...draft,
      items: draft.items.map((item) => (item.clientKey === next.clientKey ? next : item)),
    });

  return (
    <section className="scan-editor" aria-label={copy.editorTitle} lang={draft.targetLanguage}>
      <h2 className="font-display text-3xl">{copy.editorTitle}</h2>
      <p>{copy.editorHelp}</p>
      <label htmlFor="draft-menu-name">{copy.menuName}</label>
      <input
        id="draft-menu-name"
        required
        maxLength={300}
        lang={sourceLanguage}
        value={draft.menuName}
        onChange={(event) => onChange({ ...draft, menuName: event.target.value })}
      />
      <label htmlFor="draft-menu-language">{copy.menuLanguage}</label>
      <select
        id="draft-menu-language"
        value={draft.sourceLanguage ?? ""}
        onChange={(event) =>
          onChange({
            ...draft,
            sourceLanguage: event.target.value === "" ? null : event.target.value,
          })
        }
      >
        <option value="">{copy.unknown}</option>
        {menuLanguages.map((language) => (
          <option key={language} value={language}>
            {menuLanguageNames.get(language) ?? language}
          </option>
        ))}
      </select>
      <output>{valid ? copy.valid : copy.invalid}</output>
      {draft.items.map((item) => (
        <DraftItemEditor
          key={item.clientKey}
          item={item}
          sections={sections}
          locale={draft.targetLanguage}
          sourceLanguage={sourceLanguage}
          candidates={candidates}
          lookupFor={lookupFor}
          suppressedIds={suppressedIds}
          resolving={resolving}
          onResolveDish={onResolveDish}
          onChange={updateItem}
          onRemove={() =>
            onChange({
              ...draft,
              items: draft.items.filter((entry) => entry.clientKey !== item.clientKey),
            })
          }
        />
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({
            ...draft,
            items: [
              ...draft.items,
              {
                clientKey: crypto.randomUUID(),
                name: "",
                description: "",
                section: null,
                variants: [{ clientKey: crypto.randomUUID(), label: "", price: null }],
              },
            ],
          })
        }
      >
        {copy.addDish}
      </button>
      <div className="scan-editor-actions">
        <button type="button" disabled={!valid || !canSubmit || submitting} onClick={onSubmit}>
          {copy.submitReview}
        </button>
      </div>
      {submitError !== null && <p role="alert">{submitError}</p>}
      <h3 className="font-display text-3xl">{copy.previewTitle}</h3>
      <InteractiveMenuView menu={presentDraft(draft)} locale={draft.targetLanguage} />
    </section>
  );
}
