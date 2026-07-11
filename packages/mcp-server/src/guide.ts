/**
 * Tratto drawing design system — the guidance the AI needs to draw *well* on a
 * Yahoo Finance chart, which the tool schemas alone don't carry. Delivered
 * through the MCP `get_drawing_guide` tool so it travels with the tools (works
 * for Claude Code, Codex, any MCP agent — zero install).
 *
 * Three layers, disclosed on demand to stay token-cheap:
 *   GUIDE_CORE     (detail:"core", default) — palette, tiers, fills, budget, text.
 *   GUIDE_RECIPES  (detail:"recipes")       — worked recipes, selection matrix, collisions.
 *   GUIDE_ADVANCED (detail:"advanced")      — long-tail tools + indicator styling + gotchas.
 *
 * Plain text on purpose: consumed by an LLM as guidance, so no backticks/fences
 * (which would break these template literals under tsc). Single source of truth.
 */

export const GUIDE_CORE = `Tratto — Pro Desk Annotation System (core)

The tool schemas tell you WHAT each drawing takes. This tells you HOW to draw so a
marked-up chart stays clean and instantly readable to a pro AND a novice. Two voices,
one chart: DRAWINGS are claims (saturated, deliberate), INDICATORS are context (muted,
thin). Fewer, well-chosen marks always beat more.

WORKFLOW (every session)
1. open_chart(symbol), then get_chart_summary + read_drawings (never near-duplicate an
   existing line).
2. Doing a multi-element markup? Prefer candles: set_chart_style("candle"). Yahoo's
   default LINE chart paints price in bright blue — blue drawings camouflage against it.
   If you stay on a line/area chart, do not use #2962FF for anything that crosses the
   price path; use the directional color or gray instead.
3. Decide the ONE idea the chart should convey, list the marks, cut to budget. If the
   ask exceeds budget, draw the top-N by importance and SAY what you omitted.
4. Set color/width/pattern EXPLICITLY on every mark — never rely on "auto".
5. Verify with read_drawings. Replacing a view? clear_drawings(scope:"mine") first.

SEMANTIC PALETTE (the whole palette — color is a claim, use nothing else)
Every hex holds on BOTH light and dark chart themes.

| Hex | Meaning | Used on |
|---|---|---|
| #089981 green | support / demand / bullish | horizontals below price, demand zones, up trendlines |
| #F23645 red | resistance / supply / bearish | horizontals above price, supply zones, down trendlines |
| #2962FF blue | analyst-placed structure, no bull/bear claim | trendlines, channels, rays, pitchfork, patterns (Gartley) |
| #9B51E0 purple | computed geometry — "the math drew this" | ALL fib tools, regression, average, quadrant, tirone, gann, speed, time cycle |
| #787B86 gray | zero-opinion context | verticals/events, crosslines, measurements, volume profile, free commentary |
| #FF9800 amber | the single "look here" flag | breakout, invalidation, gap — MAX ONE per chart |

- Max 4 hues per chart (gray is free). Green/red = position vs price. A trendline is BLUE
  unless its break direction IS the thesis.
- Never place a red DASHED horizontal within ~0.5% of the last price — Yahoo's own
  last-price marker is exactly that (a red dashed line + red axis badge). To flag the
  current level, use amber instead.

WEIGHT x PATTERN (conviction; pattern is a native arg on every line tool)
| Tier | style | meaning |
|---|---|---|
| Major | 2px solid | confirmed, 3+ touches, the decision level |
| Standard | 1px solid | valid, 2 touches |
| Speculative | 1px dashed | hypothesis, 1 touch, unconfirmed |
| Projected | 1px dotted | future: targets, ray extensions, forecasts |
Verticals/events: 1px dotted always. Computed tools (fib etc.): 1px solid.
Max TWO marks at 2px per chart. Never 3px+ except one deliberate amber hero.

FILLS (fill_color + fill_opacity)
Fill hue ALWAYS equals the border hue. Opacity budget: 0.10 zones/rectangles, 0.08
channels and anything large, 0.15 absolute ceiling; volume profile gray at 0.25 (it must
survive). Max 3 filled objects, only 1 large; total painted area under ~25% of the pane;
fills never overlap each other. Fib fill: "transparent" (the engine's default wash is mud).

BUDGET (slot cost: line/label = 1, zone/channel/fib = 2, multi-line tool = 3)
Max 8 slots (aim 5-6). Also: 3 horizontals, 3 texts, 2 verticals, 1 fib-family object,
1 channel-or-pitchfork, 1 amber, 2 marks at 2px, 4 hues.

Z-ORDER (creation order = paint order; draw bottom-up)
volume profile -> zones/ellipses/channels -> fib family -> computed lines ->
trendlines/rays/arrows -> horizontals/crosslines -> verticals -> text last.

TEXT & LABELS
- A pure price level never gets a text label: pass axis_label:true instead — it prints a
  colored price badge on the axis, native-looking, zero canvas ink. Cap 2 axis labels,
  decision levels only.
- Text earns a place only saying what geometry cannot: "Q2 earnings", "H&S neckline",
  "invalid < 172". Max 4 words, max 3 texts. Numbers beat words.
- Prefer borderless: pass draw_callout boxed:false (the tool itself defaults to boxed).
  Place text in EMPTY space, left half of the chart, never within ~3 bars of the last
  candle. boxed:true only over dense candles: bg_color = own hue at ~0.15 alpha, border
  1px same hue, text same hue.
- Fonts: font_size 11 (12 for the single headline), font_weight normal (bold ONLY on the
  amber flag). Never set font_family or font_style.

FIBONACCI (one per chart, on the single dominant swing)
draw_fib color #9B51E0, line_width 1, fill_color "transparent", show_labels true,
levels [0, 0.382, 0.5, 0.618, 1]. Add 1.272 and 1.618 only when projecting targets;
0.236/0.786 only if asked. Never add horizontals at fib levels (note confluence in text).
Never stack two fib-family objects.

FINAL CHECK (before you report done)
each mark's job in 5 words? -> weakest mark deletable without changing the read? ->
two marks saying one thing? merge -> last 15% of bars unobstructed? -> a novice can
answer in 3 seconds: where is the floor, the ceiling, which way is it leaning?

QUICK DEFAULTS (paste-ready)
    support / resistance  draw_support  #089981 / #F23645, 2px solid major / 1px dashed minor; axis_label on the decision level
    demand / supply zone  draw_rectangle  same hue, line_width 1, fill_opacity 0.10
    trendline             draw_trendline  #2962FF 2px (green up / red down only if direction IS the thesis)
    projection            draw_ray        parent hue, 1px dotted
    channel               draw_channel    #2962FF 1px, fill_opacity 0.08
    fibonacci             draw_fib        #9B51E0 1px, fill transparent, levels [0,0.382,0.5,0.618,1]
    event                 draw_vertical   #787B86 1px dotted
    attention             any             #FF9800, max one, may be 2px + bold label
    label                 draw_callout(boxed:false)  parent hue, font_size 11, <=4 words, left-anchored
    indicators            muted, width 1: gold #E8A838 / sky #56B4E9 / pink #F06292 / slate #9598A1

For worked recipes, zone geometry, the selection matrix and collision rules:
get_drawing_guide(detail:"recipes"). For long-tail tools (gann/pitchfork/profile/harmonics/
regression) and indicator coloring: get_drawing_guide(detail:"advanced"). Skip both for a
one-line "draw support at X".`;

