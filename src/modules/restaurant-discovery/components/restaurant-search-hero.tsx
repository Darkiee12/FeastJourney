import { useQuery } from "@tanstack/react-query";
import { MapPin, Search, SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { searchDishesFn } from "@/modules/food-discovery/food.functions";
import type { RestaurantCopy } from "@/modules/restaurant-discovery/components/restaurant-copy";
import type { restaurantFacetsFn } from "@/modules/restaurant-discovery/restaurant.functions";

export interface SearchPick {
  readonly kind: "dish" | "cuisine";
  readonly id: string;
  readonly name: string;
}

interface HeroProps {
  readonly copy: RestaurantCopy;
  readonly areas: ReadonlyArray<{ area: string }>;
  readonly cuisines: Awaited<ReturnType<typeof restaurantFacetsFn>>;
  readonly initialText: string;
  readonly initialArea: string;
  readonly activeFilterCount: number;
  readonly locationBusy: boolean;
  readonly onSubmitText: (text: string) => void;
  readonly onPick: (pick: SearchPick) => void;
  readonly onAreaChange: (area: string) => void;
  readonly onNearMe: () => void;
  readonly onOpenFilters: () => void;
  readonly compact?: boolean;
}

interface Suggestion {
  readonly key: string;
  readonly kind: "dish" | "cuisine" | "text";
  readonly label: string;
  readonly hint: string;
  readonly pick: SearchPick | null;
}

/** One search box for dishes, cuisines, and restaurant names. A picked
 *  suggestion applies that filter directly; free text searches names. */
export function RestaurantSearchHero({
  copy,
  areas,
  cuisines,
  initialText,
  initialArea,
  activeFilterCount,
  locationBusy,
  onSubmitText,
  onPick,
  onAreaChange,
  onNearMe,
  onOpenFilters,
  compact = false,
}: HeroProps) {
  const [text, setText] = useState(initialText);
  const [area, setArea] = useState(initialArea);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [debounced, setDebounced] = useState("");
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), 250);

    return () => clearTimeout(timer);
  }, [text]);

  const dishes = useQuery({
    queryKey: ["restaurant-dish-suggest", debounced],
    queryFn: () => searchDishesFn({ data: { q: debounced, limit: 6 } }),
    enabled: debounced.length > 0,
    staleTime: 60000,
  });

  const needle = text.trim().toLowerCase();

  const suggestions: Array<Suggestion> =
    needle.length === 0
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
      setOpen(false);
      setActive(-1);
    }, 120);
  };

  const choose = (suggestion: Suggestion) => {
    setOpen(false);
    setActive(-1);

    if (suggestion.pick !== null) {
      setText("");
      onPick(suggestion.pick);
    } else {
      onSubmitText(text.trim());
    }
  };

  const focusItem = (index: number) => {
    setActive(index);
    itemRefs.current[index]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setOpen(true);
      focusItem(active + 1 >= suggestions.length ? 0 : active + 1);
    } else if (event.key === "ArrowUp" && suggestions.length > 0) {
      event.preventDefault();
      setOpen(true);
      focusItem(active - 1 < 0 ? suggestions.length - 1 : active - 1);
    } else if (event.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  };

  const form = (
    <search aria-label={copy.searchLabel}>
      <form
        className="res-searchbar"
        onSubmit={(event) => {
          event.preventDefault();
          setOpen(false);
          onSubmitText(text.trim());
        }}
      >
        <div className="res-search-field">
          <Search aria-hidden="true" className="res-search-icon" />
          <label htmlFor="res-search-input" className="sr-only">
            {copy.searchLabel}
          </label>
          <input
            id="res-search-input"
            type="search"
            autoComplete="off"
            role="combobox"
            aria-expanded={open && suggestions.length > 0}
            aria-controls={listId}
            placeholder={copy.searchPlaceholder}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => {
              if (text.trim().length > 0) setOpen(true);
            }}
            onBlur={closeLater}
            onKeyDown={onKeyDown}
          />
          {open && suggestions.length > 0 && (
            <div id={listId} className="res-suggest">
              {suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.key}
                  ref={(element) => {
                    itemRefs.current[index] = element;
                  }}
                  type="button"
                  data-active={index === active}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(suggestion)}
                  onMouseEnter={() => setActive(index)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setOpen(false);
                      setActive(-1);
                      document.getElementById("res-search-input")?.focus();
                    }
                  }}
                >
                  <span className="res-suggest-kind">{suggestion.hint}</span>
                  <span className="res-suggest-label">{suggestion.label}</span>
                  {suggestion.kind === "text" && (
                    <span className="res-suggest-enter">
                      {copy.suggestHint} “{suggestion.label}”
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="res-search-row">
          <div className="res-area">
            <MapPin aria-hidden="true" className="res-search-icon" />
            <label htmlFor="res-area" className="sr-only">
              {copy.areaLabel}
            </label>
            <select
              id="res-area"
              value={area}
              onChange={(event) => {
                setArea(event.target.value);
                onAreaChange(event.target.value);
              }}
            >
              <option value="">{copy.areaAll}</option>
              {areas.map(({ area: name }) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="res-near" onClick={onNearMe} disabled={locationBusy}>
            <MapPin aria-hidden="true" />
            {locationBusy ? copy.nearMeBusy : copy.nearMe}
          </button>
          <button type="submit" className="res-go">
            {copy.searchSubmit}
          </button>
          <button
            type="button"
            className="res-filters-btn"
            onClick={onOpenFilters}
            aria-label={
              activeFilterCount > 0 ? `${copy.filters} (${activeFilterCount})` : copy.filters
            }
          >
            <SlidersHorizontal aria-hidden="true" />
            {copy.filters}
            {activeFilterCount > 0 && (
              <span aria-hidden="true" className="res-filters-badge">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </form>
    </search>
  );

  if (compact) {
    return <section className="res-bar">{form}</section>;
  }

  return (
    <section className="res-hero">
      <div aria-hidden="true" className="hero-stars" />
      <div className="res-hero-inner">
        <p className="res-eyebrow">{copy.heroEyebrow}</p>
        <h1 className="res-title">{copy.heroTitle}</h1>
        <p className="res-sub">{copy.heroSub}</p>
        {form}
      </div>
    </section>
  );
}
