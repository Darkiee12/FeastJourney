# Synthetic menu extraction evaluation set

These original SVG fixtures and `cases.json` cover the 15 requested multilingual,
layout, missing-price, ambiguous-currency, illegibility and adversarial cases.
Render SVGs to PNG/JPEG before sending them to the image adapter; SVG uploads
are intentionally forbidden. No customer photographs or external artwork are used.

Each case lists expected names/amounts and uncertainty behavior. Check original
text recall, item/variant-price association, currency interpretation, source-page
membership and absence of invented ingredient/safety claims. A confidently wrong
price association is a failed case even if JSON validation passes.

`malformed-responses.json` supplies provider-output rejection examples.
`browser-page-*` are used by the local contract provider/browser journey.
The fixture provider returns known data and cannot establish OCR or translation
accuracy. Every `liveEvaluation` is `not_run`; no live Muse benchmark or empirical
one-call/two-call comparison has been performed.
