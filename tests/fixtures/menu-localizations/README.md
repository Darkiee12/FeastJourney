# Menu localization fixtures (Agent J)

All fixtures here are **hand-written synthetic drafts** (`"origin":
"synthetic-draft"`, `"humanReviewed": false`). They were authored alongside
the implementation, not produced by any model, and must never be reported
as model verification.

What they cover: vi-en, ms (Latin script), zh, hi (Devanagari), ja, and one
mixed-source menu, plus adversarial sensitivity probes (invented allergy
assurances, overlong/empty display names, printed-claim grounding).

What they do NOT measure: live model translation quality. The scorer
(`tests/eval/menu-localization-eval.ts`) runs stub outputs through the real
harness validators (bounds, safety guard, hash-match resolution,
approved-wins precedence) — plumbing and validation only.

Before these fixtures back any launch claim, a reviewer must read every
expected string for the languages they know and flip `humanReviewed` to
`true` per case. Until then the honest status is draft.
