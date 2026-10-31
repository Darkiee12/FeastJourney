import { useCallback, type RefObject } from "react";

import { localizedDishText, type FoodLocation } from "@/components/home/globe/food-locations";
import type { GlobeOverlayBridge } from "@/components/home/globe/geo-utils";
import type { GlobePopupNodes } from "@/components/home/globe/use-globe-dishes";
import { usePreviewDialog } from "@/components/home/globe/use-preview-dialog";
import type { Locale, Messages } from "@/shared/i18n";

export type ActiveDish = {
  dish: FoodLocation;
  exiting: boolean;
};

function PopupStem() {
  return (
    <span
      aria-hidden="true"
      className="mx-auto block h-2.5 w-2.5 -translate-y-1 rotate-45 bg-food-orange"
    />
  );
}

function sameDishName(dish: { readonly name: string; readonly englishName: string }): boolean {
  return dish.englishName.trim().toLowerCase() === dish.name.trim().toLowerCase();
}

function dishLabel(dish: FoodLocation, lang: Locale, popupHint: string): string {
  const names = sameDishName(dish) ? dish.name : `${dish.name}, ${dish.englishName}`;

  return `${names}, ${localizedDishText(dish.country, lang)}. ${popupHint}`;
}

/** DOM popup and preview cards positioned each frame from real 3D anchors. */
export function GlobeFoodOverlay({
  copy,
  lang,
  bridgeRef,
  popupsRef,
  actives,
  preview,
  announcement,
  onOpenPreview,
  onClosePreview,
  onShowAnother,
  onHoverDish,
}: {
  copy: Messages;
  lang: Locale;
  bridgeRef: RefObject<GlobeOverlayBridge>;
  popupsRef: RefObject<GlobePopupNodes>;
  actives: Array<ActiveDish>;
  preview: FoodLocation | null;
  announcement: string;
  onOpenPreview: (dish: FoodLocation) => void;
  onClosePreview: () => void;
  onShowAnother: () => void;
  onHoverDish: (id: string | null) => void;
}) {
  const headingRef = usePreviewDialog(preview, onClosePreview);

  const setNode = useCallback(
    (node: HTMLDivElement | null) => {
      bridgeRef.current.node = node;
    },
    [bridgeRef],
  );

  const registerPopup = useCallback(
    (id: string) => (node: HTMLDivElement | null) => {
      if (node) {
        popupsRef.current.set(id, node);
      } else {
        popupsRef.current.delete(id);
      }
    },
    [popupsRef],
  );

  return (
    <>
      {!preview
        ? actives.map((active) => (
            <div
              key={active.dish.id}
              ref={registerPopup(active.dish.id)}
              style={{ visibility: "hidden" }}
              className="pointer-events-none absolute top-0 left-0 flex -translate-x-1/2 -translate-y-full flex-col items-center"
            >
              <button
                type="button"
                onClick={() => {
                  onOpenPreview(active.dish);
                }}
                onFocus={() => {
                  onHoverDish(active.dish.id);
                }}
                onBlur={() => {
                  onHoverDish(null);
                }}
                onPointerEnter={(event) => {
                  if (event.pointerType !== "touch") {
                    onHoverDish(active.dish.id);
                  }
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType !== "touch") {
                    onHoverDish(null);
                  }
                }}
                aria-label={dishLabel(active.dish, lang, copy.popupHint)}
                className={`pointer-events-auto flex cursor-pointer items-center gap-3 rounded-2xl border border-border-soft bg-white py-2 pr-4 pl-2 text-left text-ink shadow-[0_16px_40px_rgba(3,10,30,0.45)] transition-colors hover:border-food-orange ${
                  active.exiting
                    ? "motion-safe:animate-popup-exit"
                    : "motion-safe:animate-popup-enter"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="grid h-11 w-11 flex-none place-items-center rounded-full bg-cream text-[1.6rem]"
                >
                  {active.dish.emoji}
                </span>

                <span className="flex flex-col py-0.5 pr-1 leading-tight">
                  <span className="text-base font-extrabold whitespace-nowrap">
                    {active.dish.name}
                  </span>
                  {sameDishName(active.dish) ? null : (
                    <span className="text-sm font-semibold whitespace-nowrap text-food-orange-strong">
                      {active.dish.englishName}
                    </span>
                  )}
                  <span className="text-sm whitespace-nowrap text-muted">
                    {localizedDishText(active.dish.country, lang)}
                  </span>
                </span>
              </button>

              <PopupStem />
            </div>
          ))
        : null}

      {preview ? (
        <div
          ref={setNode}
          className="pointer-events-none absolute top-0 left-0 flex -translate-x-1/2 -translate-y-full flex-col items-center max-sm:fixed max-sm:top-auto max-sm:right-4 max-sm:bottom-[max(5rem,calc(env(safe-area-inset-bottom)+5rem))] max-sm:left-4 max-sm:translate-x-0 max-sm:translate-y-0"
        >
          <dialog
            open
            aria-labelledby="food-preview-name"
            className="static m-0 max-w-none border-0 bg-transparent p-0"
          >
            <div className="pointer-events-auto w-[min(19rem,78vw)] origin-bottom rounded-2xl border border-border-soft bg-white p-4 text-left text-ink shadow-[0_20px_48px_rgba(3,10,30,0.5)] motion-safe:animate-popup-enter max-sm:w-full">
              <div className="mb-2 flex items-center gap-3">
                <span aria-hidden="true" className="text-3xl leading-none">
                  {preview.emoji}
                </span>

                <div>
                  <p
                    id="food-preview-name"
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-lg leading-tight font-extrabold focus:outline-none"
                  >
                    {preview.name}
                  </p>

                  {sameDishName(preview) ? null : (
                    <p className="text-sm font-semibold text-food-orange-strong">
                      {preview.englishName}
                    </p>
                  )}

                  <p className="text-sm text-muted">
                    {localizedDishText(preview.country, lang)} ·{" "}
                    {localizedDishText(preview.region, lang)}
                  </p>
                </div>
              </div>

              <p className="mb-4 text-[0.95rem]">{localizedDishText(preview.description, lang)}</p>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={onShowAnother}
                  className="min-h-11 cursor-pointer rounded-full bg-food-orange-strong px-4 text-sm font-bold text-white hover:bg-food-orange-dark"
                >
                  {copy.previewShowAnother}
                </button>

                <button
                  type="button"
                  onClick={onClosePreview}
                  className="min-h-11 cursor-pointer rounded-full border-2 border-border-soft bg-transparent px-4 text-sm font-bold text-ink hover:border-muted"
                >
                  {copy.previewClose}
                </button>
              </div>
            </div>
          </dialog>

          <PopupStem />
        </div>
      ) : null}

      <output className="sr-only">{announcement}</output>
    </>
  );
}
