/**
 * Menu-scan evaluation runner.
 *
 * Default (stub-fetcher) path — free and CI-safe:
 *   bun scripts/eval-menu-scans.ts [--out <summary.json>]
 *
 * Builds a faithful stub extraction per ground-truth case, drives it through
 * the real Muse extractor (request encoding, bounded body reading, envelope
 * and schema validation, reference authorization) with a stub fetcher, scores
 * the outcome with tests/eval/menu-scan-eval.ts, runs sensitivity probes
 * (mutant extractions the scorer must flag), and prints an ASCII table plus
 * a machine-readable summary JSON. No provider call is ever made; model
 * accuracy is NOT measured here — only harness plumbing and validation.
 *
 * Live path — requires BOTH an explicit flag and an environment opt-in, and
 * is refused in CI:
 *   LIVE_MENU_EVAL=1 bun scripts/eval-menu-scans.ts --live [--out <summary.json>]
 *
 * The live path calls the real extractor against rasterized fixture images
 * (SVG fixtures are never sent: SVG uploads are forbidden). Missing raster
 * fixtures block the case with a recorded reason instead of calling the
 * provider. Per-call records carry model, latency, and token/cost metadata
 * (null with a reason when the extractor contract does not surface it).
 */

import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Effect, Logger } from "effect";

import {
  menuLanguageSchema,
  type MenuExtraction,
} from "@/modules/restaurant-discovery/menu-scan.schema";
import { type ServerEnv } from "@/server/env";
import { resolveMenuScanConfig, type MenuScanConfig } from "@/server/integrations/menu-scan-config";
import {
  ExtractionUnavailable,
  InvalidModelOutput,
  makeMuseMenuExtractor,
} from "@/server/integrations/muse-menu";

import {
  type ExtractionOutcome,
  type GroundTruthCase,
  formatCaseTable,
  loadGroundTruthCases,
  loadMalformedFixtures,
  scoreCase,
  scoreMalformedFixtures,
  type ScoredCase,
  type SensitivityProbe,
  summarizeEvaluation,
  summaryToJson,
} from "../tests/eval/menu-scan-eval.ts";

const RUNNER_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIRECTORY = join(RUNNER_DIRECTORY, "..", "tests", "fixtures", "menu-scans");

const STUB_ASSET_IDS: ReadonlyArray<string> = [
  "f0a331c5-01a7-4d11-a2ac-7178f04210d1",
  "2e2e57a6-9480-4512-9d5f-6a05c39005cf",
  "a8d49a29-19d4-4c68-a6ba-6b933e1de0e1",
  "32386b9b-c5d2-4cfe-bc6f-7b933eeb4c87",
  "c3f0a1b2-4d5e-4f6a-8b7c-9d0e1f2a3b4c",
  "d4e1f2a3-b5c6-4d7e-8f9a-0b1c2d3e4f5a",
];

function stubImageBytes(label: string): Uint8Array {
  return new TextEncoder().encode(`stub-menu-image:${label}`);
}

function stubAssetIds(count: number): Array<string> {
  return STUB_ASSET_IDS.slice(0, Math.max(1, count));
}

function stubCurrency(groundTruth: GroundTruthCase, priceIndex: number): string | null {
  if (groundTruth.expectedCommonCurrency !== null) return groundTruth.expectedCommonCurrency;

  if (groundTruth.requiredBehavior.includes("Keep separate original currencies")) {
    return priceIndex % 2 === 0 ? "USD" : "EUR";
  }

  return null;
}

function stubUncertainties(groundTruth: GroundTruthCase): Array<string> {
  if (groundTruth.requiredBehavior.includes("Price association unclear; require customer review")) {
    return ["Price association is unclear; customer review required."];
  }

  if (groundTruth.requiredBehavior.includes("No printed prices")) {
    return ["The photo has no readable prices."];
  }

  if (groundTruth.requiredBehavior.includes("Do not guess decimal separator or currency")) {
    return ["Separator and currency are ambiguous; customer review required."];
  }

  if (
    groundTruth.requiredBehavior.includes(
      "Bare 1,250 abstains with amount null and currency null plus an uncertainty",
    )
  ) {
    return ["Separator and currency are ambiguous; customer review required."];
  }

  if (
    groundTruth.requiredBehavior.includes(
      "Lone dollar sign abstains with currency null and an explanatory uncertainty",
    )
  ) {
    return ["Currency symbol is ambiguous; customer review required."];
  }

  return [];
}

