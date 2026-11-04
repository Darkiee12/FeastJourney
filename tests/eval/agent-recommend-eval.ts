/**
 * Offline agentic-vs-single-shot recommendation evaluation (workstream D).
 *
 * What this measures: harness plumbing on a hand-maintained dish fixture —
 * eligible-correctness, relevance under the shared deterministic scorer,
 * variety, unique dishes explored, selection validity, tool rounds, provider
 * calls, estimated tokens, and fallback frequency under injected provider
 * errors. The "provider" is a deterministic stub scorer; this path never
 * calls a network provider and spends no API budget.
 *
 * What this does NOT measure: live model quality or wall-clock provider
 * latency. Reported numbers are computed from the fixture inputs only.
 * p50/p95 provider latency is NOT measurable here and is reported as
 * unevaluated (null), never extrapolated.
 */

export interface FixtureDish {
  readonly id: string;
  readonly name: string;
  readonly cuisines: ReadonlyArray<string>;
  readonly categories: ReadonlyArray<string>;
  readonly region: string;
  readonly ingredients: ReadonlyArray<string>;
  /** Sparse catalog metadata: null description models thin catalog rows. */
  readonly description: string | null;
}

export interface EvalQuery {
  readonly region: string | null;
  readonly mood: string;
  readonly meal: string;
  readonly excludedIngredients: ReadonlyArray<string>;
}

export interface StrategySelection {
  readonly ids: ReadonlyArray<string>;
  readonly reasons: ReadonlyArray<string>;
  readonly uniqueDishesExplored: number;
  readonly rounds: number;
  readonly providerCalls: number;
  readonly estimatedTokens: number;
  readonly fallback: boolean;
}

export interface CaseMetrics {
  readonly query: EvalQuery;
  readonly eligibleCount: number;
  readonly singleShot: StrategySelection & {
    readonly eligibleCorrect: boolean;
    readonly relevance: number;
    readonly variety: number;
    readonly valid: boolean;
  };
  readonly agentic: StrategySelection & {
    readonly eligibleCorrect: boolean;
    readonly relevance: number;
    readonly variety: number;
    readonly valid: boolean;
  };
}

export interface EvalSummary {
  readonly cases: Array<CaseMetrics>;
  readonly singleShot: AggregateMetrics;
  readonly agentic: AggregateMetrics;
}

export interface AggregateMetrics {
  readonly cases: number;
  readonly eligibleCorrectRate: number | null;
  readonly meanRelevance: number | null;
  readonly meanVariety: number | null;
  readonly meanUniqueExplored: number | null;
  readonly validityRate: number | null;
  readonly totalRounds: number;
  readonly totalProviderCalls: number;
  readonly totalEstimatedTokens: number;
  readonly fallbackRate: number | null;
  /** Unevaluated offline: no live provider calls are made. */
  readonly p50LatencyMs: null;
  readonly p95LatencyMs: null;
}

