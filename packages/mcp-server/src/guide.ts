/**
 * Tratto drawing design system — the guidance the AI needs to draw *well* on a
 * Yahoo Finance chart, which the tool schemas alone don't carry. Delivered
 * through the MCP `get_drawing_guide` tool so it travels with the tools (works
 * for Claude Code, Codex, any MCP agent — zero install).
 *
 * Plain text on purpose: consumed by an LLM as guidance, so no backticks/fences
 * (which would break these template literals under tsc). Single source of truth.
 */

export const GUIDE_CORE = `Tratto — Pro Desk Annotation System

The Tratto MCP tools tell you WHAT params each drawing takes. This guide tells you
HOW a pro desk analyst uses them, so a chart with several overlays stays clean and
instantly readable to BOTH a seasoned trader and a novice. Design discipline beats
capability: fewer, well-chosen, well-styled marks always win.

WORKFLOW (every session)
1. Reach the chart: open_chart(symbol) first (handles the connect-on-refresh quirk).
2. See the state: get_chart_summary (range, last close, high/low) + read_drawings
   (what is already there — never draw a near-duplicate of an existing line).
3. Plan, then budget: decide the ONE idea the chart should convey. List the marks it
   needs, drop everything below the element budget. If the ask exceeds budget, draw
   the top-N by importance and TELL the user what you omitted — do not draw everything.
4. Draw in z-order (see Composition). Set colors EXPLICITLY on every mark — never rely
   on Yahoo "auto".
5. Verify: read_drawings to confirm. If replacing a view, clear_drawings(scope:"mine")
   first so you do not stack onto stale lines.

SEMANTIC PALETTE (the whole palette — use nothing else)
Chosen to read on BOTH light and dark chart themes. Color is a CLAIM, not decoration.

| Hex | Meaning | Used on |
|---|---|---|
| #089981 green | support / demand / bullish structure | horizontals below price, demand zones, up-trend lines |
| #F23645 red | resistance / supply / bearish structure | horizontals above price, supply zones, down-trend lines |
| #2962FF blue | neutral directional structure | trendlines/channels/rays with no bull/bear claim |
| #9B51E0 purple | derived/computed levels | Fibonacci (its only color), pitchfork/VWAP via draw_raw |
| #787B86 gray | time & commentary, zero opinion | vertical event markers, free-standing label text |
| #FF9800 amber | the single "look here" flag | breakout/invalidation/gap — MAX ONE per chart |

- 4 distinct hues max per chart (gray does not count).
- Green/red mean position vs price (support/resistance). A trendline is BLUE unless its
  break direction is the actual thesis.
- Label text inherits its parent element's hue; standalone commentary is gray.

FILLS (fill_color on zones/channels): same hue as the border + low alpha. Use 8-digit
hex for translucency — demand #0899811A (~10%), supply #F236451A, channel #2962FF14
(~8%, channels cover more area). Never exceed ~15% (26). Never fill a hue different from
the border. (If a fill renders opaque, the engine ignored the alpha — pass a pale solid tint.)

WEIGHT & PATTERN HIERARCHY (conviction)
| Tier | width | pattern | meaning |
|---|---|---|---|
| Major | 2px | solid | confirmed, 3+ touches, decision level |
| Standard | 1px | solid | valid, 2 touches, secondary |
| Speculative | 1px | dashed* | unconfirmed, 1 touch, hypothesis |
| Projected | 1px | dotted* | extends into the future, targets, ray extension |
| Verticals | 1px | dotted | events never compete with price |

* pattern is native only on draw_vertical. For dashed/dotted on any other line, use
draw_raw with ptrn:"dashed"|"dotted" (same recipe as the line tool, plus the pattern field).
- 2 elements at 2px max per chart. If everything is heavy, nothing reads as important.
- Never 3px+ except a single deliberate hero element (rare — usually the amber invalidation).

PRIMITIVE SELECTION (line vs zone vs text)
- Line vs zone: touches spread over > ~0.4% of price (or wicks pierce the level) ->
  draw_rectangle ZONE spanning the wick extremes. Tight, exact level (round number,
  prior close, measured target) -> single draw_support / horizontal line. A line implies
  precision a fuzzy level does not have; a zone absorbs wick noise.
- Segment vs ray: draw_trendline (segment) by default — it ends where the evidence ends.
  draw_ray only to PROJECT a level forward, styled dotted (a forecast).
- Channel: prefer one draw_channel over two trendlines. Max one channel per chart.
- Fibonacci: only on the SINGLE dominant swing in view. Never stack fibs. The fib supplies
  its own level lines — do not add horizontals around it (note confluence in a label).
- Indicators: call list_indicators for exact keys, then add_indicator. Never hand-fake
  an indicator with lines.

TEXT DISCIPLINE
A label earns its place ONLY if it says something the geometry cannot: a level's price
("186.50 support"), an event ("Q2 earnings"), a pattern ("H&S neckline"), an invalidation
("invalid < 172"). NOT "resistance" on a red line above price (redundant).
- draw_callout(boxed:false) = borderless annotation — the default. Use boxed:true only
  when the label sits over dense candles.
- 4 words / ~24 chars max. Numbers beat words. 3 text labels max per chart.
- Anchor at the LEFT of the visible range — keep the last ~20% of bars text-free (that is
  where live price is). Never place text within ~3 bars of the current candle.

COMPOSITION (the core) — element budget & z-order
| element | cap |
|---|---|
| total drawn elements | 8 (6 is the sweet spot) |
| filled areas (zones + channels + fib) | 3, only 1 "large" |
| horizontals | 3 |
| text | 3 |
| verticals | 2 |
| amber | 1 |
| fibs | 1 |
| distinct hues (excl. gray) | 4 |
| elements at 2px | 2 |

Draw in this order (ChartIQ paints in creation order; later = on top):
rectangles/channels -> fibonacci -> trendlines/rays -> horizontals -> verticals -> text.

Collision rules:
- Two horizontals within 0.4% of each other -> merge into ONE zone. Never near-duplicates.
- A fib level coinciding with an S/R line (+/-0.3%) -> drop the line, keep the fib, note confluence.
- Green and red zones must not overlap (overlapping thesis = no thesis — pick one).
- Two FILLS overlapping read as mud — trendlines crossing a zone are fine, stacked fills are not.
- Total filled area <= ~25% of the pane. Keep the last ~10 candles unobstructed.

"Less is more" checklist — run before finishing:
1. Can I state each element's job in <= 5 words? If not, delete it.
2. Would deleting the weakest mark change the read? If no, delete it.
3. Two marks saying the same thing? Merge.
4. Is the most recent price action unobstructed?
5. <= 2 heavy (2px), <= 4 hues, <= 3 texts?
6. Could a novice, in 3 seconds, answer "where is the floor, where is the ceiling, which
   way is it leaning?" That is the whole test.

QUICK-REFERENCE (paste-ready defaults)
    support line     draw_support     #089981  2px solid (major) / 1px dashed* (minor)
    resistance line  draw_support     #F23645  2px solid (major) / 1px dashed* (minor)
    demand zone      draw_rectangle   color #089981 lw 1, fill_color #0899811A
    supply zone      draw_rectangle   color #F23645 lw 1, fill_color #F236451A
    trendline        draw_trendline   #2962FF 2px (or #089981 up / #F23645 down if directional)
    projection       draw_ray         same hue, 1px dotted*
    channel          draw_channel     #2962FF lw 1, fill_color #2962FF14
    fibonacci        draw_fib         #9B51E0 (only color it ever gets)
    event marker     draw_vertical    #787B86 lw 1 pattern dotted
    attention/invalid  any            #FF9800 (max one per chart)
    label            draw_callout(boxed:false)  parent hue or #787B86; <=4 words; left-anchored
    z-order          zones -> fib -> trendlines -> horizontals -> verticals -> text
    budget           <=8 elements, <=3 fills, <=3 texts, <=4 hues, <=2 heavy
    * dashed/dotted on non-vertical lines -> use draw_raw with ptrn

For worked recipes (key S/R, trend+channel, fib a swing, annotate an earnings gap), the
full primitive-selection matrix, and tool gotchas (date snapping, verified removal, async
reloads, zone geometry, corporate events), call get_drawing_guide again with detail:"recipes".
Do not fetch it for a one-line "draw support at X".`;

