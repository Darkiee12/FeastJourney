import { z } from "zod";

import { menuExtractionSchema } from "@/modules/restaurant-discovery/menu-scan.schema";

/** Test-only HTTP provider. It validates requests; it does not perform OCR or measure Muse quality. */
const imageBlock = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string().startsWith("data:image/jpeg;base64,") }),
});

const textBlock = z.object({ type: z.literal("text"), text: z.string() });

const requestSchema = z.object({
  model: z.literal("muse-spark-1.3"),
  store: z.literal(false),
  stream: z.literal(false),
  n: z.literal(1),
  max_completion_tokens: z.number().int().positive(),
  response_format: z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: z.literal("menu_scan_v1"),
      strict: z.literal(true),
      schema: z.object({ type: z.literal("object"), additionalProperties: z.literal(false) }),
    }),
  }),
  messages: z
    .array(
      z.object({
        role: z.enum(["developer", "user"]),
        content: z.union([z.string(), z.array(z.union([textBlock, imageBlock]))]),
      }),
    )
    .length(2),
});

const cert = process.env.MENU_FIXTURE_CERT ?? "/tmp/fj-pr4-browser-cert.pem";
const key = process.env.MENU_FIXTURE_KEY ?? "/tmp/fj-pr4-browser-key.pem";
const apiKey = process.env.MENU_FIXTURE_API_KEY ?? "synthetic-browser-menu-key";
let requests = 0;
let validatedRequests = 0;
let images = 0;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 54444,
  maxRequestBodySize: 35 * 1024 * 1024,
  tls: { cert: Bun.file(cert), key: Bun.file(key) },
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health")
      return Response.json({ mode: "synthetic-provider-contract-fixture" });

    if (url.pathname === "/metrics") return Response.json({ requests, validatedRequests, images });

    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST")
      return new Response(null, { status: 404 });
    requests += 1;

    if (request.headers.get("authorization") !== `Bearer ${apiKey}`)
      return new Response(null, { status: 401 });

    try {
      const input = requestSchema.parse(await request.json());
      const message = input.messages.find((entry) => entry.role === "user");

      if (message === undefined || !Array.isArray(message.content))
        return new Response(null, { status: 400 });
      const text = message.content.find((entry) => entry.type === "text");

      const assetIds =
        text?.text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];

      const photoBlocks = message.content.filter((entry) => entry.type === "image_url");

      if (assetIds.length !== photoBlocks.length || assetIds.length === 0 || assetIds.length > 6)
        return new Response(null, { status: 400 });

      for (const photo of photoBlocks) {
        const bytes = Buffer.from(
          photo.image_url.url.slice("data:image/jpeg;base64,".length),
          "base64",
        );

        if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255)
          return new Response(null, { status: 400 });
      }

      const first = assetIds[0];

      if (first === undefined) return new Response(null, { status: 400 });
      const second = assetIds[1] ?? first;

      const output = menuExtractionSchema.parse({
        sourceLanguage: "vi",
        menuTitle: "Synthetic travel menu",
        orderIntroduction: {
          original: "Cho chúng tôi gọi các món sau, vui lòng.",
          translated: "We would like these dishes, please.",
        },
        items: [
          {
            originalName: "Phở bò",
            translatedName: "Beef noodle soup",
            originalDescription: "Nước dùng bò",
            translatedDescription: "Beef broth",
            explanatorySummary: "A noodle soup. Confirm ingredients with the waiter.",
            ingredients: [{ originalText: "Bò", translatedText: "Beef", evidence: "printed" }],
            variants: [
              {
                originalLabel: "Tô thường",
                translatedLabel: "Regular bowl",
                price: {
                  rawText: "65.000đ",
                  amount: "65000",
                  currency: "VND",
                  taxTreatment: "unknown",
                },
              },
              {
                originalLabel: "Tô lớn",
                translatedLabel: "Large bowl",
                price: {
                  rawText: "80.000đ",
                  amount: "80000",
                  currency: "VND",
                  taxTreatment: "unknown",
                },
              },
            ],
            sourceReferences: [{ assetId: first, region: null }],
            uncertainties: ["Tax treatment is not printed"],
          },
          {
            originalName: "Gỏi cuốn",
            translatedName: "Fresh spring rolls",
            originalDescription: null,
            translatedDescription: null,
            explanatorySummary: null,
            ingredients: null,
            variants: [{ originalLabel: "", translatedLabel: null, price: null }],
            sourceReferences: [{ assetId: second, region: null }],
            uncertainties: ["Price not readable"],
          },
        ],
      });

      validatedRequests += 1;
      images += photoBlocks.length;

      return Response.json({
        id: "synthetic-menu-fixture",
        object: "chat.completion",
        model: input.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", refusal: null, content: JSON.stringify(output) },
          },
        ],
      });
    } catch {
      return Response.json(
        { error: "Synthetic fixture rejected the provider request contract" },
        { status: 400 },
      );
    }
  },
});

process.stdout.write(
  `Synthetic menu provider fixture listening on https://localhost:${server.port}\n`,
);