/** Hand-maintained catalog: 24 dishes across 4 regions, mixed metadata depth. */
export const FIXTURE_DISHES: ReadonlyArray<FixtureDish> = [
  {
    id: "d01",
    name: "Pho Bo",
    cuisines: ["vietnamese"],
    categories: ["lunch", "dinner"],
    region: "VN",
    ingredients: ["beef", "rice-noodle", "star-anise"],
    description: "Aromatic beef noodle soup.",
  },
  {
    id: "d02",
    name: "Banh Mi",
    cuisines: ["vietnamese"],
    categories: ["lunch", "snack"],
    region: "VN",
    ingredients: ["pork", "baguette", "pickled-carrot"],
    description: "Crisp baguette sandwich.",
  },
  {
    id: "d03",
    name: "Bun Cha",
    cuisines: ["vietnamese"],
    categories: ["lunch"],
    region: "VN",
    ingredients: ["pork", "rice-noodle"],
    description: null,
  },
  {
    id: "d04",
    name: "Com Tam",
    cuisines: ["vietnamese"],
    categories: ["lunch", "dinner"],
    region: "VN",
    ingredients: ["pork", "rice"],
    description: null,
  },
  {
    id: "d05",
    name: "Goi Cuon",
    cuisines: ["vietnamese"],
    categories: ["snack", "lunch"],
    region: "VN",
    ingredients: ["shrimp", "rice-paper"],
    description: "Fresh rice-paper rolls.",
  },
  {
    id: "d06",
    name: "Cao Lau",
    cuisines: ["vietnamese"],
    categories: ["dinner"],
    region: "VN",
    ingredients: ["pork", "noodle"],
    description: null,
  },
  {
    id: "d07",
    name: "Sushi Moriawase",
    cuisines: ["japanese"],
    categories: ["dinner"],
    region: "JP",
    ingredients: ["rice", "tuna", "salmon"],
    description: "Assorted nigiri and maki.",
  },
  {
    id: "d08",
    name: "Ramen",
    cuisines: ["japanese"],
    categories: ["lunch", "dinner"],
    region: "JP",
    ingredients: ["pork", "noodle", "egg"],
    description: "Rich broth noodle soup.",
  },
  {
    id: "d09",
    name: "Tempura",
    cuisines: ["japanese"],
    categories: ["dinner"],
    region: "JP",
    ingredients: ["shrimp", "wheat"],
    description: null,
  },
  {
    id: "d10",
    name: "Onigiri",
    cuisines: ["japanese"],
    categories: ["snack", "breakfast"],
    region: "JP",
    ingredients: ["rice", "seaweed"],
    description: null,
  },
  {
    id: "d11",
    name: "Udon",
    cuisines: ["japanese"],
    categories: ["lunch"],
    region: "JP",
    ingredients: ["wheat", "egg"],
    description: null,
  },
  {
    id: "d12",
    name: "Miso Soup",
    cuisines: ["japanese"],
    categories: ["breakfast", "lunch"],
    region: "JP",
    ingredients: ["tofu", "seaweed"],
    description: "Fermented soybean broth.",
  },
  {
    id: "d13",
    name: "Tacos al Pastor",
    cuisines: ["mexican"],
    categories: ["lunch", "dinner"],
    region: "MX",
    ingredients: ["pork", "corn", "pineapple"],
    description: "Marinated pork tacos.",
  },
  {
    id: "d14",
    name: "Pozole",
    cuisines: ["mexican"],
    categories: ["dinner"],
    region: "MX",
    ingredients: ["pork", "corn"],
    description: null,
  },
  {
    id: "d15",
    name: "Chilaquiles",
    cuisines: ["mexican"],
    categories: ["breakfast"],
    region: "MX",
    ingredients: ["corn", "egg", "cheese"],
    description: "Fried tortilla in salsa.",
  },
  {
    id: "d16",
    name: "Elote",
    cuisines: ["mexican"],
    categories: ["snack"],
    region: "MX",
    ingredients: ["corn", "cheese"],
    description: null,
  },
  {
    id: "d17",
    name: "Tamales",
    cuisines: ["mexican"],
    categories: ["breakfast", "lunch"],
    region: "MX",
    ingredients: ["corn", "pork"],
    description: null,
  },
  {
    id: "d18",
    name: "Guacamole",
    cuisines: ["mexican"],
    categories: ["snack"],
    region: "MX",
    ingredients: ["avocado"],
    description: "Mashed avocado with lime.",
  },
  {
    id: "d19",
    name: "Margherita Pizza",
    cuisines: ["italian"],
    categories: ["lunch", "dinner"],
    region: "IT",
    ingredients: ["wheat", "cheese", "tomato"],
    description: "Wood-fired classic.",
  },
  {
    id: "d20",
    name: "Risotto",
    cuisines: ["italian"],
    categories: ["dinner"],
    region: "IT",
    ingredients: ["rice", "cheese"],
    description: null,
  },
  {
    id: "d21",
    name: "Bruschetta",
    cuisines: ["italian"],
    categories: ["snack"],
    region: "IT",
    ingredients: ["wheat", "tomato"],
    description: null,
  },
  {
    id: "d22",
    name: "Lasagna",
    cuisines: ["italian"],
    categories: ["dinner"],
    region: "IT",
    ingredients: ["wheat", "beef", "cheese"],
    description: "Layered baked pasta.",
  },
  {
    id: "d23",
    name: "Tiramisu",
    cuisines: ["italian"],
    categories: ["dessert"],
    region: "IT",
    ingredients: ["egg", "cheese", "coffee"],
    description: null,
  },
  {
    id: "d24",
    name: "Minestrone",
    cuisines: ["italian"],
    categories: ["lunch"],
    region: "IT",
    ingredients: ["tomato", "bean"],
    description: "Hearty vegetable soup.",
  },
];

