import { z } from "zod";

/** Scalar URL values remain text, including decimal budgets and large identifiers.
 * Repeated keys retain TanStack's array semantics so scalar validators reject ambiguity.
 * Quoted strings from older TanStack-generated links remain readable.
 */
export function parseTextSearch(search: string) {
  const values = new Map<string, string | Array<string>>();

  for (const [key, raw] of new URLSearchParams(search)) {
    let value = raw;

    if (raw.startsWith('"')) {
      try {
        value = z.string().parse(JSON.parse(raw));
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
        // Malformed quoting stays ordinary text for the route's own validator.
      }
    }

    const previous = values.get(key);

    if (previous === undefined) values.set(key, value);
    else if (Array.isArray(previous)) previous.push(value);
    else values.set(key, [previous, value]);
  }

  return Object.fromEntries(values);
}
