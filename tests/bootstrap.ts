/**
 * Deterministic test bootstrap, preloaded before any test module evaluates
 * (see `bunfig.toml` `[test] preload`). Test files must never depend on
 * import order for environment setup: static imports of application modules
 * (e.g. Better Auth) validate the server environment at module-evaluation
 * time, so the environment has to exist before the first test import runs.
 *
 * Scope: `bun test` only. Production (`bun run build`, `bun run start`,
 * `bun run dev`) never loads this file — the `[test]` preload section is
 * read exclusively by the test runner.
 *
 * Responsibilities (kept separate by design):
 * - this file: test-only environment defaults + disposable-database guard.
 * - `tests/integration/cleanup.ts`: per-suite fixture tracking.
 */

const TEST_ENV_DEFAULTS = {
  DATABASE_URL: "postgres://feastjourney:fj-local-dev-pw@127.0.0.1:5433/feastjourney",
  RATE_LIMIT_PUBLIC: "1000",
  RATE_LIMIT_SEARCH: "1000",
  RATE_LIMIT_ADMIN: "1000",
  BETTER_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "test-secret-with-at-least-32-characters",
  GOOGLE_CLIENT_ID: "test-google-id",
  GOOGLE_CLIENT_SECRET: "test-google-secret",
  FACEBOOK_CLIENT_ID: "test-facebook-id",
  FACEBOOK_CLIENT_SECRET: "test-facebook-secret",
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  SMTP_USERNAME: "test",
  SMTP_PASSWORD: "test",
  EMAIL_FROM: "test@example.com",
  RECOMMEND_AGENT_MAX_ROUNDS: "3",
  RECOMMEND_AGENT_MAX_TOOL_CALLS: "8",
  RECOMMEND_AGENT_DETAILS_PER_CALL: "10",
  RECOMMEND_AGENT_CANDIDATE_POOL_CAP: "60",
  RECOMMEND_AGENT_FINAL_LIMIT: "10",
  MODEL_AGENT_TIMEOUT_MS: "20000",
  RECOMMEND_AGENT_DEADLINE_MS: "90000",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Fill only missing or empty entries. Explicitly supplied values (CI
 * secrets, developer overrides) always take precedence and are never
 * overwritten. Pure over the given record for unit-testability.
 */
export const applyTestEnvDefaults = (env: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(TEST_ENV_DEFAULTS)) {
    if (!env[key]) {
      env[key] = value;
    }
  }
};

/**
 * Refuse anything that is not the disposable loopback `feastjourney` test
 * database. Destructive integration tests must never run against production
 * or shared databases.
 */
export const isDisposableTestDatabase = (url: string | undefined): boolean => {
  if (url === undefined || url.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");

    return (
      (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") &&
      parsed.pathname.replace(/^\//, "").split("/")[0] === "feastjourney"
    );
  } catch {
    return false;
  }
};

const databaseUrl = process.env["DATABASE_URL"];

if (!isDisposableTestDatabase(databaseUrl)) {
  throw new Error(
    "Refusing to run tests: DATABASE_URL does not point at the disposable loopback feastjourney test database",
  );
}

applyTestEnvDefaults(process.env);
