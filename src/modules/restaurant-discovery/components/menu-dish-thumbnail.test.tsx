import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  MENU_DISH_THUMBNAIL_PX,
  MenuDishThumbnail,
} from "@/modules/restaurant-discovery/components/menu-dish-thumbnail";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_NAME = "Pho Bo";

describe("MenuDishThumbnail fallback (no trustworthy item photo today)", () => {
  test("renders a neutral icon in the fixed footprint with an accessible label", () => {
    const html = renderToStaticMarkup(
      <MenuDishThumbnail itemId={ITEM_ID} itemName={ITEM_NAME} media={null} />,
    );

    expect(html).toContain(`data-item-id="${ITEM_ID}"`);
    expect(html).toContain('data-thumbnail="fallback"');
    expect(html).toContain("sr-only");
    expect(html).toContain(`No verified photo for ${ITEM_NAME}`);
    expect(html).toContain("<svg");
    expect(html).toContain(`width:${MENU_DISH_THUMBNAIL_PX}px`);
    expect(html).toContain(`height:${MENU_DISH_THUMBNAIL_PX}px`);
    expect(html).not.toContain("<img");
  });

  test("fallback never invents photo copy, initials tiles, or remote imagery", () => {
    const html = renderToStaticMarkup(
      <MenuDishThumbnail itemId={ITEM_ID} itemName={ITEM_NAME} media={null} />,
    );

    expect(html).not.toContain("Photo coming soon");
    expect(html).not.toContain("/api/v1/");
    expect(html).not.toContain("res-photo");
    expect(html).not.toContain("RestaurantPhotoFallback");
  });

  test("custom fallback label is honored for localized callers", () => {
    const html = renderToStaticMarkup(
      <MenuDishThumbnail
        itemId={ITEM_ID}
        itemName="Phở Bò"
        media={null}
        fallbackLabel="Chưa có ảnh đã kiểm chứng cho Phở Bò"
      />,
    );

    expect(html).toContain("Chưa có ảnh đã kiểm chứng cho Phở Bò");
  });
});

describe("MenuDishThumbnail with resolved authorized media", () => {
  const media = {
    alt: "A verified bowl of pho bo",
    attribution: "Photo by Linh Tran",
    height: 900,
    sizes: "68px",
    src: "/api/v1/item-images/abc/1/800",
    srcSet: "/api/v1/item-images/abc/1/400 400w, /api/v1/item-images/abc/1/800 800w",
    width: 1200,
  } as const;

  test("reserves dimensions, lazy-loads, and keeps attribution out of the footprint", () => {
    const html = renderToStaticMarkup(
      <MenuDishThumbnail itemId={ITEM_ID} itemName={ITEM_NAME} media={media} />,
    );

    expect(html).toContain('data-thumbnail="photo"');
    expect(html).toContain(`src="${media.src}"`);
    expect(html).toContain("400w");
    expect(html).toContain('sizes="68px"');
    expect(html).toContain('width="1200"');
    expect(html).toContain('height="900"');
    expect(html).toContain(`alt="${media.alt}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain(`title="${media.attribution}"`);
    expect(html).toContain("sr-only");
    expect(html).not.toContain("<svg");
  });

  test("eager mode opts into eager loading for detail views", () => {
    const html = renderToStaticMarkup(
      <MenuDishThumbnail itemId={ITEM_ID} itemName={ITEM_NAME} media={media} eager={true} />,
    );

    expect(html).toContain('loading="eager"');
  });

  test("defaults sizes to the fixed footprint when srcSet has no explicit sizes", () => {
    const { sizes: _dropped, ...withoutSizes } = media;

    expect(_dropped).toBe("68px");

    const html = renderToStaticMarkup(
      <MenuDishThumbnail itemId={ITEM_ID} itemName={ITEM_NAME} media={withoutSizes} />,
    );

    expect(html).toContain(`sizes="${MENU_DISH_THUMBNAIL_PX}px"`);
  });
});

describe("MenuDishThumbnail refuses untrustworthy media", () => {
  test("empty alt falls back instead of rendering an invented label", () => {
    const html = renderToStaticMarkup(
      <MenuDishThumbnail
        itemId={ITEM_ID}
        itemName={ITEM_NAME}
        media={{
          alt: "   ",
          height: 800,
          src: "/api/v1/item-images/abc/1/800",
          width: 800,
        }}
      />,
    );

    expect(html).toContain('data-thumbnail="fallback"');
    expect(html).not.toContain("<img");
  });

  test("missing dimensions fall back instead of shifting layout", () => {
    const html = renderToStaticMarkup(
      <MenuDishThumbnail
        itemId={ITEM_ID}
        itemName={ITEM_NAME}
        media={{ alt: "alt", height: 0, src: "/api/v1/item-images/abc/1/800", width: 0 }}
      />,
    );

    expect(html).toContain('data-thumbnail="fallback"');
    expect(html).not.toContain("<img");
  });

  test("blank src falls back instead of rendering a broken image", () => {
    const html = renderToStaticMarkup(
      <MenuDishThumbnail
        itemId={ITEM_ID}
        itemName={ITEM_NAME}
        media={{ alt: "alt", height: 800, src: "   ", width: 800 }}
      />,
    );

    expect(html).toContain('data-thumbnail="fallback"');
    expect(html).not.toContain("<img");
  });
});