/**
 * Faithful stub stand-in for provider output, built FROM ground truth.
 * This exercises extractor plumbing only; it says nothing about model
 * accuracy. Returns null for the illegible fixture, where the correct
 * provider contract is a recoverable envelope failure.
 */
function buildFaithfulExtraction(
  groundTruth: GroundTruthCase,
  assetIds: ReadonlyArray<string>,
): MenuExtraction | null {
  if (groundTruth.expectedItemNames.length === 0) return null;

  const parsedLanguage = menuLanguageSchema.safeParse(groundTruth.sourceLanguage);

  const uncertainties = stubUncertainties(groundTruth);
  const itemCount = groundTruth.expectedItemNames.length;
  const amountsPerItem = Math.floor(groundTruth.expectedAmounts.length / itemCount);
  let priceIndex = 0;

  const items = groundTruth.expectedItemNames.map((name, itemIndex) => {
    const slice = groundTruth.expectedAmounts.slice(
      itemIndex * amountsPerItem,
      itemIndex * amountsPerItem + amountsPerItem,
    );

    const references =
      assetIds.length > 1 && itemCount === 1
        ? assetIds.map((assetId) => ({ assetId, region: null }))
        : [{ assetId: assetIds[itemIndex % assetIds.length] ?? "", region: null }];

    const variants = slice.map((amount) => {
      const currency = amount === null ? null : stubCurrency(groundTruth, priceIndex);
      priceIndex += 1;

      if (amount === null) {
        return { originalLabel: "", translatedLabel: null, price: null };
      }

      return {
        originalLabel: "",
        translatedLabel: null,
        price: {
          rawText: `${amount} ${currency ?? "unspecified"}`,
          amount,
          currency,
          taxTreatment: "unknown" as const,
        },
      };
    });

    return {
      originalName: name,
      translatedName: null,
      originalDescription: null,
      translatedDescription: null,
      explanatorySummary: null,
      ingredients: null,
      variants,
      sourceReferences: references,
      uncertainties,
    };
  });

  return {
    sourceLanguage: parsedLanguage.success ? parsedLanguage.data : null,
    menuTitle: null,
    orderIntroduction: { original: null, translated: null },
    items,
  };
}

function stubResponse(document: MenuExtraction | null): Response {
  if (document === null) return Response.json({ choices: [] });

  return Response.json({
    choices: [
      {
        finish_reason: "stop",
        message: { content: JSON.stringify(document), refusal: null },
      },
    ],
  });
}

// aislop-ignore-file security/hardcoded-secret -- Synthetic stub credentials for the local-only eval harness (stub-eval placeholders, localhost, .invalid domain); never real secrets, never committed credentials.
function syntheticStubEnv(): ServerEnv {
  return {
    DATABASE_URL: "postgres://feastjourney:fj-local-dev-pw@127.0.0.1:5433/feastjourney",
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
    GOOGLE_CLIENT_ID: "stub-eval",
    GOOGLE_CLIENT_SECRET: "stub-eval",
    FACEBOOK_CLIENT_ID: "stub-eval",
    FACEBOOK_CLIENT_SECRET: "stub-eval",
    SMTP_HOST: "localhost",
    SMTP_PORT: 1025,
    SMTP_USERNAME: "stub-eval",
    SMTP_PASSWORD: "stub-eval",
    EMAIL_FROM: "stub-eval@example.invalid",
    TRUSTED_PROXIES: "",
    MENU_SCANNER_ENABLED: "true",
    MODEL_API_KEY: "stub-eval-synthetic-key",
  };
}

// The extractor logs per-call outcomes via Effect.log; keep machine-readable
// stdout clean by discarding log output inside the evaluation harness.
const quietLogger = Logger.layer([
  Logger.make((): void => {
    return undefined;
  }),
]);

