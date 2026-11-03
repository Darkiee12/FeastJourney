import { describe, expect, test } from "bun:test";

import { DISH_ACTION_ORDER, dishRestaurantsSearch } from "@/components/dish/dish-actions";
import {
  DISH_CAROUSEL_GEOMETRY,
  DISH_FEATURE_MEDIA_MOBILE,
  DISH_FEATURE_STAGE_DESKTOP,
} from "@/components/dish/dish-carousel";

/**
 * Agent B shared-action contracts (bun:test, no DOM renderer in this repo).
 * Router-bound markup (Link hrefs, SaveDishButton states) is covered by
 * Playwright, not here: `useNavigate`/React Query throw outside providers.
 */

describe("dish action identity", () => {
  test("order, icons, and targets stay identical across layouts", () => {
    expect([...DISH_ACTION_ORDER]).toEqual(["explore", "save", "restaurants"]);
  });
});

describe("dish restaurants search", () => {
  test("carries canonical dish identity, never a name text-match", () => {
    expect(dishRestaurantsSearch("101", "pho-bo", "en")).toEqual({
      dish: "101",
      fromDish: "pho-bo",
      lang: "en",
    });
  });

  test("keeps Vietnamese locale and slug back-link intact", () => {
    const search = dishRestaurantsSearch("202", "bun-cha", "vi");

    expect(search.lang).toBe("vi");
    expect(search.dish).toBe("202");
    expect(search.fromDish).toBe("bun-cha");
    expect("name" in search).toBe(false);
    expect("q" in search).toBe(false);
  });

  test("dish filter id matches the restaurant search decimal-id shape", () => {
    const search = dishRestaurantsSearch("101", "pho-bo", "en");

    expect(search.dish).toMatch(/^[1-9][0-9]{0,18}$/);
  });
});

describe("dish feature geometry tokens", () => {
  test("mobile media frame is a bounded height, not an intrinsic aspect", () => {
    expect(DISH_FEATURE_MEDIA_MOBILE).toBe("clamp(180px, 48vw, 240px)");
  });

  test("desktop stage pins a stable height without forcing giant viewports", () => {
    expect(DISH_FEATURE_STAGE_DESKTOP).toBe("clamp(330px, 34vw, 410px)");
  });

  test("section custom properties expose exactly the starting tokens", () => {
    expect(DISH_CAROUSEL_GEOMETRY["--dish-feature-media-mobile"]).toBe(DISH_FEATURE_MEDIA_MOBILE);
    expect(DISH_CAROUSEL_GEOMETRY["--dish-feature-stage-desktop"]).toBe(DISH_FEATURE_STAGE_DESKTOP);
  });
});
