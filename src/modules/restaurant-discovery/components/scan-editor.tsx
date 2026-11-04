import { useState } from "react";

import { SharedSelectField } from "@/components/ui/select";
import { InteractiveMenuView } from "@/modules/restaurant-discovery/components/interactive-menu";
import { menuCopy, menuLanguageNames } from "@/modules/restaurant-discovery/components/menu-copy";
import {
  DraftItemEditor,
  ScanItemEditor,
  type DishCandidate,
  type ScanItem,
} from "@/modules/restaurant-discovery/components/scan-item-editor";
import { draftPriceValid } from "@/modules/restaurant-discovery/components/scan-price-editor";
import { menuBcp47TagFor, presentDraft } from "@/modules/restaurant-discovery/menu-presentation";
import type { MenuDraft, MenuDraftItem } from "@/modules/restaurant-discovery/menu-presentation";
import {
  menuLanguages,
  menuScanDocumentSchema,
} from "@/modules/restaurant-discovery/menu-scan.schema";
import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";

export type { DishCandidate };

export function ScanEditor({
  document,
  onChange,
  initialItemId,
}: {
  readonly initialItemId?: string | null | undefined;
  readonly document: MenuScanDocument;
  readonly onChange: (document: MenuScanDocument) => void;
}) {
  const [selectedId, setSelectedId] = useState(initialItemId ?? document.items[0]?.id ?? "");
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
      lang={menuBcp47TagFor(document.targetLanguage)}
    >
      <h2 className="font-display text-3xl">{copy.edit}</h2>
      <p>{copy.editHelp}</p>
      <output>{valid ? copy.valid : copy.invalid}</output>
      <SharedSelectField
        label={copy.edit}
        value={selectedId}
        onValueChange={setSelectedId}
        options={document.items.map((item) => ({
          value: item.id,
          label: item.translatedName ?? item.originalName,
        }))}
      />
      {document.items
        .filter((item) => item.id === selectedId)
        .map((item) => (
          <ScanItemEditor
            key={item.id}
            item={item}
            locale={document.targetLanguage}
            sourceLanguage={document.sourceLanguage ?? "und"}
            onUpdate={updateItem}
            onRemove={() =>
              onChange({
                ...document,
                items: document.items.filter((entry) => entry.id !== item.id),
              })
            }
          />
        ))}
      <button
        type="button"
        onClick={() => {
          const page = document.pages[0];

          if (page === undefined) return;

          const id = crypto.randomUUID();
          setSelectedId(id);
          onChange({
            ...document,
            items: [
              ...document.items,
              {
                id,
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

const draftValid = (draft: MenuDraft): boolean =>
  draft.menuName.trim() !== "" &&
  draft.items.length > 0 &&
  draft.items.every(
    (item) =>
      item.name.trim() !== "" &&
      item.variants.length > 0 &&
      item.variants.every((variant) => draftPriceValid(variant.price)),
  );

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