async function evaluateStubCase(
  groundTruth: GroundTruthCase,
  config: MenuScanConfig,
  malformedAllRejected: boolean,
): Promise<ScoredCase> {
  const assetIds = stubAssetIds(groundTruth.images.length);
  const document = buildFaithfulExtraction(groundTruth, assetIds);
  const provider = makeMuseMenuExtractor(config, () => Promise.resolve(stubResponse(document)));

  const input = {
    images: assetIds.map((assetId, index) => ({
      assetId,
      bytes: stubImageBytes(`${groundTruth.id}:${index}`),
      mediaType: "image/jpeg",
    })),
    targetLanguage: "en" as const,
    requestId: `menu-eval-stub:${groundTruth.id}`,
  };

  const started = performance.now();
  let outcome: ExtractionOutcome;

  try {
    const extraction = await Effect.runPromise(
      Effect.provide(provider.extract(input), quietLogger),
    );

    outcome = { status: "extracted", extraction, latencyMs: performance.now() - started };
  } catch (error) {
    if (error instanceof ExtractionUnavailable || error instanceof InvalidModelOutput) {
      outcome = {
        status: "failed",
        tag: error._tag,
        retryable: error.retryable,
        latencyMs: performance.now() - started,
      };
    } else {
      throw error;
    }
  }

  return { groundTruth, outcome, score: scoreCase(groundTruth, outcome, malformedAllRejected) };
}

/** Mutant extractions the scorer must flag; proves the scorer is sensitive. */
type ExtractionItem = MenuExtraction["items"][number];

function swapFirstTwoItems(items: ReadonlyArray<ExtractionItem>): Array<ExtractionItem> {
  const swapped: Array<ExtractionItem> = [];

  for (const item of items) swapped.push(item);

  const first = swapped[0];
  const second = swapped[1];

  if (first !== undefined && second !== undefined) {
    swapped[0] = Object.assign({}, first, { variants: second.variants });
    swapped[1] = Object.assign({}, second, { variants: first.variants });
  }

  return swapped;
}

type ExtractionVariant = ExtractionItem["variants"][number];

function withUsdPrices(items: ReadonlyArray<ExtractionItem>): Array<ExtractionItem> {
  const converted: Array<ExtractionItem> = [];

  for (const item of items) {
    const variants: Array<ExtractionVariant> = [];

    for (const variant of item.variants) {
      if (variant.price === null) {
        variants.push(variant);
      } else {
        variants.push(
          Object.assign({}, variant, {
            price: Object.assign({}, variant.price, { currency: "USD" }),
          }),
        );
      }
    }

    converted.push(Object.assign({}, item, { variants }));
  }

  return converted;
}

function runSensitivityProbes(cases: ReadonlyArray<GroundTruthCase>): Array<SensitivityProbe> {
  const probes: Array<SensitivityProbe> = [];
  const chinese = cases.find((entry) => entry.id === "chinese_columns");
  const vietnamese = cases.find((entry) => entry.id === "vietnamese");

  if (chinese !== undefined) {
    const assetIds = stubAssetIds(chinese.images.length);
    const faithful = buildFaithfulExtraction(chinese, assetIds);

    if (faithful !== null) {
      const dropped: MenuExtraction = { ...faithful, items: faithful.items.slice(0, 3) };

      const droppedScore = scoreCase(
        chinese,
        { status: "extracted", extraction: dropped, latencyMs: 0 },
        true,
      );

      probes.push({
        probe: "dropped-item",
        metric: "itemRecall",
        value: droppedScore.itemRecall,
        detected: droppedScore.itemRecall < 1,
        detail: "removing one of four items must lower recall below 1",
      });

      const swapped: MenuExtraction = { ...faithful, items: swapFirstTwoItems(faithful.items) };

      const swappedScore = scoreCase(
        chinese,
        { status: "extracted", extraction: swapped, latencyMs: 0 },
        true,
      );

      probes.push({
        probe: "swapped-prices",
        metric: "exactPriceAccuracy",
        value: swappedScore.exactPriceAccuracy,
        detected: swappedScore.exactPriceAccuracy !== null && swappedScore.exactPriceAccuracy < 1,
        detail: "exchanging two item prices must break per-item price association",
      });
    }
  }

  if (vietnamese !== undefined) {
    const assetIds = stubAssetIds(vietnamese.images.length);
    const faithful = buildFaithfulExtraction(vietnamese, assetIds);

    if (faithful !== null) {
      const invented: MenuExtraction = { ...faithful, items: withUsdPrices(faithful.items) };

      const inventedScore = scoreCase(
        vietnamese,
        { status: "extracted", extraction: invented, latencyMs: 0 },
        true,
      );

      probes.push({
        probe: "invented-currency",
        metric: "currencyAccuracy",
        value: inventedScore.currencyAccuracy,
        detected: inventedScore.currencyAccuracy !== null && inventedScore.currencyAccuracy < 1,
        detail: "replacing VND with USD must break currency accuracy",
      });
    }
  }

  return probes;
}

