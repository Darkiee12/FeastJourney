import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MODEL_BASE_URL,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_TIMEOUT_MS,
  isSupportedModelId,
  RankingConfig,
  resolveRankingConfig,
  type ServerEnv,
} from "@/server/env";
import {
  RankingFailureDisposition,
  dispositionForMetaError,
  MetaAuthError,
  MetaInvalidOutput,
  MetaPermanentError,
  MetaRateLimited,
  MetaRequestError,
} from "@/server/integrations/meta-client";

const baseEnv: ServerEnv = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/db",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "at-least-32-characters-long-secret",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  FACEBOOK_CLIENT_ID: "facebook-id",
  FACEBOOK_CLIENT_SECRET: "facebook-secret",
  SMTP_HOST: "localhost",
  SMTP_PORT: 1025,
  SMTP_USERNAME: "user",
  SMTP_PASSWORD: "pw",
  EMAIL_FROM: "test@example.com",
  TRUSTED_PROXIES: "",
  RECOMMENDATION_PROVIDER: "deterministic",
};

const withOverrides = (overrides: Partial<ServerEnv>): ServerEnv => ({ ...baseEnv, ...overrides });

describe("resolveRankingConfig", () => {
  test("deterministic is the default with documented limits", () => {
    const config = resolveRankingConfig(withOverrides({}));

    RankingConfig.$match(config, {
      Deterministic: ({ candidateLimit, outputLimit }) => {
        expect(candidateLimit).toBe(60);
        expect(outputLimit).toBe(10);
      },
      Muse: () => expect.unreachable("expected Deterministic"),
      Misconfigured: () => expect.unreachable("expected Deterministic"),
    });
  });

  test("an unset provider is deterministic (output-optional by design)", () => {
    const { RECOMMENDATION_PROVIDER: _dropped, ...withoutProvider } = withOverrides({});

    RankingConfig.$match(resolveRankingConfig(withoutProvider), {
      Deterministic: () => undefined,
      Muse: () => expect.unreachable("expected Deterministic"),
      Misconfigured: () => expect.unreachable("expected Deterministic"),
    });
  });

  test("deterministic ignores provider credentials by explicit selection", () => {
    const config = resolveRankingConfig(
      withOverrides({ MODEL_API_KEY: "key", MODEL_MODEL_ID: "muse-spark-1.1" }),
    );

    RankingConfig.$match(config, {
      Deterministic: () => undefined,
      Muse: () => expect.unreachable("expected Deterministic"),
      Misconfigured: () => expect.unreachable("expected Deterministic"),
    });
  });

  test("muse with a key resolves with documented defaults", () => {
    const config = resolveRankingConfig(
      withOverrides({ RECOMMENDATION_PROVIDER: "muse", MODEL_API_KEY: "key" }),
    );

    RankingConfig.$match(config, {
      Deterministic: () => expect.unreachable("expected Muse"),
      Muse: ({ apiKey, modelId, baseUrl, timeoutMs, candidateLimit, outputLimit, maxTokens }) => {
        expect(apiKey).toBe("key");
        expect(modelId).toBe(DEFAULT_MODEL_ID);
        expect(baseUrl).toBe(DEFAULT_MODEL_BASE_URL);
        expect(timeoutMs).toBe(DEFAULT_MODEL_TIMEOUT_MS);
        expect(candidateLimit).toBe(60);
        expect(outputLimit).toBe(10);
        expect(maxTokens).toBe(4000);
      },
      Misconfigured: () => expect.unreachable("expected Muse"),
    });
  });

  test("muse without a key is misconfigured, never silent", () => {
    for (const apiKey of [undefined, ""]) {
      const config = resolveRankingConfig(
        withOverrides({ RECOMMENDATION_PROVIDER: "muse", MODEL_API_KEY: apiKey }),
      );

      RankingConfig.$match(config, {
        Deterministic: () => expect.unreachable("expected Misconfigured"),
        Muse: () => expect.unreachable("expected Misconfigured"),
        Misconfigured: ({ reason }) => expect(reason).toContain("MODEL_API_KEY"),
      });
    }
  });

  test("muse accepts any Spark release and tier without a code change", () => {
    // Shape-validated (including versions that do not exist yet and the
    // Contributor tier): well-formedness is the config layer's job, while
    // existence is the provider's job at request time.
    for (const modelId of [
      "muse-spark-1.1",
      "muse-spark-1.2",
      "muse-spark-1.3",
      "muse-spark-1.4",
      "muse-spark-2.0",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "muse-spark-9.9",
      "muse-wonder-1.0",
      "muse-wonder-2.3",
    ]) {
      expect(isSupportedModelId(modelId)).toBe(true);

      const config = resolveRankingConfig(
        withOverrides({
          RECOMMENDATION_PROVIDER: "muse",
          MODEL_API_KEY: "key",
          MODEL_MODEL_ID: modelId,
        }),
      );

      RankingConfig.$match(config, {
        Deterministic: () => expect.unreachable(`expected Muse for ${modelId}`),
        Muse: ({ modelId: resolved }) => expect(resolved).toBe(modelId),
        Misconfigured: () => expect.unreachable(`expected Muse for ${modelId}`),
      });
    }
  });

  test("muse rejects out-of-shape model identities", () => {
    for (const modelId of [
      "",
      "gpt-4",
      "muse-spark",
      "muse-spark-1",
      "muse-sparc-1.3",
      "muse-glimmer-1.0",
      "muse-wonder-1.0-contributor",
      "muse-spark-1.3-contributo",
    ]) {
      expect(isSupportedModelId(modelId)).toBe(false);

      const config = resolveRankingConfig(
        withOverrides({
          RECOMMENDATION_PROVIDER: "muse",
          MODEL_API_KEY: "key",
          MODEL_MODEL_ID: modelId,
        }),
      );

      RankingConfig.$match(config, {
        Deterministic: () => expect.unreachable(`expected Misconfigured for ${modelId}`),
        Muse: () => expect.unreachable(`expected Misconfigured for ${modelId}`),
        Misconfigured: ({ reason }) => expect(reason).toContain("muse-spark-"),
      });
    }
  });

  test("muse requires an https base URL", () => {
    for (const baseUrl of ["http://api.meta.ai/v1", "not-a-url", ""]) {
      const config = resolveRankingConfig(
        withOverrides({
          RECOMMENDATION_PROVIDER: "muse",
          MODEL_API_KEY: "key",
          MODEL_BASE_URL: baseUrl,
        }),
      );

      RankingConfig.$match(config, {
        Deterministic: () => expect.unreachable("expected Misconfigured"),
        Muse: () => expect.unreachable("expected Misconfigured"),
        Misconfigured: ({ reason }) => expect(reason).toContain("MODEL_BASE_URL"),
      });
    }

    const https = resolveRankingConfig(
      withOverrides({
        RECOMMENDATION_PROVIDER: "muse",
        MODEL_API_KEY: "key",
        MODEL_BASE_URL: "https://proxy.internal/v1",
      }),
    );

    RankingConfig.$match(https, {
      Deterministic: () => expect.unreachable("expected Muse"),
      Muse: () => undefined,
      Misconfigured: () => expect.unreachable("expected Muse"),
    });
  });
});

