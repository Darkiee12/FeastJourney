import { z } from "zod";

/** Plain thrown data survives TanStack's serializer, which strips Error subclasses. */
export const clientFailureSchema = z.object({
  _tag: z.string(),
  code: z.string(),
  status: z.number().int(),
  message: z.string(),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().nonnegative().nullable(),
});

export type ClientFailure = z.infer<typeof clientFailureSchema>;
