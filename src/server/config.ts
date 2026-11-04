import { Config, Option } from "effect";

export interface AppConfig {
  readonly databaseUrl: string;
  readonly databaseDirectUrl: string | undefined;
  readonly poolMax: number;
  readonly corsOrigins: ReadonlyArray<string>;
  readonly trustedProxies: ReadonlyArray<string>;
  readonly publicRateLimit: number;
  readonly publicRateWindowSeconds: number;
  readonly searchRateLimit: number;
  readonly searchRateWindowSeconds: number;
  // Optional so existing AppConfig literals (incl. tests, which lanes must
  // not modify) keep compiling; Config.withDefault below is the real source
  // of these values and always supplies them at runtime.
  readonly copilotRateLimit?: number | undefined;
  readonly copilotRateWindowSeconds?: number | undefined;
  readonly adminRateLimit: number;
  readonly adminRateWindowSeconds: number;
  readonly requestTimeoutMs: number;
  // Optional so existing AppConfig literals (incl. tests) keep compiling;
  // Config.withDefault below is the real source of this value.
  readonly recommendTimeoutMs?: number | undefined;
}

const csv = (raw: string): ReadonlyArray<string> =>
  raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

export const appConfig: Config.Config<AppConfig> = Config.unwrap({
  databaseUrl: Config.String("DATABASE_URL"),
  databaseDirectUrl: Config.option(Config.String("DATABASE_DIRECT_URL")).pipe(
    Config.map(Option.getOrUndefined),
  ),
  poolMax: Config.Int("DATABASE_POOL_MAX").pipe(Config.withDefault(10)),
  corsOrigins: Config.String("CORS_ORIGINS").pipe(Config.map(csv), Config.withDefault([])),
  trustedProxies: Config.String("TRUSTED_PROXIES").pipe(Config.map(csv), Config.withDefault([])),
  publicRateLimit: Config.Int("RATE_LIMIT_PUBLIC").pipe(Config.withDefault(60)),
  publicRateWindowSeconds: Config.Int("RATE_LIMIT_PUBLIC_WINDOW_S").pipe(Config.withDefault(60)),
  searchRateLimit: Config.Int("RATE_LIMIT_SEARCH").pipe(Config.withDefault(20)),
  searchRateWindowSeconds: Config.Int("RATE_LIMIT_SEARCH_WINDOW_S").pipe(Config.withDefault(60)),
  copilotRateLimit: Config.Int("RATE_LIMIT_COPILOT").pipe(Config.withDefault(10)),
  copilotRateWindowSeconds: Config.Int("RATE_LIMIT_COPILOT_WINDOW_S").pipe(Config.withDefault(60)),
  adminRateLimit: Config.Int("RATE_LIMIT_ADMIN").pipe(Config.withDefault(10)),
  adminRateWindowSeconds: Config.Int("RATE_LIMIT_ADMIN_WINDOW_S").pipe(Config.withDefault(60)),
  requestTimeoutMs: Config.Int("REQUEST_TIMEOUT_MS").pipe(Config.withDefault(15000)),
  // Operation budget for the whole recommend call (SQL + reasoning-model
  // ranking, which alone can take 15s+). Must stay above MODEL_TIMEOUT_MS
  // or the provider call can never complete. Default 120s per operator
  // choice; local dev only — tighten for production.
  recommendTimeoutMs: Config.Int("RECOMMEND_TIMEOUT_MS").pipe(Config.withDefault(120000)),
});
