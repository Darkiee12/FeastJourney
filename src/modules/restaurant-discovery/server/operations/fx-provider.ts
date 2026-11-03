import { Context, Data, Effect } from "effect";
import { z } from "zod";

import { isCurrency } from "@/shared/money";
import type { ExchangeRate } from "@/shared/money";

export class FxUnavailable extends Data.TaggedError("FxUnavailable")<{
  readonly reason: string;
}> {}

export function acceptableRate(rate: ExchangeRate, now: number, maxAgeMs: number): boolean {
  const effective = Date.parse(`${rate.effectiveDate}T00:00:00Z`);

  return effective <= now && now <= effective + 86400000 + maxAgeMs;
}

/** Frankfurter's four-column CSV preserves the exact decimal token the provider sent. */
export function parsePairCsv(
  body: string,
  base: string,
  quote: string,
  provider: string,
): ExchangeRate {
  const rows = body.trim().split(/\r?\n/);

  if (rows.length !== 2 || rows[0] !== "date,base,quote,rate") throw new Error("Invalid rate CSV");
  const fields = rows[1]?.split(",");

  if (fields === undefined || fields.length !== 4) throw new Error("Invalid rate row");
  const [date, actualBase, actualQuote, rate] = fields;

  if (
    date === undefined ||
    rate === undefined ||
    actualBase !== base ||
    actualQuote !== quote ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(rate) ||
    rate.length > 100 ||
    !/[1-9]/.test(rate)
  ) {
    throw new Error("Invalid rate pair, date or decimal");
  }

  return { base, quote, rate, effectiveDate: date, provider };
}

export class FxProvider extends Context.Service<
  FxProvider,
  {
    readonly id: string;
    readonly pair: (base: string, quote: string) => Effect.Effect<ExchangeRate, FxUnavailable>;
    readonly currencies: Effect.Effect<ReadonlyArray<string>, FxUnavailable>;
  }
>()("feastjourney/restaurant/FxProvider") {}

const providerCurrencies = z
  .array(
    z.object({
      iso_code: z.string(),
      iso_numeric: z
        .string()
        .regex(/^\d{3}$/)
        .nullable(),
    }),
  )
  .max(500);

const MAX_PROVIDER_RESPONSE_BYTES = 150000;

async function readProviderBody(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");

  if (declared !== null && Number(declared) > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Provider response too large");
  }

  if (response.body === null) throw new Error("Provider response is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let body = "";
  let done = false;

  try {
    while (!done) {
      // oxlint-disable-next-line no-await-in-loop -- Consume the stream sequentially to enforce a byte bound before allocating the next chunk.
      const next = await reader.read();

      done = next.done;

      if (next.done) break;
      length += next.value.byteLength;

      if (length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("Provider response too large");
      body += decoder.decode(next.value, { stream: true });
    }

    return body + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export function frankfurterProvider(
  endpoint: string,
  fetcher: (input: URL, init: RequestInit) => Promise<Response> = fetch,
) {
  const url = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);

  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new Error("FX endpoint must use HTTPS (loopback HTTP is allowed for development)");
  }

  const id = `frankfurter-v2:${url.host}${url.pathname}`;

  const request = (path: string) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetcher(new URL(path, url), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          redirect: "error",
        });

        if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);

        return readProviderBody(response);
      },
      catch: () => new FxUnavailable({ reason: "Reference-rate provider is unavailable" }),
    });

  return FxProvider.of({
    id,
    pair: (base, quote) =>
      request(`rates.csv?base=${base}&quotes=${quote}`).pipe(
        Effect.flatMap((body) =>
          Effect.try({
            try: () => parsePairCsv(body, base, quote, id),
            catch: () => new FxUnavailable({ reason: "Invalid reference-rate response" }),
          }),
        ),
      ),
    currencies: request("currencies").pipe(
      Effect.flatMap((body) =>
        Effect.try({
          try: () =>
            providerCurrencies
              .parse(JSON.parse(body))
              .filter((entry) => entry.iso_numeric !== null && isCurrency(entry.iso_code))
              .map((entry) => entry.iso_code),
          catch: () => new FxUnavailable({ reason: "Invalid supported-currency response" }),
        }),
      ),
    ),
  });
}