/** Deterministic query matrix: regions × moods × meals × exclusions. */
export const EVAL_QUERIES: ReadonlyArray<EvalQuery> = [
  { region: "VN", mood: "comfort", meal: "dinner", excludedIngredients: [] },
  { region: "VN", mood: "any", meal: "lunch", excludedIngredients: ["pork"] },
  { region: "JP", mood: "adventure", meal: "dinner", excludedIngredients: [] },
  { region: "JP", mood: "comfort", meal: "breakfast", excludedIngredients: ["egg"] },
  { region: "MX", mood: "any", meal: "snack", excludedIngredients: ["cheese"] },
  { region: "MX", mood: "celebration", meal: "dinner", excludedIngredients: ["pork"] },
  { region: "IT", mood: "comfort", meal: "dinner", excludedIngredients: ["beef"] },
  { region: "IT", mood: "any", meal: "dessert", excludedIngredients: [] },
  { region: null, mood: "adventure", meal: "lunch", excludedIngredients: [] },
  { region: null, mood: "any", meal: "anything", excludedIngredients: ["egg", "pork"] },
  { region: "VN", mood: "comfort", meal: "breakfast", excludedIngredients: [] },
  { region: "JP", mood: "any", meal: "snack", excludedIngredients: ["wheat"] },
];

const eligiblePool = (query: EvalQuery): Array<FixtureDish> =>
  FIXTURE_DISHES.filter(
    (dish) =>
      (query.region === null || dish.region === query.region) &&
      (query.meal === "anything" || dish.categories.includes(query.meal)) &&
      !dish.ingredients.some((ingredient) => query.excludedIngredients.includes(ingredient)),
  );

/**
 * Shared deterministic scorer (mirrors the service's cuisine/meal/id order).
 * Both strategies rank with this so the comparison measures EXPLORATION
 * (which dishes each strategy sees), never a hidden scorer difference.
 */
const scoreDish = (dish: FixtureDish, query: EvalQuery, cuisine: string | null): number => {
  let score = 1;

  if (cuisine !== null && dish.cuisines.includes(cuisine)) {
    score += 2;
  }

  if (query.meal !== "anything" && dish.categories.includes(query.meal)) {
    score += 1;
  }

  return score;
};

/** IDs, in order, for stable selection (id ASC keeps the order deterministic). */
const orderStable = (dishes: ReadonlyArray<FixtureDish>): Array<FixtureDish> =>
  dishes.toSorted((a, b) => {
    if (a.id === b.id) {
      return 0;
    }

    return a.id < b.id ? -1 : 1;
  });

const FINAL_LIMIT = 10;
const SINGLE_SHOT_WINDOW = 10;

const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

interface RunOptions {
  readonly cuisine: string | null;
  /** When true the stub provider fails: the agentic run must degrade. */
  readonly providerDown: boolean;
}

/**
 * Old single-shot reranker: scores the deterministic head window only
 * (first 10 of the stable order), then selects up to 10. Explores exactly
 * the window it sees — candidates beyond it can never surface.
 */
