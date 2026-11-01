import { z } from "zod";

/**
 * Client-safe transport schemas for the user module. Identity, roles, and
 * verification state never come from these schemas; they come from the
 * verified server session.
 */
export const profileUpdateSchema = z.object({
  display_name: z.string().trim().min(1).max(100).nullable().default(null),
  locale: z.enum(["en", "vi", "hi", "es", "zh"]).default("en"),
});

export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/**
 * Read shape for member ingredient exclusions (quiz + account settings).
 * `excluded_ingredients` stays snake_case on the transport, matching
 * `profileUpdateSchema` convention; callers map to camelCase locally.
 */
export const foodPreferencesSchema = z.object({
  excluded_ingredients: z.array(z.string()),
});

export type FoodPreferences = z.infer<typeof foodPreferencesSchema>;

/**
 * Write shape for member ingredient exclusions. Transport items are
 * trimmed; empties are dropped and duplicates removed (order preserved) via
 * the transform below. Cap violations (more than 20 items, any item longer
 * than 100 chars) are rejected with a 400 — never silently truncated.
 */
export const foodPreferencesUpdateSchema = z.object({
  excluded_ingredients: z
    .array(z.string().trim().max(100))
    .max(20)
    .transform((items) => {
      const seen = new Set<string>();
      const terms: Array<string> = [];

      for (const item of items) {
        if (item.length === 0 || seen.has(item)) {
          continue;
        }

        seen.add(item);
        terms.push(item);
      }

      return terms;
    }),
});

export type FoodPreferencesUpdate = z.infer<typeof foodPreferencesUpdateSchema>;

export const favoriteLinkSchema = z.object({
  dish_id: z.string().regex(/^[0-9]+$/, "dish_id must be a decimal id string"),
});

export type FavoriteLink = z.infer<typeof favoriteLinkSchema>;

export const favoritesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

/** Membership probe for visible dish ids; capped at one page of cards. */
export const favoriteStatusSchema = z.object({
  ids: z
    .array(z.string().regex(/^[0-9]+$/, "id must be a decimal id string"))
    .min(1)
    .max(50),
});

export const sessionRevokeSchema = z.object({
  session_id: z.string().min(1).max(255),
});

export const unlinkAccountSchema = z.object({
  account_id: z.string().min(1).max(255),
});

export const adminRoleAssignSchema = z.object({
  user_id: z.string().min(1).max(255),
  role_id: z.string().min(1).max(120),
});

export const adminUserQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const adminUserEmailSchema = z.object({
  email: z.string().trim().min(3).max(254),
});

const roleSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase alphanumeric with dashes");

const roleColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "color must be a hex code like #3b82f6");

export const roleMutationSchema = z.object({
  slug: roleSlugSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  color: roleColorSchema.default("#6b7280"),
  position: z.coerce.number().int().min(0).max(1000).default(0),
});

export type RoleMutation = z.infer<typeof roleMutationSchema>;

export const roleIdSchema = z.object({
  role_id: z.string().min(1).max(120),
});

export const roleGrantsSchema = z.object({
  role_id: z.string().min(1).max(120),
  permissions: z.array(z.string().min(1).max(80)).max(100),
});
