import { Data } from "effect";

export class DishNotFound extends Data.TaggedError("DishNotFound")<{
  readonly dishId: string;
}> {}

export class IngredientNotFound extends Data.TaggedError("IngredientNotFound")<{
  readonly ingredientId: string;
}> {}

export class PlaceNotFound extends Data.TaggedError("PlaceNotFound")<{
  readonly placeId: string;
}> {}

export class InvalidSearchFilter extends Data.TaggedError("InvalidSearchFilter")<{
  readonly reason: string;
}> {}

/**
 * A dish↔place reference names a locality the registry does not contain
 * (unknown id, ISO, or city name, or a parent-ISO scope mismatch). Carries
 * the server-built reason so curators learn the locality must be
 * registered first. Replaces the generic InvalidSearchFilter at the four
 * resolvePlaceRefLocal miss sites; everything else keeps its existing tag.
 */
export class UnknownPlace extends Data.TaggedError("UnknownPlace")<{
  readonly reason: string;
}> {}

export class InvalidLocale extends Data.TaggedError("InvalidLocale")<{
  readonly locale: string;
}> {}

export class ConflictingDish extends Data.TaggedError("ConflictingDish")<{
  readonly reason: string;
}> {}

export class InvalidDishData extends Data.TaggedError("InvalidDishData")<{
  readonly reason: string;
}> {}

export class CatalogConflict extends Data.TaggedError("CatalogConflict")<{
  readonly reason: string;
}> {}

export class InvalidRelationship extends Data.TaggedError("InvalidRelationship")<{
  readonly reason: string;
}> {}
