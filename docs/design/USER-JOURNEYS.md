# Mobile user journeys — quiz drawer and globe (Implemented)

Canonical page for the mobile (`max-md`) quiz bottom-sheet behavior and its
synchronized hero globe push. Link here instead of duplicating the contract.

## Journey: open the quiz over the globe

1. Visitor on a phone taps the hero "Find dishes" CTA. The hero dispatches
   `QUIZ_DRAWER_OPEN_EVENT`; the quiz flow flips the drawer's open flag.
   Draft, answers, rail index, and journey snapshot are untouched.
2. The sheet slides up from the viewport bottom on the shared drawer-spring
   timing (`--drawer-spring-duration: 450ms`,
   `--drawer-spring-easing: cubic-bezier(0.32, 0.72, 0, 1)` in
   `src/styles.css` — the single timing source of truth).
3. Simultaneously the hero carries `data-quiz-open="true"` (owned by the
   quiz flow / hero; stylesheet only hooks onto it) and the whole
   `.hero-globe[data-globe-lift]` subtree — WebGL canvas, overlays, pins,
   static fallback — lifts `translate3d(0, -12dvh, 0)` on the same
   duration/easing. Rotation continues uninterrupted: no Canvas remount, no
   texture/camera/data re-init, no per-frame React state.
4. Hero copy and CTAs never move: only the globe layer transforms, so no
   headline/CTA overlap at 320/375/390/430 widths or with long localized
   copy. Desktop never lifts (strict `max-width: 767.98px` gate, matching
   `useIsMaxMd` / `md:hidden`).

## Sheet shell contract (`quiz-drawer.tsx`)

- Fixed responsive height, stable across steps (never content-sized, never
  per-step jumps): `h-[clamp(18rem,50dvh,34rem)]` capped by
  `max-h-[calc(100dvh-3.5rem)]`. Secondary content scrolls internally
  (`data-drawer-body`, `overscroll-contain`); the primary action stays
  sticky in the footer.
- Close (button or Escape) plays the slide-down exit, then unmounts after
  exactly one spring duration (resolved live from the CSS token, 450ms
  fallback). Reopening mid-close cancels the exit and replays enter.
- Body scroll stays locked through the exit animation; cleanup restores
  `body.overflow`, the exact scroll position, and focus — including on
  route-change unmount, which also clears the pending close timer.
- Reduced motion: sheet and globe snap to final positions instantly — no
  enter/exit animation, no unmount delay, no globe transition.
- No dim backdrop (would hide the globe), no extra floating buttons/labels,
  no document shifting. Navy/cream/orange/mango palette and existing radii
  unchanged.

## Cross-workstream contract (quiz flow / hero own these)

- Hero root gets `data-quiz-open="true"` while the drawer is open, absent
  otherwise (status at time of writing: pending — owned by the card/UI
  workstream; the CSS above hooks onto it and works the moment it lands).
- `QUIZ_DRAWER_CLOSE_EVENT` dispatched by the quiz flow on close (same
  ownership/status); enter/exit timing already matches it via the shared
  tokens.

## Manual verification (no browser tool in this environment)

1. 390px width: open mid-animation screenshot — sheet sliding up while the
   globe lifts; computed `transform` on `[data-globe-lift]` ends at
   `translate3d(0, -12dvh, 0)` equivalent matrix.
2. Close mid-animation screenshot — sheet sliding down, globe settling back
   to `none`; after 450ms the sheet unmounts and `data-quiz-open` is gone.
3. React DevTools: Canvas element identity stable across open/close (no
   remount, globe keeps spinning).
4. Emulate reduced motion: open/close apply instantly, no delay.
5. Rapid toggle, resize-while-open, route-change mid-close: no stuck
   transform, no scroll lock (`body.overflow` restored).
6. 320/375/390/430 widths with longest localized copy: no headline/CTA
   overlap; sheet height within 48–52dvh on typical phones.