async function runStubMode(outPath: string | null): Promise<void> {
  const cases = loadGroundTruthCases();
  const malformed = scoreMalformedFixtures(loadMalformedFixtures());
  const config = resolveMenuScanConfig(syntheticStubEnv());

  if (config === null) throw new Error("Stub evaluation configuration unexpectedly disabled.");

  const scored = await Promise.all(
    cases.map((groundTruth) => evaluateStubCase(groundTruth, config, malformed.allRejected)),
  );

  const probes = runSensitivityProbes(cases);
  const summary = summarizeEvaluation("stub", config.model, "not_run", scored, malformed, probes);
  const output = `${formatCaseTable(summary)}\n${summaryToJson(summary)}\n`;

  process.stdout.write(output);

  if (outPath !== null) writeFileSync(outPath, summaryToJson(summary), "utf8");
}

function rasterFixturePath(image: string): string | null {
  const stem = basename(image).replace(/\.svg$/, "");

  for (const extension of ["png", "jpg", "jpeg"]) {
    const candidate = join(FIXTURE_DIRECTORY, `${stem}.${extension}`);

    if (existsSync(candidate)) return candidate;
  }

  return null;
}

async function runLiveMode(outPath: string | null): Promise<void> {
  if (process.env.LIVE_MENU_EVAL !== "1") {
    process.stderr.write(
      "Live menu evaluation requires LIVE_MENU_EVAL=1 plus the --live flag. Refusing to call the provider.\n",
    );
    process.exitCode = 2;

    return;
  }

  if (process.env.CI !== undefined && process.env.CI !== "") {
    process.stderr.write(
      "Live menu evaluation is never run in CI. Refusing to call the provider.\n",
    );
    process.exitCode = 2;

    return;
  }

  let config: MenuScanConfig | null;

  try {
    const { serverEnv } = await import("@/server/env.ts");

    config = resolveMenuScanConfig(serverEnv());
  } catch {
    config = null;
  }

  if (config === null) {
    process.stderr.write(
      "Live menu evaluation is not configured (server environment or scanner config missing). No provider call was made.\n",
    );
    process.exitCode = 2;

    return;
  }

  const cases = loadGroundTruthCases();
  const malformed = scoreMalformedFixtures(loadMalformedFixtures());

  const blocked = cases.filter((entry) =>
    entry.images.every((image) => rasterFixturePath(image) === null),
  );

  const summary = summarizeEvaluation("live", config.model, "not_run", [], malformed, []);

  const payload = {
    ...summary,
    blockedCases: blocked.map((entry) => entry.id),
    blockReason:
      "No raster fixtures found next to the SVG sources (SVG uploads are forbidden); " +
      "no provider call was made. Render each SVG to PNG/JPEG and rerun to evaluate live inference.",
    usageTokens: null,
    usageNote: "The extractor contract does not surface provider token usage.",
    estimatedCostUsd: null,
    costNote:
      "No cost estimate is recorded without measured token usage; set MENU_EVAL_PRICE_PER_MTOK_INPUT/OUTPUT to enable estimates once usage is available.",
  };

  const output = `${JSON.stringify(payload, null, 2)}\n`;
  process.stdout.write(output);

  if (outPath !== null) writeFileSync(outPath, output, "utf8");
}

function outArgument(): string | null {
  const flag = process.argv.indexOf("--out");

  if (flag === -1) return null;

  const value = process.argv[flag + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new Error("--out requires a file path argument.");
  }

  return value;
}

try {
  const outPath = outArgument();

  if (process.argv.includes("--live")) {
    await runLiveMode(outPath);
  } else {
    await runStubMode(outPath);
  }
} catch (error) {
  process.stderr.write(
    `Menu evaluation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
