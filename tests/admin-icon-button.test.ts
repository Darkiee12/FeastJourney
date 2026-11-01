import { describe, expect, test } from "bun:test";

import { Pencil } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EditTrigger } from "@/components/admin/dish/section-editor";
import { AdminIconButton } from "@/components/admin/ui";
import { messagesFor } from "@/shared/i18n";

/**
 * Pencil = edit icon-button contract plus the section-editor triggers that
 * render it. SSR markup pins: 44px target, tooltip + accessible name,
 * tones, loading/disabled, and the fixed-size resolving slot. Permission
 * gating itself (fail-closed `useFoodUpdateAllowed`) is unchanged.
 */

const copy = messagesFor("en");

const pencil = (props?: { ariaHidden?: boolean }) =>
  createElement(AdminIconButton, {
    icon: createElement(Pencil, { "aria-hidden": props?.ariaHidden ?? true, className: "size-4" }),
    label: copy.adminEdit,
    onClick: () => undefined,
  });

describe("AdminIconButton", () => {
  test("names itself for assistive tech and hover", () => {
    const html = renderToStaticMarkup(pencil());

    expect(html).toContain(`aria-label="${copy.adminEdit}"`);
    expect(html).toContain(`title="${copy.adminEdit}"`);
  });

  test("hits the 44px touch target with a visible focus ring", () => {
    const html = renderToStaticMarkup(pencil());

    expect(html).toContain("size-11");
    expect(html).toContain("focus-visible:ring-2");
  });

  test("default tone is a neutral bordered button", () => {
    const html = renderToStaticMarkup(pencil());

    expect(html).toContain("border-border-soft");
    expect(html).toContain("hover:bg-cream");
  });

  test("danger tone warns without relying on color alone", () => {
    const html = renderToStaticMarkup(
      createElement(AdminIconButton, {
        icon: createElement(Pencil, { "aria-hidden": true, className: "size-4" }),
        label: "Remove",
        onClick: () => undefined,
        tone: "danger",
      }),
    );

    expect(html).toContain("text-red-700");
    expect(html).toContain('aria-label="Remove"');
  });

  test("loading disables the button and announces busy", () => {
    const html = renderToStaticMarkup(
      createElement(AdminIconButton, {
        icon: createElement(Pencil, { "aria-hidden": true, className: "size-4" }),
        label: copy.adminEdit,
        onClick: () => undefined,
        loading: true,
      }),
    );

    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
  });

  test("disabled buttons stay inert", () => {
    const html = renderToStaticMarkup(
      createElement(AdminIconButton, {
        icon: createElement(Pencil, { "aria-hidden": true, className: "size-4" }),
        label: copy.adminEdit,
        onClick: () => undefined,
        disabled: true,
      }),
    );

    expect(html).toContain("disabled");
    expect(html).toContain("disabled:cursor-not-allowed");
  });
});

describe("EditTrigger pencil action", () => {
  test("visible trigger is the pencil icon-button, not a text Edit button", () => {
    const html = renderToStaticMarkup(
      createElement(EditTrigger, { copy, hidden: false, onOpen: () => undefined }),
    );

    expect(html).toContain(`aria-label="${copy.adminEdit}"`);
    expect(html).toContain("lucide-pencil");
    expect(html).not.toContain("min-w-[4.5rem]");
  });

  test("resolving trigger reserves a fixed icon-sized slot", () => {
    const html = renderToStaticMarkup(
      createElement(EditTrigger, { copy, hidden: true, onOpen: () => undefined }),
    );

    expect(html).not.toContain("<button");
    expect(html).toContain("size-11");
    expect(html).toContain('aria-hidden="true"');
  });
});
