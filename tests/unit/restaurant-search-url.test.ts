import { expect, test } from "bun:test";

import { stringifySearchWith } from "@tanstack/react-router";

import { restaurantSearchSchema } from "@/modules/restaurant-discovery/restaurant.schema";
import { parseTextSearch } from "@/shared/search-params";

test("direct dish and exact budget URLs never pass through number parsing", () => {
  const parsed = parseTextSearch(
    "?dish=9007199254740993&budget=2.200000000000000001&portion=regular-bowl&currency=USD",
  );

  expect(parsed.dish).toBe("9007199254740993");
  expect(parsed.budget).toBe("2.200000000000000001");
  const input = restaurantSearchSchema.parse(parsed);
  expect(input.dish).toBe("9007199254740993");
  expect(input.budget).toBe("2.200000000000000001");
});

test("new links round-trip scalar strings and geographic numbers", () => {
  const query = stringifySearchWith(JSON.stringify)({
    dish: "2",
    budget: "2.20",
    longitude: 106.7,
    latitude: 10.8,
  });

  expect(parseTextSearch(query)).toEqual({
    dish: "2",
    budget: "2.20",
    longitude: "106.7",
    latitude: "10.8",
  });
});

test("old quoted IDs and duplicate scalar rejection remain compatible", () => {
  expect(parseTextSearch("?dish=%222%22&budget=%222.20%22")).toEqual({ dish: "2", budget: "2.20" });
  expect(restaurantSearchSchema.safeParse(parseTextSearch("?dish=1&dish=2")).success).toBe(false);
  expect(parseTextSearch("?q=%22broken").q).toBe('"broken');
});