describe("dispositionForMetaError", () => {
  test("auth failures fail loudly", () => {
    let fails = 0;

    for (const status of [401, 403] as const) {
      RankingFailureDisposition.$match(
        dispositionForMetaError(new MetaAuthError({ reason: "denied", status })),
        {
          Fail: () => {
            fails += 1;
          },
          Fallback: () => expect.unreachable("auth failures must fail"),
        },
      );
    }

    expect(fails).toBe(2);
  });

  test("permanent failures fail loudly", () => {
    let fails = 0;

    for (const status of [400, 404, 422]) {
      RankingFailureDisposition.$match(
        dispositionForMetaError(new MetaPermanentError({ reason: "rejected", status })),
        {
          Fail: () => {
            fails += 1;
          },
          Fallback: () => expect.unreachable("permanent failures must fail"),
        },
      );
    }

    expect(fails).toBe(3);
  });

  test("rate limiting degrades with a rate-limit warning", () => {
    for (const retryAfterSeconds of [undefined, 30]) {
      const disposition = dispositionForMetaError(
        new MetaRateLimited({ reason: "limited", retryAfterSeconds }),
      );

      RankingFailureDisposition.$match(disposition, {
        Fail: () => expect.unreachable("rate limiting must degrade"),
        Fallback: ({ warning }) => expect(warning).toContain("rate-limit"),
      });
    }
  });

  test("transient and malformed output degrade with the unavailable warning", () => {
    const requestError = dispositionForMetaError(
      new MetaRequestError({ reason: "boom", status: 503 }),
    );

    RankingFailureDisposition.$match(requestError, {
      Fail: () => expect.unreachable("transient failures must degrade"),
      Fallback: ({ warning }) => expect(warning).toContain("unavailable"),
    });

    const timeout = dispositionForMetaError(new MetaRequestError({ reason: "timeout" }));

    expect(timeout).toEqual(requestError);

    const invalid = dispositionForMetaError(new MetaInvalidOutput({ reason: "bad shape" }));

    expect(invalid).toEqual(requestError);
  });
});