export const GUIDE_RECIPES = `Tratto — Recipes, Selection Matrix & Tool Gotchas

Use this when a request is non-trivial (multiple overlays, a full markup) or when you hit a
tool quirk. For a one-line "draw support at X", the core guide is enough.

FULL PRIMITIVE-SELECTION MATRIX
| Scenario | Use | Not | Why |
|---|---|---|---|
| Level touched 2+ times at nearly the same price (+/-0.3%) | horizontal | trendline | precise repeated price = a line |
| Level is a region (touches spread >0.5%, or wicks pierce it) | rectangle zone | horizontal | a line implies false precision; zones absorb wick noise |
| Supply/demand, consolidation base, value area, gap | rectangle zone | multiple horizontals | one filled box beats 2-3 lines cluttering the axis |
| Rising/falling structure, 2-3 clean touches, contained | trendline (segment) | ray | segment ends where evidence ends |
| Same, but you want to project it forward | ray | segment | extension = explicit forecast; style dotted |
| Price oscillating between two parallel bounds | channel | 2 trendlines | one object, one fill, half the clutter |
| Pullback targets after a clear impulse swing | fibonacci | hand-drawn 38/50/62 lines | auto levels are exact and engine-labeled |
| Dated event (earnings, split, Fed, news) | vertical, dotted | floating callout | time markers belong to the time axis |
| A word/number the chart cannot say ("Neckline", "3rd test") | annotation (borderless) | callout box | boxes are heavy; default borderless |
| Label that must survive over busy candles | callout (boxed) | annotation | use the box only when the background is noisy |
| RSI / MACD / BB / MA | engine study (add_indicator) | redrawing with lines | never hand-fake an indicator |

Novice tells to avoid: everything drawn as infinite rays shooting off-screen; three
overlapping fibs (confetti); a line for every wick instead of one zone; paragraphs of text
on the canvas; rainbow hues where every tool is used exactly once.

ZONE GEOMETRY (how to build a rectangle zone well)
- Height: span the wick extremes of the touches. Aim 0.5-1.5% of price. > 3% tall means
  it is a range, not a level — reconsider.
- Left edge: the first touch (date1). Right edge: extend ~5% of the visible bars PAST the
  last bar (date2 a few bars into the future) so it reads as still live.
- Border line_width 1, fill_color at ~10% alpha, same hue as border.

WORKED RECIPES

A — "Mark the key support/resistance"
1. Cluster swing highs/lows. Tight cluster -> line; dispersed -> zone.
2. Support zone: draw_rectangle border #089981, fill_color #0899811A, spanning wick
   extremes, right edge past the last bar.
3. Resistance (3 tight touches): draw_support #F23645, 2px solid.
4. Secondary minor support below: horizontal #089981, 1px dashed (via draw_raw).
5. One label, left edge, above resistance: draw_callout(boxed:false, "192.40 - 3rd test", #F23645).
-> 4 elements, 2 hues. Floor/ceiling read in one glance.

B — "Draw the trend + channel"
1. draw_channel from the two anchor lows: #2962FF lw 1, fill_color #2962FF14.
2. Projecting? draw_ray along the lower bound, #2962FF 1px dotted (via draw_raw) — the
   forecast visibly differs from the evidence.
3. A real horizontal support inside the channel: #089981 1px solid.
4. Optional label at the channel's left end: "Uptrend since Mar", #2962FF.
-> Never also draw separate trendlines on the same swing — the channel already contains them.

C — "Fib the last swing"
1. One draw_fib only, low->high (uptrend pullback), color #9B51E0.
2. Confluence: if 61.8% sits on prior structure, do not add a horizontal — add one label at
   the level, left-anchored: "61.8 = prior high", #9B51E0.
3. Optional invalidation: draw_support #FF9800 2px below 78.6% + label "invalid < 168.20".
   (Spends the chart's single amber.)
-> 2-3 elements. Adding lines around a fib is the fastest way to clutter.

D — "Annotate the earnings gap"
1. draw_vertical at the earnings date: #787B86, lw 1, pattern:"dotted".
2. Gap zone: draw_rectangle from pre-gap close to post-gap open, gap day -> a few bars past
   last bar. Gap-up (support): green border + #0899811A fill; gap-down: red. If the point is
   "unfilled gap = magnet", use amber #FF9800 / #FF98001A.
3. One label at top of pane on the vertical's date: "Q2 earnings +8.4%", #787B86.
-> 3 elements; the gap zone doubles as a live S/R zone going forward.

TOOL GOTCHAS (digest — full operational detail arrives in each tool's result/error payload)
- Dates snap to the nearest loaded bar (echoed in snapped.{date1,date2}); dates BEFORE the
  earliest loaded bar are REJECTED — set_range wider first. Dates after the last bar are OK
  (that is how you project/extend right).
- Dashed/dotted is native only on draw_vertical; for any other line use draw_raw with the same
  params plus ptrn:"dashed"|"dotted" (fields: col,lw,ptrn,v0,v1,d0,d1).
- Removal is verified by re-read, not by thrown errors — trust the removed/remaining counts.
  Prefer clear_drawings(scope:"mine") over "all".
- Async reloads (set_periodicity / set_range / add_comparison) rebuild the dataset and
  INVALIDATE date anchors — re-read_drawings before adding more marks. add_comparison also
  switches the y-axis to a PERCENT scale (do not mix price-level horizontals with it).
- get_corporate_events needs DAILY-or-larger periodicity, or it returns 0.
- draw_raw discovery: hand-draw an exotic tool (pitchfork, gann, volume-profile) once on
  Yahoo, then read_drawings to harvest its exact serialized params.`;
