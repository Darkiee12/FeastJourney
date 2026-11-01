import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  formatPlaceContext,
  isCanonicalPlaceId,
  normalizeParentId,
} from "@/components/admin/places/place-grammar";
import { PlaceSelector } from "@/components/admin/places/PlaceSelector";
import { messagesFor } from "@/shared/i18n";

/**
 * Parent-filter pins for the /admin/places toolbar rework.
 *
 * The toolbar filters by canonical decimal place id underneath, but the
 * control is a searchable human-readable selector: geographic context
 * labels (`Hanoi, Vietnam`), never a raw id input. Interaction (debounced
 * search, keyboard nav, label resolution) is covered by Playwright, not
 * bun:test — no DOM renderer is installed in this repo. These tests pin
 * the pure helpers plus the SSR markup contract the interaction relies on.
 */

describe("canonical parent-id boundary", () => {
  test("accepts trimmed decimal ids only", () => {
    expect(isCanonicalPlaceId("42")).toBe(true);
    expect(isCanonicalPlaceId("  42 ")).toBe(true);
    expect(isCanonicalPlaceId("")).toBe(false);
    expect(isCanonicalPlaceId("place:42")).toBe(false);
    expect(isCanonicalPlaceId("VN")).toBe(false);
    expect(isCanonicalPlaceId("4.2")).toBe(false);
  });

  test("normalizeParentId keeps valid ids, drops everything else", () => {
    expect(normalizeParentId("  42 ")).toBe("42");
    expect(normalizeParentId("")).toBeNull();
    expect(normalizeParentId("place:42")).toBeNull();
    expect(normalizeParentId("VN")).toBeNull();
  });
});

describe("geographic context labels", () => {
  test("prefers the parent name over the ISO code", () => {
    expect(
      formatPlaceContext({
        name: "Hanoi",
        parentName: "Vietnam",
        iso: "VN",
        placeId: "7",
        lang: "en",
      }),
    ).toBe("Hanoi, Vietnam");
  });

  test("falls back to ISO, then bare name, then an explicit place label", () => {
    expect(
      formatPlaceContext({ name: "Hanoi", parentName: null, iso: "VN", placeId: "7", lang: "en" }),
    ).toBe("Hanoi, VN");
    expect(
      formatPlaceContext({ name: "Hanoi", parentName: null, iso: null, placeId: "7", lang: "en" }),
    ).toBe("Hanoi");
    expect(
      formatPlaceContext({ name: null, parentName: null, iso: null, placeId: "7", lang: "en" }),
    ).toBe("Place #7");
    expect(
      formatPlaceContext({ name: null, parentName: null, iso: null, placeId: "7", lang: "vi" }),
    ).toBe("Địa điểm #7");
  });
});

const parentFilter = (props: { lang?: "en" | "vi"; value?: string }) => {
  const lang = props.lang ?? "en";
  const copy = messagesFor(lang);

  return createElement(PlaceSelector, {
    id: "places-parent",
    label: copy.adminParentFilter,
    copy,
    lang,
    variant: "parentFilter",
    placeholder: copy.adminSearchPlacesPlaceholder,
    value: props.value ?? "",
    onChange: () => undefined,
  });
};

describe("parent-filter selector SSR contract", () => {
  test("renders a combobox with the shared search placeholder", () => {
    const html = renderToStaticMarkup(parentFilter({ value: "" }));

    expect(html).toContain('role="combobox"');
    expect(html).toContain('id="places-parent"');
    expect(html).toContain('for="places-parent"');
    expect(html).toContain(messagesFor("en").adminSearchPlacesPlaceholder);
    expect(html).toContain('aria-autocomplete="list"');
  });

  test("empty value shows no clear control", () => {
    const html = renderToStaticMarkup(parentFilter({ value: "" }));

    expect(html).not.toContain(messagesFor("en").adminRemove);
  });

  test("selected value exposes a labeled clear control", () => {
    const html = renderToStaticMarkup(parentFilter({ value: "42" }));

    // SSR has no effects, so the resolved `Hanoi, Vietnam` label arrives
    // client-side; the clear affordance itself must exist from first paint.
    expect(html).toContain(`aria-label="${messagesFor("en").adminRemove}"`);
  });

  test("label matches the i18n parent key in en and vi", () => {
    const en = renderToStaticMarkup(parentFilter({ lang: "en", value: "" }));
    const vi = renderToStaticMarkup(parentFilter({ lang: "vi", value: "" }));

    expect(en).toContain(messagesFor("en").adminParentFilter);
    expect(vi).toContain(messagesFor("vi").adminParentFilter);
  });
});

describe("reference selector unchanged", () => {
  test("default variant keeps the grammar input and hint", () => {
    const copy = messagesFor("en");

    const html = renderToStaticMarkup(
      createElement(PlaceSelector, {
        id: "place-parent-ref",
        label: copy.adminParentFilter,
        copy,
        lang: "en",
        value: "",
        onChange: () => undefined,
      }),
    );

    expect(html).not.toContain('role="combobox"');
    expect(html).toContain("Hanoi@VN:associated");
    expect(html).toContain(copy.adminPlaceRefHint);
  });
});
