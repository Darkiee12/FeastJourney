import { z } from "zod";

/**
 * HTTP-boundary schemas for place registry administration. Every value
 * crossing the TanStack server-function boundary is re-validated here;
 * server-internal invariants (search-key derivation, preferred-name
 * elections, hierarchy cycle checks) live in `PlaceAdminService` and are
 * never trusted from the client.
 */

export const placeKindSchema = z.enum([
  "continent",
  "region",
  "country",
  "subnational",
  "province",
  "locality",
]);

export type PlaceKind = z.infer<typeof placeKindSchema>;

const placeIdSchema = z.string().regex(/^[0-9]+$/, "place id must be a decimal id string");

const languageTagSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z]{2,8})?$/, "language_tag must be a BCP 47 tag");

const isoInputSchema = z.string().trim().min(1).max(10);

const latitudeSchema = z.number().min(-90).max(90).nullable().optional();

const longitudeSchema = z.number().min(-180).max(180).nullable().optional();

export const adminPlacesListSchema = z.object({
  query: z.string().trim().max(200).default(""),
  kind: placeKindSchema.optional(),
  parentId: placeIdSchema.optional(),
  page: z.coerce.number().int().min(0).default(0),
});

export type AdminPlacesList = z.infer<typeof adminPlacesListSchema>;

export const adminPlaceDetailSchema = z.object({
  placeId: placeIdSchema,
});

export type AdminPlaceDetail = z.infer<typeof adminPlaceDetailSchema>;

const placeNameInputSchema = z.object({
  languageTag: languageTagSchema,
  name: z.string().trim().min(1).max(300),
  isPreferred: z.boolean().optional(),
  /**
   * Name-row identity for ID-preserving renames. Absent inserts a new
   * row. Scoped to the place by `savePlaceNames`; a row from another
   * place is rejected as unknown.
   */
  id: placeIdSchema.optional(),
});

export type PlaceNameInput = z.infer<typeof placeNameInputSchema>;

export const adminCreatePlaceSchema = z.object({
  kind: placeKindSchema,
  iso3166: isoInputSchema.nullable().optional(),
  displayLatitude: latitudeSchema,
  displayLongitude: longitudeSchema,
  displayNote: z.string().trim().max(2000).nullable().optional(),
  names: z.array(placeNameInputSchema).min(1).max(20),
  parentIds: z.array(placeIdSchema).max(10).optional(),
});

export type AdminCreatePlace = z.infer<typeof adminCreatePlaceSchema>;

export const adminUpdatePlaceSchema = z.object({
  placeId: placeIdSchema,
  kind: placeKindSchema.optional(),
  iso3166: isoInputSchema.nullable().optional(),
  displayLatitude: latitudeSchema,
  displayLongitude: longitudeSchema,
  displayNote: z.string().trim().max(2000).nullable().optional(),
});

export type AdminUpdatePlace = z.infer<typeof adminUpdatePlaceSchema>;

export const adminPlaceNamesSchema = z.discriminatedUnion("action", [
  z.object({
    placeId: placeIdSchema,
    action: z.literal("upsert"),
    names: z.array(placeNameInputSchema).min(1).max(20),
  }),
  z.object({
    placeId: placeIdSchema,
    action: z.literal("remove"),
    nameId: placeIdSchema,
  }),
]);

export type AdminPlaceNames = z.infer<typeof adminPlaceNamesSchema>;

/**
 * Atomic place-name save: renames reference rows by `id`, entries
 * without `id` insert, and `removeIds` delete — all in one transaction.
 * Upsert may be empty for a deletes-only save; the service refuses a save
 * that would leave the place nameless.
 */
export const adminPlaceNamesSaveSchema = z.object({
  placeId: placeIdSchema,
  upsert: z.array(placeNameInputSchema).max(20),
  removeIds: z.array(placeIdSchema).max(20).default([]),
});

export type AdminPlaceNamesSave = z.infer<typeof adminPlaceNamesSaveSchema>;

export const adminPlaceParentSchema = z.object({
  placeId: placeIdSchema,
  parentPlaceId: placeIdSchema,
  action: z.enum(["set", "remove"]),
});

export type AdminPlaceParent = z.infer<typeof adminPlaceParentSchema>;

export const adminDeletePlaceSchema = z.object({
  placeId: placeIdSchema,
});

export type AdminDeletePlace = z.infer<typeof adminDeletePlaceSchema>;

/**
 * Portable place reference input for every workstream that links dishes to
 * places (admin UI, import studio, dish editor). Exactly one variant carries
 * a value; the service resolves it through `resolvePlaceRef` with preferred
 * names first, then aliases, scoped by parent ISO when given.
 */
export const placeRefSchema = z.union([
  z.object({ placeId: z.number().int().positive() }),
  z.object({ iso: isoInputSchema }),
  z.object({
    city: z.string().trim().min(1).max(300),
    parentIso: isoInputSchema.optional(),
  }),
]);

export type PlaceRefInput = z.infer<typeof placeRefSchema>;
