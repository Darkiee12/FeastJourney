import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { isVerifiedPlaceRef } from "@/components/admin/places/place-grammar";
import { PlaceSelector } from "@/components/admin/places/PlaceSelector";
import { messagesFor } from "@/shared/i18n";

/**
 * Unverified-preview pins for the reference place selector.
 *
 * Syntactically valid city/ISO refs (`Mumbai@IN`, `VN`) render a geographic
 * preview, but that preview must never read as a confirmed registry match:
 * only canonical `place:<id>` refs (picked through registry search) are
 * verified. SSR-only, no DB/DOM.
 */

const referenceSelector = (value: string) => {
  const copy = messagesFor("en");

  return renderToStaticMarkup(
    createElement(PlaceSelector, {
      id: "place-ref",
      label: copy.adminPlaceRef,
      copy,
      lang: "en",
      value,
      onChange: () => undefined,
    }),
  );
};

describe("isVerifiedPlaceRef", () => {
  test("accepts canonical registry refs only", () => {
    expect(isVerifiedPlaceRef("place:45")).toBe(true);
    expect(isVerifiedPlaceRef("place:45:popular")).toBe(true);
    expect(isVerifiedPlaceRef("Hanoi@VN")).toBe(false);
    expect(isVerifiedPlaceRef("VN")).toBe(false);
    expect(isVerifiedPlaceRef("")).toBe(false);
    expect(isVerifiedPlaceRef("place:abc")).toBe(false);
  });
});

describe("reference selector unverified preview", () => {
  test("city ref shows the preview plus the unverified note", () => {
    const html = referenceSelector("Mumbai@IN");
    const copy = messagesFor("en");

    expect(html).toContain("Mumbai, IN");
    expect(html).toContain(copy.adminPlaceRefUnverified);
    expect(html).toContain("place-ref-unverified-hint");
  });

  test("canonical ref shows no unverified note", () => {
    const html = referenceSelector("place:45");

    expect(html).toContain("Registry place #45");
    expect(html).not.toContain(messagesFor("en").adminPlaceRefUnverified);
  });
});
