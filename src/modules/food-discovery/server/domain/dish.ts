export interface DishCardIngredient {
  readonly name: string | undefined;
  readonly role: string;
}

/**
 * Image-led card enrichment shape. Producers (recommendations, local
 * carousel) emit the PublishedDishImage projection: generated same-origin
 * delivery URL + responsive srcSet, alt/attribution/focal preserved.
 * `license` is legacy (pre-projection shape) and optional — publication
 * licensing is enforced at the publish boundary, not re-exposed publicly.
 * New fields are optional so older payloads still decode.
 */
export interface DishCardImage {
  readonly url: string;
  readonly alt: string | null;
  readonly attribution: string | null;
  readonly license?: string | null | undefined;
  readonly id?: string | undefined;
  readonly dishId?: string | undefined;
  readonly srcSet?: string | null | undefined;
  readonly focalX?: number | null | undefined;
  readonly focalY?: number | null | undefined;
  readonly width?: number | null | undefined;
  readonly height?: number | null | undefined;
}

export interface DishSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string | undefined;
  readonly englishName: string | undefined;
  readonly regionNames: ReadonlyArray<string>;
  readonly categorySlugs: ReadonlyArray<string>;
  readonly updatedAt: string;
  readonly lastUpdate: number;
  /**
   * Optional image-led card enrichment (recommendations, local carousel
   * shape). Absent on list projections that do not read media; the card UI
   * renders a branded placeholder instead of inventing a photo.
   */
  readonly nativeName?: string | undefined;
  readonly nativeLanguageTag?: string | undefined;
  readonly description?: string | null | undefined;
  readonly descriptionLanguage?: string | null | undefined;
  readonly ingredients?: ReadonlyArray<DishCardIngredient> | undefined;
  readonly image?: DishCardImage | null | undefined;
}

export interface DishName {
  readonly languageTag: string;
  readonly name: string;
  readonly nameKind: string;
  readonly isPreferred: boolean;
}

export interface DishDescription {
  readonly languageTag: string;
  readonly description: string;
  readonly summary: string | null;
}

export interface DishIngredient {
  readonly id: string;
  readonly name: string | undefined;
  readonly role: string;
}

export interface DishPlace {
  readonly id: string;
  readonly name: string | undefined;
  readonly association: string;
  readonly isDisputed: boolean;
  readonly note: string | null;
  readonly kind: string;
  readonly iso3166: string | null;
  readonly displayLatitude: number | null;
  readonly displayLongitude: number | null;
}

export interface DishCuisine {
  readonly id: string;
  readonly slug: string;
  readonly name: string | undefined;
}

export interface DishCategory {
  readonly id: string;
  readonly kind: string;
  readonly slug: string;
  readonly name: string | undefined;
}

export interface DishSource {
  readonly recordId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly canonicalUrl: string | null;
  readonly license: string | null;
  readonly attribution: string | null;
}

/**
 * Frontend-friendly catalog profile. 3NF stays in storage; this read model is
 * composed at the service boundary so the frontend never joins relations.
 */
export interface DishProfile {
  readonly id: string;
  readonly slug: string;
  readonly name: string | undefined;
  readonly englishName: string | undefined;
  readonly nativeNames: ReadonlyArray<{ readonly languageTag: string; readonly name: string }>;
  readonly description: string | null;
  readonly descriptionLanguage: string | null;
  readonly status: string;
  readonly parent: { readonly id: string; readonly slug: string } | null;
  readonly ingredients: ReadonlyArray<DishIngredient>;
  readonly places: ReadonlyArray<DishPlace>;
  readonly cuisines: ReadonlyArray<DishCuisine>;
  readonly categories: ReadonlyArray<DishCategory>;
  readonly sources: ReadonlyArray<DishSource>;
  readonly lastUpdate: number;
  /** Primary published photo; only the public dish page requests it. */
  readonly image?: DishCardImage | null | undefined;
}
