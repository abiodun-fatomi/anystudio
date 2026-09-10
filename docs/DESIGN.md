# Design language

How AnyStudio looks, moves and speaks — the rules the primitives in
`apps/web/components/ui` enforce and every screen inherits. Tokens live in
`apps/web/styles/tokens.css`; if a value is not there, it does not exist.

## Type

Bricolage Grotesque for display (titles, big numbers), Hanken Grotesk for
everything you read, JetBrains Mono for meta labels — cost codes, timestamps,
tiny uppercase captions. Sizes come from `--t-1` … `--t-9`; body is 16px at
line-height 1.6, display is tight (1.1) with -0.03em tracking. Never a size
outside the scale.

## Space, radius, elevation

4px grid: `--s-1` (4) … `--s-9` (96). Radius: 4 for controls, 8 for buttons
and inputs, 12 for cards and dialogs, 16 for sheets, pill for badges. Three
elevations: `--elev-1` for a raised card, `--elev-2` for a popover,
`--elev-3` for a dialog. Nothing floats without a reason.

## Colour

One accent (magenta) for the action that matters on a screen and for the
selected state; teal for secondary emphasis; ok/warn/danger for meaning.
Colour is never the only carrier of meaning — a failed row has a badge that
says "Failed", not just a red number. Every token has a light and a dark
value and the three theme states (system, light, dark) are handled in
tokens.css alone.

## Motion

Content enters with opacity and a 4px rise over `--dur` (200ms). Never a
slide from off-screen; never a bounce. Popovers 120ms, dialogs 200ms, sheets
400ms. `prefers-reduced-motion` zeroes every duration and animation
globally — nothing needs to opt in.

## Feedback

Every action acknowledges itself within 100ms: a button goes to its loading
state (keeping its width), a toggle moves, a number moves.

A generation is narrated, never spun. The worker reports real stages —
preparing, routing, generating, composing, storing — and the studio shows
the one it is in, with the detail the provider gave ("Veo is rendering,
38s"). Results appear one at a time as they land. A spinner is allowed only
inside a button, for a request that takes under two seconds.

An error says what happened, what it cost (nothing — credits are back), and
what to do next. It never shows a vendor's words, a status code or a stack.
Errors do not auto-dismiss.

Cost is shown before commitment. Every generate button carries its credit
price and the balance after; the balance in the bar moves the instant a
request is made and reconciles against the ledger right after.

## Copy

Plain, warm, direct. Sentence case everywhere. No "amazing", no "oops", no
exclamation marks in sequence. Buttons are verbs ("Make the reel", not
"Submit"). Empty states say what will be here and how to get it there.
Confirmations name the consequence ("Everything in it is removed after 30
days"), and the destructive action is never the default.

## Accessibility

Every control is reachable and operable by keyboard with a visible focus
ring (2.5px accent, 3px offset). Touch targets are 48px. Tabs, menus and
segmented controls use roving tabindex and arrow keys. Dialogs are the
native element: focus-trapped, Escape closes, focus returns to the opener.
Live regions announce generation stages and toasts. Contrast meets WCAG 2.1
AA in both themes.

## Mobile

Designed at 360px first. The rail becomes bottom tabs under 768px; dialogs
become bottom sheets under 640px; the primary action stays in thumb reach.
Nothing scrolls horizontally except a table inside its own container.
