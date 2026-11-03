import type { MenuScanDocument } from "@/modules/restaurant-discovery/menu-scan.schema";

/** Indented JSON overestimates PostgreSQL JSONB separator spacing for this schema. */
export const menuDocumentFitsStorage = (document: MenuScanDocument): boolean =>
  new TextEncoder().encode(JSON.stringify(document, null, 1)).byteLength <= 1_048_576;

/** Pure revision invariants; ownership and persistence stay in the server operation. */
export function validateMenuRevision(previous: MenuScanDocument, next: MenuScanDocument): boolean {
  if (
    next.targetLanguage !== previous.targetLanguage ||
    JSON.stringify(next.pages) !== JSON.stringify(previous.pages) ||
    next.items.length === 0
  )
    return false;

  const pages = new Set(previous.pages.map((page) => page.assetId));
  const items = new Map(previous.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const variantIds = new Set<string>();

  for (const item of next.items) {
    if (seen.has(item.id) || item.variants.length === 0) return false;
    seen.add(item.id);

    const original = items.get(item.id);

    if (original === undefined && item.customerAdded !== true) return false;

    const variants = new Set(original?.variants.map((variant) => variant.id) ?? []);

    for (const variant of item.variants) {
      if (variantIds.has(variant.id)) return false;
      variantIds.add(variant.id);

      if (!variants.has(variant.id) && variant.customerAdded !== true) return false;
    }

    const references = new Set<string>();

    for (const reference of item.sourceReferences) {
      if (!pages.has(reference.assetId) || references.has(reference.assetId)) return false;

      references.add(reference.assetId);
    }

    if (item.sourceReferences.length === 0) return false;
  }

  return true;
}