const runSingleShot = (
  pool: Array<FixtureDish>,
  query: EvalQuery,
  options: RunOptions,
): StrategySelection => {
  const window = orderStable(pool).slice(0, SINGLE_SHOT_WINDOW);

  const ranked = window.toSorted(
    (a, b) => scoreDish(b, query, options.cuisine) - scoreDish(a, query, options.cuisine),
  );

  const ids = ranked.slice(0, FINAL_LIMIT).map((dish) => dish.id);
  const promptChars = JSON.stringify(window.map((dish) => dish.id)).length;

  return {
    ids,
    reasons: ids.map((id) => `Fits the ${query.meal} occasion (${id}).`),
    uniqueDishesExplored: window.length,
    rounds: 1,
    providerCalls: 1,
    estimatedTokens: estimateTokens(promptChars) + ids.length * 20,
    fallback: false,
  };
};

const AGENT_PAGE_LIMIT = 10;
const AGENT_MAX_ROUNDS = 3;
const AGENT_MAX_CALLS = 8;
const AGENT_POOL_CAP = 60;

/**
 * Simulated agentic exploration over the SAME eligible pool: an initial
 * overview page, then targeted pages (by cuisine, then by category) until
 * the round/call caps or pool exhaustion. Selection runs over everything
 * explored — a candidate past the old first-10 window has a genuine chance.
 * When `providerDown`, the run degrades to the deterministic head order and
 * reports fallback (mirrors the service's degraded disposition).
 */
const runAgentic = (
  pool: Array<FixtureDish>,
  query: EvalQuery,
  options: RunOptions,
): StrategySelection => {
  const stable = orderStable(pool);
  const explored = new Map<string, FixtureDish>();
  let rounds = 0;
  let calls = 0;
  let promptChars = 0;

  const takePage = (candidates: ReadonlyArray<FixtureDish>): void => {
    if (calls >= AGENT_MAX_CALLS || explored.size >= AGENT_POOL_CAP) {
      return;
    }

    calls += 1;
    promptChars += JSON.stringify(candidates.map((dish) => dish.id)).length;

    for (const dish of candidates.slice(0, AGENT_PAGE_LIMIT)) {
      explored.set(dish.id, dish);
    }
  };

  rounds += 1;
  takePage(stable);

  if (options.cuisine !== null && rounds < AGENT_MAX_ROUNDS) {
    rounds += 1;
    const cuisine: string = options.cuisine;
    takePage(stable.filter((dish) => dish.cuisines.includes(cuisine)));
  }

  if (explored.size < Math.min(stable.length, AGENT_POOL_CAP) && rounds < AGENT_MAX_ROUNDS) {
    rounds += 1;
    takePage(stable.filter((dish) => !explored.has(dish.id)));
  }

  const exploredList = [...explored.values()];

  const ranked = exploredList.toSorted(
    (a, b) =>
      scoreDish(b, query, options.cuisine) - scoreDish(a, query, options.cuisine) ||
      (a.id < b.id ? -1 : 1),
  );

  const head = options.providerDown
    ? orderStable(exploredList).slice(0, FINAL_LIMIT)
    : ranked.slice(0, FINAL_LIMIT);

  const ids = head.map((dish) => dish.id);

  return {
    ids,
    reasons: ids.map((id) => `Fits the ${query.meal} occasion (${id}).`),
    uniqueDishesExplored: explored.size,
    rounds,
    providerCalls: options.providerDown ? 0 : calls,
    estimatedTokens: options.providerDown ? 0 : estimateTokens(promptChars) + ids.length * 20,
    fallback: options.providerDown,
  };
};

const cuisineOf = (query: EvalQuery): string | null => {
  const match = FIXTURE_DISHES.find(
    (dish) => query.region !== null && dish.region === query.region,
  );

  return match?.cuisines[0] ?? null;
};

