import { useQuery } from "@tanstack/react-query";
import { MapPin, Navigation, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { searchDishesFn } from "@/modules/food-discovery/food.functions";
import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import type { restaurantFacetsFn } from "@/modules/restaurant-discovery/restaurant.functions";

export interface SearchPick {
  readonly kind: "dish" | "cuisine";
  readonly id: string;
  readonly name: string;
}

interface Suggestion {
  readonly key: string;
  readonly kind: "dish" | "cuisine" | "text";
  readonly label: string;
  readonly hint: string;
  readonly pick: SearchPick | null;
}

/** Compact floating search. In overlay mode it expands into a focused
 *  panel; inline mode (drawer) shows a suggestion dropdown. */
export function MapSearchBar({
  copy,
  cuisines,
  initialText,
  activeFilterCount,
  locationBusy,
  overlay,
  onSubmitText,
  onPick,
  onNearMe,
  onOpenFilters,
  onOpenLocation,
}: {
  copy: RestaurantCopy;
  cuisines: Awaited<ReturnType<typeof restaurantFacetsFn>>;
  initialText: string;
  activeFilterCount: number;
  locationBusy: boolean;
  overlay: boolean;
  onSubmitText: (text: string) => void;
  onPick: (pick: SearchPick) => void;
  onNearMe: () => void;
  onOpenFilters: () => void;
  onOpenLocation: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(-1);
  const [debounced, setDebounced] = useState("");
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelInputRef = useRef<HTMLInputElement>(null);
  const barInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const focused = !overlay || expanded;

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), 250);

    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (expanded) panelInputRef.current?.focus({ preventScroll: true });
  }, [expanded]);

  const dishes = useQuery({
    queryKey: ["restaurant-dish-suggest", debounced],
    queryFn: () => searchDishesFn({ data: { q: debounced, limit: 6 } }),
    enabled: debounced.length > 0 && focused,
    staleTime: 60000,
  });

  const needle = text.trim().toLowerCase();

  const suggestions: Array<Suggestion> =
    needle.length === 0 || !focused
      ? []
      : [
          ...(dishes.data?.items.slice(0, 4).map((dish) => ({
            key: `dish:${dish.id}`,
            kind: "dish" as const,
            label: dish.name ?? dish.englishName ?? dish.slug,
            hint: copy.suggestDishes,
            pick: {
              kind: "dish" as const,
              id: dish.id,
              name: dish.name ?? dish.englishName ?? dish.slug,
            },
          })) ?? []),
          ...cuisines
            .filter(
              (cuisine) =>
                cuisine.slug.includes(needle) ||
                (cuisine.displayName ?? "").toLowerCase().includes(needle),
            )
            .slice(0, 3)
            .map((cuisine) => ({
              key: `cuisine:${cuisine.slug}`,
              kind: "cuisine" as const,
              label: cuisine.displayName ?? cuisine.slug,
              hint: copy.suggestCuisines,
              pick: {
                kind: "cuisine" as const,
                id: cuisine.slug,
                name: cuisine.displayName ?? cuisine.slug,
              },
            })),
          {
            key: `text:${needle}`,
            kind: "text" as const,
            label: text.trim(),
            hint: copy.suggestNames,
            pick: null,
          },
        ];

  const closeLater = () => {
    if (blurTimer.current !== null) clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => {
      setActive(-1);
    }, 120);
  };

  const choose = (suggestion: Suggestion) => {
    setActive(-1);

    if (suggestion.pick !== null) {
      setText("");
      onPick(suggestion.pick);
    } else {
      onSubmitText(text.trim());
    }

    if (overlay) {
      setExpanded(false);
      barInputRef.current?.focus({ preventScroll: true });
    }
  };

  const submit = () => {
    if (text.trim() === "") return;
    onSubmitText(text.trim());

    if (overlay) {
      setExpanded(false);
      barInputRef.current?.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setActive(active + 1 >= suggestions.length ? 0 : active + 1);
      itemRefs.current[active + 1 >= suggestions.length ? 0 : active + 1]?.focus();
    } else if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setActive(active - 1 < 0 ? suggestions.length - 1 : active - 1);
      itemRefs.current[active - 1 < 0 ? suggestions.length - 1 : active - 1]?.focus();
    } else if (event.key === "Escape") {
      if (overlay) {
        setExpanded(false);
        setActive(-1);
        barInputRef.current?.focus({ preventScroll: true });
      } else {
        setActive(-1);
      }
    } else if (event.key === "Enter" && document.activeElement?.tagName !== "BUTTON") {
      event.preventDefault();
      submit();
    }
  };

  const actionButtons = (
    <>
      <button
        type="button"
        className="mapapp-sb-icon"
        onClick={onOpenLocation}
        aria-label={copy.regionChoose}
        title={copy.regionChoose}
        data-labelled="true"
      >
        <MapPin aria-hidden="true" />
        <span aria-hidden="true">{copy.regionChooseShort}</span>
      </button>
      <button
        type="button"
        className="mapapp-sb-icon"
        onClick={onNearMe}
        disabled={locationBusy}
        aria-label={copy.nearMe}
        title={copy.nearMe}
        data-labelled="true"
      >
        <Navigation aria-hidden="true" />
        <span aria-hidden="true">{copy.nearMe}</span>
      </button>
      <button
        type="button"
        className="mapapp-sb-icon"
        onClick={onOpenFilters}
        aria-label={activeFilterCount > 0 ? `${copy.filters} (${activeFilterCount})` : copy.filters}
        title={copy.filters}
        data-labelled="true"
      >
        <SlidersHorizontal aria-hidden="true" />
        <span aria-hidden="true">{copy.filters}</span>
        {activeFilterCount > 0 && (
          <span aria-hidden="true" className="mapapp-sb-badge">
            {activeFilterCount}
          </span>
        )}
      </button>
    </>
  );

  if (overlay && !expanded) {
    return (
      <div className="mapapp-search-collapsed">
        <Search aria-hidden="true" className="mapapp-sb-icon-static" />
        <input
          ref={barInputRef}
          type="search"
          aria-label={copy.appSearchLabel}
          placeholder={copy.appSearchPlaceholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setExpanded(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && text.trim() !== "") submit();
          }}
        />
        <button
          type="button"
          className="mapapp-sb-icon"
          onClick={onOpenFilters}
          aria-label={
            activeFilterCount > 0 ? `${copy.filters} (${activeFilterCount})` : copy.filters
          }
        >
          <SlidersHorizontal aria-hidden="true" />
          {activeFilterCount > 0 && (
            <span aria-hidden="true" className="mapapp-sb-badge">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className={overlay ? "mapapp-search-panel" : "mapapp-search-inline"}>
      {overlay && (
        <div className="mapapp-search-panel-head">
          <button
            type="button"
            className="mapapp-sb-icon"
            onClick={() => {
              setExpanded(false);
              barInputRef.current?.focus({ preventScroll: true });
            }}
            aria-label={copy.closeSearch}
          >
            <X aria-hidden="true" />
          </button>
          <span className="mapapp-search-panel-title">{copy.appSearchLabel}</span>
        </div>
      )}
      <div className={overlay ? "mapapp-search-row" : "mapapp-search-stack"}>
        <div className="mapapp-search-field">
          <Search aria-hidden="true" className="mapapp-sb-icon-static" />
          <label
            htmlFor={overlay ? "mapapp-search-overlay" : "mapapp-search-inline-input"}
            className="sr-only"
          >
            {copy.appSearchLabel}
          </label>
          <input
            ref={overlay ? panelInputRef : undefined}
            id={overlay ? "mapapp-search-overlay" : "mapapp-search-inline-input"}
            type="search"
            autoComplete="off"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls={listId}
            aria-activedescendant={active >= 0 ? `${listId}-option-${active}` : undefined}
            placeholder={copy.appSearchPlaceholder}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setActive(-1);
            }}
            onBlur={closeLater}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="mapapp-search-actions">{actionButtons}</div>
      </div>
      {suggestions.length > 0 && (
        <ul id={listId} className="mapapp-suggest" aria-label={copy.appSearchLabel}>
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.key}>
              <button
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                id={`${listId}-option-${index}`}
                type="button"
                aria-current={index === active || undefined}
                data-active={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(suggestion)}
                onMouseEnter={() => setActive(index)}
              >
                <span className="mapapp-suggest-kind">{suggestion.hint}</span>
                <span className="mapapp-suggest-label">{suggestion.label}</span>
                {suggestion.kind === "text" && (
                  <span className="mapapp-suggest-enter">
                    {copy.suggestHint} “{suggestion.label}”
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
