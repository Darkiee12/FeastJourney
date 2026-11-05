import { useState } from "react";

import { menuCopy } from "@/modules/restaurant-discovery/components/menu-copy";
import {
  DraftVariantEditor,
  VariantEditor,
  type ScanVariant,
} from "@/modules/restaurant-discovery/components/scan-variant-editor";
import type {
  MenuDraftItem,
  MenuDraftVariant,
} from "@/modules/restaurant-discovery/menu-presentation";
import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";

/** A published dish that curator text can link to. Re-exported by the editor shell. */
export interface DishCandidate {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly categories: ReadonlyArray<string>;
  readonly places: ReadonlyArray<string>;
}

export type ScanItem = MenuScanDocument["items"][number];

/** Editor for one extracted scan item and its variants. Matches the original inline markup. */
export function ScanItemEditor({
  item,
  locale,
  translationLanguage = locale,
  sourceLanguage,
  onUpdate,
  onRemove,
}: {
  readonly item: ScanItem;
  readonly locale: string;
  readonly translationLanguage?: string;
  readonly sourceLanguage: string;
  readonly onUpdate: (item: ScanItem) => void;
  readonly onRemove: () => void;
}) {
  const copy = menuCopy(locale);

  return (
    <section className="scan-editor-item" key={item.id}>
      <h3 lang={sourceLanguage}>{item.originalName}</h3>
      <label htmlFor={`edit-name-${item.id}`}>{copy.originalName}</label>
      <input
        id={`edit-name-${item.id}`}
        required
        maxLength={300}
        lang={sourceLanguage}
        value={item.originalName}
        onChange={(event) => onUpdate({ ...item, originalName: event.target.value })}
      />
      <label htmlFor={`edit-translation-${item.id}`}>{copy.translatedName}</label>
      <input
        id={`edit-translation-${item.id}`}
        maxLength={300}
        lang={translationLanguage}
        value={item.translatedName ?? ""}
        onChange={(event) =>
          onUpdate({
            ...item,
            translatedName: event.target.value === "" ? null : event.target.value,
          })
        }
      />
      <details>
        <summary>
          {copy.originalDescription} / {copy.translatedDescription}
        </summary>
        <label htmlFor={`edit-description-${item.id}`}>{copy.originalDescription}</label>
        <textarea
          id={`edit-description-${item.id}`}
          maxLength={3000}
          lang={sourceLanguage}
          value={item.originalDescription ?? ""}
          onChange={(event) =>
            onUpdate({
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
          lang={translationLanguage}
          value={item.translatedDescription ?? ""}
          onChange={(event) =>
            onUpdate({
              ...item,
              translatedDescription: event.target.value === "" ? null : event.target.value,
            })
          }
        />
      </details>
      {item.variants.map((variant) => (
        <VariantEditor
          key={variant.id}
          variant={variant}
          locale={locale}
          translationLanguage={translationLanguage}
          sourceLanguage={sourceLanguage}
          onChange={(next: ScanVariant) =>
            onUpdate({
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
            onUpdate({
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
                onUpdate({
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
      <button type="button" onClick={onRemove}>
        {copy.removeDish}
      </button>
    </section>
  );
}

/** Editor for one curator draft item and its dish link. Matches the original inline markup. */
export function DraftItemEditor({
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
          onChange={(next: MenuDraftVariant) =>
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