const assess = (
  selection: StrategySelection,
  pool: ReadonlyArray<FixtureDish>,
  query: EvalQuery,
) => {
  const poolIds = new Set(pool.map((dish) => dish.id));
  const byId = new Map(pool.map((dish) => [dish.id, dish] as const));
  const eligibleCorrect = selection.ids.every((id) => poolIds.has(id));

  const relevance =
    selection.ids.length === 0
      ? 1
      : selection.ids.reduce((sum, id) => {
          const dish = byId.get(id);

          // Invented IDs fail eligibility and earn no relevance credit.
          if (dish === undefined) {
            return sum;
          }

          return sum + scoreDish(dish, query, cuisineOf(query));
        }, 0) / selection.ids.length;

  const variety = new Set(selection.ids.flatMap((id) => byId.get(id)?.cuisines ?? [])).size;

  const valid =
    selection.ids.length <= FINAL_LIMIT &&
    new Set(selection.ids).size === selection.ids.length &&
    selection.reasons.length === selection.ids.length &&
    eligibleCorrect;

  return { eligibleCorrect, relevance, variety, valid };
};

const rate = (values: ReadonlyArray<boolean>): number | null =>
  values.length === 0 ? null : values.filter(Boolean).length / values.length;

const mean = (values: ReadonlyArray<number>): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

const aggregate = (
  cases: ReadonlyArray<CaseMetrics>,
  pick: (metrics: CaseMetrics) => CaseMetrics["singleShot"],
): AggregateMetrics => {
  const rows = cases.map(pick);

  return {
    cases: rows.length,
    eligibleCorrectRate: rate(rows.map((row) => row.eligibleCorrect)),
    meanRelevance: mean(rows.map((row) => row.relevance)),
    meanVariety: mean(rows.map((row) => row.variety)),
    meanUniqueExplored: mean(rows.map((row) => row.uniqueDishesExplored)),
    validityRate: rate(rows.map((row) => row.valid)),
    totalRounds: rows.reduce((sum, row) => sum + row.rounds, 0),
    totalProviderCalls: rows.reduce((sum, row) => sum + row.providerCalls, 0),
    totalEstimatedTokens: rows.reduce((sum, row) => sum + row.estimatedTokens, 0),
    fallbackRate: rate(rows.map((row) => row.fallback)),
    p50LatencyMs: null,
    p95LatencyMs: null,
  };
};

/**
 * Run the full matrix. `providerDownQueries` counts how many queries run
 * with a failing stub provider (deterministic: the FIRST N queries), which
 * drives the agentic fallback-rate measurement.
 */
export const runAgentEval = (providerDownQueries = 2): EvalSummary => {
  const cases: Array<CaseMetrics> = EVAL_QUERIES.map((query, index) => {
    const pool = eligiblePool(query);
    const cuisine = cuisineOf(query);
    const down = index < providerDownQueries;
    const singleShot = runSingleShot(pool, query, { cuisine, providerDown: false });
    const agentic = runAgentic(pool, query, { cuisine, providerDown: down });

    return {
      query,
      eligibleCount: pool.length,
      singleShot: { ...singleShot, ...assess(singleShot, pool, query) },
      agentic: { ...agentic, ...assess(agentic, pool, query) },
    };
  });

  return {
    cases,
    singleShot: aggregate(cases, (metrics) => metrics.singleShot),
    agentic: aggregate(cases, (metrics) => metrics.agentic),
  };
};

const row = (label: string, metrics: AggregateMetrics): string =>
  `| ${label} | ${metrics.eligibleCorrectRate} | ${metrics.meanRelevance?.toFixed(2)} | ${metrics.meanVariety?.toFixed(2)} | ${metrics.meanUniqueExplored?.toFixed(1)} | ${metrics.validityRate} | ${metrics.totalRounds} | ${metrics.totalProviderCalls} | ${metrics.totalEstimatedTokens} | ${metrics.fallbackRate} |`;

/** Markdown evidence table for the final report (computed, never hand-written). */
export const evalTable = (summary: EvalSummary): string => {
  return [
    "| strategy | eligible-correct | relevance | variety | unique-explored | validity | rounds | calls | est-tokens | fallback |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    row("single-shot", summary.singleShot),
    row("agentic", summary.agentic),
  ].join("\n");
};
