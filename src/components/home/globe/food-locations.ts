import { Data } from "effect";

import dishData from "@/components/home/globe/food-locations.json";
import { Latitude, Longitude } from "@/components/home/globe/geo-utils";
import type { Locale } from "@/shared/i18n";

/** Window event that asks the globe to spotlight a random visible dish. */
export const SURPRISE_DISH_EVENT = "feastjourney:surprise-dish";

/** Discovery-section category used to filter the curated dishes. */
export type FoodCategory = Data.TaggedEnum<{
  readonly LocalFavorites: {};
  readonly StreetFood: {};
  readonly ComfortingBowls: {};
  readonly WorthTravelling: {};
}>;

export const { LocalFavorites, StreetFood, ComfortingBowls, WorthTravelling, $match } =
  Data.taggedEnum<FoodCategory>();

/**
 * One curated dish shown on the homepage globe and in the discovery section.
 * Coordinates are representative display anchors for the listed city, not
 * claims about a dish's exact origin.
 */
export type FoodLocation = {
  id: string;
  name: string;
  englishName: string;
  country: ReadonlyMap<Locale, string>;
  region: ReadonlyMap<Locale, string>;
  latitude: Latitude;
  longitude: Longitude;
  emoji: string;
  description: ReadonlyMap<Locale, string>;
  categories: Array<FoodCategory>;
};

/** Short localized blurb shared shape for dish text fields. */
export type LocalizedText = {
  en: string;
  vi: string;
  hi: string;
  es: string;
  zh: string;
  ja?: string | undefined;
  de?: string | undefined;
  nl?: string | undefined;
};

/** Build the locale map backing country, region, and description fields. */
export function textMap(text: LocalizedText): ReadonlyMap<Locale, string> {
  return new Map<Locale, string>([
    ["en", text.en],
    ["vi", text.vi],
    ["hi", text.hi],
    ["es", text.es],
    ["zh", text.zh],
    ["ja", text.ja ?? text.en],
    ["de", text.de ?? text.en],
    ["nl", text.nl ?? text.en],
  ]);
}

function categoryFromTag(tag: string): FoodCategory {
  switch (tag) {
    case "LocalFavorites":
      return LocalFavorites();
    case "StreetFood":
      return StreetFood();
    case "ComfortingBowls":
      return ComfortingBowls();
    case "WorthTravelling":
      return WorthTravelling();
    default:
      throw new Error(`unknown globe dish category "${tag}" in food-locations.json`);
  }
}

type RawDish = {
  id: string;
  name: string;
  englishName: string;
  country: LocalizedText;
  region: LocalizedText;
  latitude: number;
  longitude: number;
  emoji: string;
  description: LocalizedText;
  categories: Array<string>;
};

function toFoodLocation(raw: RawDish): FoodLocation {
  return {
    id: raw.id,
    name: raw.name,
    englishName: raw.englishName,
    country: textMap(raw.country),
    region: textMap(raw.region),
    latitude: Latitude(raw.latitude),
    longitude: Longitude(raw.longitude),
    emoji: raw.emoji,
    description: textMap(raw.description),
    categories: raw.categories.map((tag) => categoryFromTag(tag)),
  };
}

const rawDishes: { dishes: Array<RawDish> } = dishData;

/**
 * Every curated dish-city anchor, loaded from the co-located JSON so the
 * list can be bulk-edited without touching code. Each entry carries a
 * native name and an English name for the globe.
 */
export const FOOD_LOCATIONS: Array<FoodLocation> = rawDishes.dishes.map(toFoodLocation);

/**
 * How many dishes the globe shows at once. The catalog holds hundreds of
 * anchors; rendering and cycling all of them is visual noise, so the dots
 * layer and popup scheduling share one small rotating subset.
 */
export const VISIBLE_DISH_COUNT = 20;

/**
 * Random subset of dishes for the visible globe layer. Full Fisher-Yates
 * shuffle, then take the head: O(n) outside the render loop (resampled on a
 * slow interval), so no per-frame allocation pressure.
 */
export function sampleDishSubset(
  count: number,
  random: () => number = Math.random,
): Array<FoodLocation> {
  const take = Math.max(0, Math.min(count, FOOD_LOCATIONS.length));
  const shuffled = [...FOOD_LOCATIONS];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const candidate = shuffled[other];

    if (current === undefined || candidate === undefined) {
      continue;
    }

    shuffled[index] = candidate;
    shuffled[other] = current;
  }

  return shuffled.slice(0, take);
}

/** Dishes carrying the given category tag, matched exhaustively via $match. */
export function dishesInCategory(
  dishes: Array<FoodLocation>,
  tag: FoodCategory["_tag"],
): Array<FoodLocation> {
  return dishes.filter((dish) =>
    dish.categories.some((category) =>
      $match(category, {
        LocalFavorites: () => tag === "LocalFavorites",
        StreetFood: () => tag === "StreetFood",
        ComfortingBowls: () => tag === "ComfortingBowls",
        WorthTravelling: () => tag === "WorthTravelling",
      }),
    ),
  );
}

/** Localized dish text with an English fallback when a locale entry is missing. */
export function localizedDishText(text: ReadonlyMap<Locale, string>, lang: Locale): string {
  return text.get(lang) ?? text.get("en") ?? "";
}