export const GUIDE_RECIPES = `Tratto — Recipes, Selection Matrix & Collision Rules

Use this for a non-trivial markup (multiple overlays). For a one-line "draw support at X",
the core guide is enough. (Long-tail tools and indicator styling live in detail:"advanced".)

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
| A region that is an episode in TIME (blow-off, squeeze, accumulation) | ellipse | rectangle | rectangle = price claim, ellipse = an event; fill_opacity 0.08 |
| "How far / how long was that move?" | draw_measurement | trendline + callout | it computes and labels itself; keep it gray |
| Directional emphasis into a target | draw_arrow | trendline | max one, usually the amber; arrowhead fill = line color |
| One exact (price, time) pivot | draw_crossline | support + vertical pair | gray dotted 1px, one object |
| Where did volume concentrate | draw_volume_profile | hand-drawn zones | gray, fill_opacity 0.25, counts as your one large fill |
| Trend "fair value" + deviation | draw_regression_line / draw_average_line | freehand channel | purple 1px, ONE band, dotted same hue |
| Dated event (earnings, split, Fed) | vertical, dotted | floating callout | time markers belong to the time axis |
| A word/number the chart cannot say | draw_callout(boxed:false) | callout box | boxes are heavy; default borderless |
| RSI / MACD / BB / MA | add_indicator | redrawing with lines | never hand-fake an indicator (see detail:"advanced") |

Novice tells to avoid: everything drawn as infinite rays off-screen; three overlapping fibs
(confetti); a line for every wick instead of one zone; paragraphs of text on the canvas;
rainbow hues where every tool is used exactly once.

ZONE GEOMETRY (building a rectangle zone well)
- Height: span the wick extremes of the touches. Aim 0.5-1.5% of price. >3% tall means it
  is a range, not a level — reconsider.
- Left edge: the first touch (date1). Right edge: extend a few bars PAST the last bar
  (date2 into the future) so it reads as still live.
- Border line_width 1, fill_color = same hue as border, fill_opacity 0.10.

WORKED RECIPES

A — "Mark the key support/resistance"
1. Cluster swing highs/lows. Tight cluster -> line; dispersed -> zone.
2. Support zone: draw_rectangle border #089981, fill_color #089981, fill_opacity 0.10,
   spanning wick extremes, right edge past the last bar.
3. Resistance (3 tight touches): draw_support #F23645, 2px solid, axis_label:true.
4. Secondary minor support below: draw_support #089981, 1px, pattern:"dashed".
5. One label, left edge: draw_callout(boxed:false, "3rd test", color #F23645). The price
   already shows on the axis badge — the label says only what the number cannot.
-> 4 marks, 2 hues. Floor/ceiling read in one glance.

B — "Draw the trend + channel"
1. draw_channel from the two anchor lows: #2962FF line_width 1, fill_opacity 0.08.
2. Projecting? draw_ray along the lower bound, #2962FF 1px, pattern:"dotted" — the forecast
   visibly differs from the evidence.
3. A real horizontal support inside the channel: draw_support #089981 1px solid.
4. Optional label at the channel's left end: "Uptrend since Mar", #2962FF.
-> Never also draw separate trendlines on the same swing — the channel already contains them.

C — "Fib the last swing"
1. One draw_fib only, low->high (uptrend pullback): color #9B51E0, line_width 1,
   fill_color "transparent", levels [0, 0.382, 0.5, 0.618, 1].
2. Confluence: if 61.8% sits on prior structure, do not add a horizontal — add one label
   at the level, left-anchored: "61.8 = prior high", #9B51E0.
3. Golden-pocket emphasis: add ONE draw_rectangle over 0.5-0.618, #9B51E0 border 1px,
   fill_opacity 0.08 — never more fib ink.
-> 2-3 marks. Adding lines around a fib is the fastest way to clutter.

D — "Annotate the earnings gap"
1. draw_vertical at the earnings date: #787B86, line_width 1, pattern:"dotted".
2. Gap zone: draw_rectangle from pre-gap close to post-gap open, gap day -> a few bars past
   last bar. Gap-up (support): green border + fill_opacity 0.10; gap-down: red. If the point
   is "unfilled gap = magnet", spend the chart's single amber (#FF9800).
3. One label at top of pane on the vertical's date: "Q2 earnings +8.4%", #787B86.
-> 3 marks; the gap zone doubles as a live S/R zone going forward.

COLLISION RULES
- Two horizontals within 0.4% of each other -> merge into ONE zone. Never near-duplicates.
- A fib level coinciding with an S/R line (+/-0.3%) -> drop the line, keep the fib, note
  confluence in text.
- Green and red zones must not overlap (overlapping thesis = no thesis — pick one).
- Two FILLS overlapping read as mud; trendlines crossing a zone are fine, stacked fills are not.
- One fib-family object per chart, ever. Channel and pitchfork are mutually exclusive.
- Multi-line computed tools (gann fan, speed lines, quadrant, tirone, time cycle, fib
  fan/arc/timezone) cost 3 slots and are ALONE-tools: never two together, and keep the rest
  of the chart to 2-3 simple marks.
- A study line (MA/BB) already tracking a trendline's path -> drop the trendline, keep the
  study, note it in text.
- Total filled area <= ~25% of the pane. Keep the last ~10 candles unobstructed.`;

