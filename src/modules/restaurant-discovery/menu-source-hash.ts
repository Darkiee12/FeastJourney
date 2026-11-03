/**
 * Client-safe SHA-256 (hex) for menu-localization source fingerprints.
 *
 * One implementation shared by the server generation path and the panel
 * overlay/query key: the stored `source_hash` and the client-computed match
 * key must agree byte-for-byte, so neither side may use a second hash.
 * Pure TypeScript over TextEncoder (UTF-8) — no node:crypto, safe to bundle
 * for the browser. Parity with Node's SHA-256 is pinned by
 * tests/unit/menu-localizations.test.ts (known vectors + fixture strings,
 * including non-ASCII menu text).
 */

import type { MenuOffering } from "@/modules/restaurant-discovery/server/operations/discovery";

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rightRotate = (value: number, bits: number): number =>
  (value >>> bits) | (value << (32 - bits));

/** SHA-256 hex digest of one UTF-8 string. */
export const sha256Hex = (input: string): string => {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);

  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);

  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296), false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const schedule = Array.from({ length: 64 }, () => 0);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }

    for (let index = 16; index < 64; index += 1) {
      const a = schedule[index - 15] ?? 0;
      const b = schedule[index - 2] ?? 0;
      const s0 = rightRotate(a, 7) ^ rightRotate(a, 18) ^ (a >>> 3);
      const s1 = rightRotate(b, 17) ^ rightRotate(b, 19) ^ (b >>> 10);
      const c = schedule[index - 7] ?? 0;
      const d = schedule[index - 16] ?? 0;

      schedule[index] = (s1 + c + s0 + d) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const w = schedule[index] ?? 0;
      const k = K[index] ?? 0;
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + k + w) | 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
};

export interface LocalizationFingerprintInput {
  readonly kind: "item" | "variant";
  readonly sourceLanguage: string | null;
  readonly target: string;
  readonly name: string;
  readonly description: string | null;
}

/**
 * Canonical source fingerprint for one localizable unit. The canonical
 * tuple (kind, source language, target, name, description) is hashed, so
 * the server generation path and the panel overlay/query key agree without
 * a second implementation. Unchanged text reuses the stored row with zero
 * provider calls; any source edit retires the row from reads.
 */
export const localizationSourceFingerprint = (input: LocalizationFingerprintInput): string =>
  sha256Hex(
    JSON.stringify([
      input.kind,
      input.sourceLanguage ?? "",
      input.target,
      input.name,
      input.description ?? "",
    ]),
  );

export type SourceRevisionOffering = Pick<
  MenuOffering,
  "item_id" | "item_name" | "description" | "variant_id" | "variant_name" | "source_language"
>;

/**
 * Source-revision fingerprint over the current published source texts.
 * Same canonicalization as the generation path (blank descriptions count
 * as absent), so equal fingerprints mean equal generation inputs. The panel
 * computes this from the offerings it already holds — no discovery refetch,
 * no extra request — and scopes its localization query key by it.
 */
export const menuSourceRevisionFingerprint = (
  offerings: ReadonlyArray<SourceRevisionOffering>,
  target: string,
): string => {
  const seenItems = new Set<string>();
  const hashes: Array<string> = [];

  for (const offering of offerings) {
    if (!seenItems.has(offering.item_id)) {
      seenItems.add(offering.item_id);

      const description =
        offering.description === null || offering.description.trim() === ""
          ? null
          : offering.description;

      hashes.push(
        localizationSourceFingerprint({
          kind: "item",
          sourceLanguage: offering.source_language,
          target,
          name: offering.item_name,
          description,
        }),
      );
    }

    hashes.push(
      localizationSourceFingerprint({
        kind: "variant",
        sourceLanguage: offering.source_language,
        target,
        name: offering.variant_name,
        description: null,
      }),
    );
  }

  return sha256Hex(hashes.toSorted().join("|"));
};
