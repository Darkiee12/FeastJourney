import { describe, expect, test } from "bun:test";

import { Option } from "effect";

import { recommendationQuerySchema } from "@/modules/food-discovery/food.schema";
import {
  MEAL_OCCASIONS,
  RECOMMENDATION_MOODS,
} from "@/modules/food-discovery/recommendation.constants";
import {
  MAX_REASON_LENGTH,
  RANKING_RESPONSE_FORMAT,
  RANKING_SCHEMA,
  decodeRankingPayload,
} from "@/server/integrations/meta-client";

describe("recommendation transport/domain parity", () => {
  test("transport accepts exactly the domain meal and mood vocabularies", () => {
    for (const meal of MEAL_OCCASIONS) {
      const parsed = recommendationQuerySchema.safeParse({ meal, mood: "any" });

      expect(parsed.success).toBe(true);
    }

    for (const mood of RECOMMENDATION_MOODS) {
      const parsed = recommendationQuerySchema.safeParse({ meal: "anything", mood });

      expect(parsed.success).toBe(true);
    }

    expect(recommendationQuerySchema.safeParse({ meal: "brunch", mood: "any" }).success).toBe(
      false,
    );
    expect(recommendationQuerySchema.safeParse({ meal: "anything", mood: "sleepy" }).success).toBe(
      false,
    );
  });
});

describe("provider schema parity", () => {
  test("provider schema pins the exact ranking contract", () => {
    expect(RANKING_SCHEMA.type).toBe("object");
    expect(RANKING_SCHEMA.required).toEqual(["ranked_candidate_ids", "reasons"]);
    expect(RANKING_SCHEMA.additionalProperties).toBe(false);
    expect(RANKING_SCHEMA.properties.ranked_candidate_ids).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(RANKING_SCHEMA.properties.reasons).toEqual({
      type: "array",
      items: { type: "string", maxLength: MAX_REASON_LENGTH },
    });
    expect(MAX_REASON_LENGTH).toBe(340);
  });

  test("provider schema stays within the strict:true subset", () => {
    expect(RANKING_SCHEMA.type).toBe("object");
    expect(RANKING_SCHEMA.additionalProperties).toBe(false);
    expect(Object.keys(RANKING_SCHEMA.properties).toSorted()).toEqual(
      [...RANKING_SCHEMA.required].toSorted(),
    );
  });

  test("request envelope pins strict structured output", () => {
    expect(RANKING_RESPONSE_FORMAT.type).toBe("json_schema");
    expect(RANKING_RESPONSE_FORMAT.json_schema.name).toBe("dish_ranking");
    expect(RANKING_RESPONSE_FORMAT.json_schema.strict).toBe(true);
    expect(RANKING_RESPONSE_FORMAT.json_schema.schema).toBe(RANKING_SCHEMA);
  });

  test("canonical codec accepts provider-shaped payloads and rejects the rest", () => {
    const valid = decodeRankingPayload(
      JSON.parse('{"ranked_candidate_ids": ["1", "2"], "reasons": ["a", "b"]}'),
    );

    expect(Option.isSome(valid)).toBe(true);

    const missing = decodeRankingPayload(JSON.parse("{}"));

    expect(Option.isNone(missing)).toBe(true);

    const wrongItems = decodeRankingPayload(JSON.parse('{"ranked_candidate_ids": [1, 2]}'));

    expect(Option.isNone(wrongItems)).toBe(true);

    const missingReasons = decodeRankingPayload(JSON.parse('{"ranked_candidate_ids": ["1"]}'));

    expect(Option.isNone(missingReasons)).toBe(true);

    const longReason = decodeRankingPayload(
      JSON.parse(
        `{"ranked_candidate_ids": ["1"], "reasons": ["${"x".repeat(MAX_REASON_LENGTH + 1)}"]}`,
      ),
    );

    expect(Option.isNone(longReason)).toBe(true);

    const atLimit = decodeRankingPayload(
      JSON.parse(
        `{"ranked_candidate_ids": ["1"], "reasons": ["${"x".repeat(MAX_REASON_LENGTH)}"]}`,
      ),
    );

    expect(Option.isSome(atLimit)).toBe(true);
  });
});