export const GUIDE_ADVANCED = `Tratto — Long-tail Tools, Indicator Styling & Engine Gotchas

Fetch this only when using an exotic tool, styling an indicator, or hitting a tool quirk.

EXOTIC-TOOL ETIQUETTE (the by-name rule)
Gann fan, speed arc/line, time cycle, quadrant, tirone, fib arc/fan/timezone, Gartley,
pitchfork: these are opinionated frameworks — draw them ONLY when the user asks by name,
never proactively. All: line_width 1, single hue, cost 3 slots, and stand alone with at
most 2-3 simple supporting marks. Where a shape is filled (gann/speed/time cycle/gartley/
fib arc-fan-timezone), keep fill_opacity <= 0.05 or fill_color "transparent" (pitchfork
has no fill).
- All computed constructions: #9B51E0 purple (fib family, regression, average, quadrant,
  tirone, gann, speed, time cycle).
- Pitchfork and Gartley are analyst-placed PATTERN claims, not math: #2962FF blue
  (Gartley fill_opacity 0.05). draw_pitchfork REPLACES a channel (never both); 3 anchors required.
- draw_time_cycle / draw_fib_timezone print repeating verticals — only on a chart with
  <= 1 other drawing, or they become a picket fence.
- draw_volume_profile: gray fill at fill_opacity 0.25; set the range to the consolidation you
  are analyzing, NOT the whole chart. It IS your one large fill.
- Range tools (draw_quadrant_lines, draw_tirone_levels, draw_average_line, draw_regression_line)
  take two DATES; price levels are computed from the data in that window. On regression/average,
  enable at most ONE deviation band: { color: same purple, pattern:"dotted", line_width:1 }.

INDICATOR STYLING (context voice — never the semantic drawing palette)
Studies must whisper so they can never be mistaken for a support/resistance CLAIM: width 1,
muted colors only. Study palette:
  gold #E8A838 (fast/short), sky #56B4E9 (slow/long), pink #F06292 (third line),
  slate #9598A1 (bands / median / context).
- Moving averages: MA20 gold, MA50 sky, MA200 slate — outputs { color, width:1 }. Max 3 MAs.
- Bollinger Bands: all three outputs slate #9598A1; keep the engine's Channel Fill.
- Own-panel oscillators (RSI, MACD): main line sky, signal gold, histogram engine default.
- Get exact output KEYS from list_indicators before setting outputs — MACD/Bollinger keys
  are multi-word ("Bollinger Bands Top", "MACD", "Signal"); never guess them.
- Never redraw an indicator with line tools; never recolor a study green/red/amber (those
  hues are reserved for drawing claims).

ENGINE GOTCHAS (digest — full operational detail arrives in each tool's result/error payload)
- Dates snap to the nearest loaded bar (echoed in snapped.{date1,date2}); dates BEFORE the
  earliest loaded bar are REJECTED — set_range wider first. Dates after the last bar are OK
  (that is how you project/extend to the right).
- fill_opacity has no separate engine field: it is baked into fill_color as an rgba alpha
  for you. Passing fill_color "transparent" turns a fill off cleanly.
- Removal is verified by re-read, not by thrown errors — trust the removed/remaining counts.
  Prefer clear_drawings(scope:"mine") over "all".
- Async reloads (set_periodicity / set_range / add_comparison) rebuild the dataset and
  INVALIDATE date anchors — re-read_drawings before adding more marks. add_comparison also
  switches the y-axis to a PERCENT scale (do not mix price-level horizontals with it).
- get_corporate_events needs DAILY-or-larger periodicity, or it returns 0.
- draw_raw is the escape hatch for anything without a dedicated tool: hand-draw it once on
  Yahoo, then read_drawings to harvest its exact serialized params.`;
