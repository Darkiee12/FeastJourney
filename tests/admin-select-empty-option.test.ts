import { describe, expect, test } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminSelect, AdminSelectField } from "@/components/admin/select";

/**
 * Empty-string "All …" filter options: Radix `Select.Item` forbids `""`
 * values, so `select.tsx` maps `""` ↔ a private nonempty sentinel
 * internally while routes keep `value=""` with empty-filter semantics.
 * Interaction (open, keyboard, viewport containment) stays Playwright
 * territory — no DOM renderer is installed here.
 */

const KIND_OPTIONS = [
  { label: "All kinds", value: "" },
  { label: "City", value: "city" },
  { label: "Locality", value: "locality" },
] as const;

const options = [...KIND_OPTIONS];

describe("AdminSelect empty-option sentinel", () => {
  test("value empty selects the All entry and tooltips its label", () => {
    const html = renderToStaticMarkup(
      createElement(AdminSelect, {
        ariaLabel: "Kind",
        value: "",
        onValueChange: () => undefined,
        options,
        placeholder: "Kind",
      }),
    );

    expect(html).toContain('title="All kinds"');
    expect(html).not.toContain('value=""');
  });

  test("real values keep their own tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(AdminSelect, {
        ariaLabel: "Kind",
        value: "city",
        onValueChange: () => undefined,
        options,
        placeholder: "Kind",
      }),
    );

    expect(html).toContain('title="City"');
  });

  test("unknown values fall back to the placeholder tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(AdminSelect, {
        ariaLabel: "Kind",
        value: "not-a-kind",
        onValueChange: () => undefined,
        options,
        placeholder: "Kind",
      }),
    );

    expect(html).toContain('title="Kind"');
    expect(html).not.toContain("not-a-kind");
  });

  test("selects without an empty option still render the placeholder for undefined", () => {
    const html = renderToStaticMarkup(
      createElement(AdminSelectField, {
        id: "role-grant",
        label: "Assign role",
        value: undefined,
        onValueChange: () => undefined,
        options: [{ label: "Curator", value: "curator" }],
        placeholder: "Choose a role",
      }),
    );

    expect(html).toContain("Choose a role");
    expect(html).toContain('data-state="closed"');
  });
});

describe("AdminSelect sizing and truncation contract", () => {
  test("trigger never collapses to icon-only width", () => {
    const html = renderToStaticMarkup(
      createElement(AdminSelect, {
        ariaLabel: "Kind",
        value: "city",
        onValueChange: () => undefined,
        options,
      }),
    );

    expect(html).toContain("min-w-44");
  });

  test("trigger value truncates instead of wrapping", () => {
    const html = renderToStaticMarkup(
      createElement(AdminSelect, {
        ariaLabel: "Kind",
        value: "city",
        onValueChange: () => undefined,
        options,
      }),
    );

    // Arbitrary variants are HTML-escaped in SSR markup (`[&amp;&gt;span]`),
    // so pin the unescaped utilities they carry.
    expect(html).toContain("truncate");
    expect(html).toContain("overflow-hidden");
  });
});
