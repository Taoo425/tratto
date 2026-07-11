import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bridge } from "./bridge.js";
import { GUIDE_CORE, GUIDE_RECIPES, GUIDE_ADVANCED } from "./guide.js";

/**
 * Registers the MCP tools exposed to the calling agent:
 *  - get_chart_data (read-only)
 *  - draw_support / read_drawings / clear_drawings (basic drawing, issue 002)
 *  - draw_trendline / draw_fib (two-point drawing, issue 003)
 *
 * Every tool forwards to the extension and returns the full ToolResponse
 * envelope (including the `symbol` echo) as-is, so the calling agent can tell
 * success from failure — and catch a wrong-ticker situation — without extra
 * calls.
 */
export function registerTools(server: McpServer, bridge: Bridge): void {
  const forward = (response: Awaited<ReturnType<Bridge["sendToExtension"]>>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    isError: response.ok === false,
  });

  // Session-scoped, self-healing style nudge. If the agent starts drawing before it
  // has fetched the design guide even once, append a one-time reminder to the first
  // draw result so multi-element markups don't come out unstyled. ~15 tokens, once.
  let guideFetched = false;
  let drawNudged = false;
  const forwardDraw = (response: Awaited<ReturnType<Bridge["sendToExtension"]>>) => {
    const out = forward(response);
    if (guideFetched || drawNudged) return out;
    drawNudged = true;
    return {
      ...out,
      content: [
        ...out.content,
        {
          type: "text" as const,
          text:
            "(Style note: the drawing design guide has not been loaded this session. Before " +
            "any multi-element markup, call get_drawing_guide so colors, weights, fill opacity, " +
            "and layout stay clean and legible.)",
        },
      ],
    };
  };

  server.registerTool(
    "get_drawing_guide",
    {
      title: "Get Drawing Design Guide",
      description:
        "Return Tratto's drawing design system — the palette, line-weight/pattern " +
        "hierarchy, element budget, z-order and composition rules a pro desk analyst " +
        "uses so several overlapping drawings stay clean and legible. This guidance is " +
        "NOT in the individual tool schemas. CALL THIS ONCE before drawing anything " +
        "beyond a single trivial line (any multi-element markup, 'mark the key levels', " +
        "'draw the trend', etc.) and follow it. Local/static — no chart needed. Pass " +
        'detail:"recipes" for worked recipes, the full selection matrix and collision ' +
        'rules (non-trivial markups); detail:"advanced" for the long-tail tools ' +
        "(gann/pitchfork/volume-profile/harmonics/regression), indicator coloring, and " +
        "engine gotchas (date snapping, verified removal, async reloads).",
      inputSchema: {
        detail: z
          .enum(["core", "recipes", "advanced"])
          .optional()
          .describe(
            'Which section to return. "core" (default) = palette, weights, fills, budget, ' +
              'z-order, text/axis-label rules + quick defaults. "recipes" = worked examples, ' +
              'the full selection matrix and collision rules (non-trivial markups). ' +
              '"advanced" = long-tail tools, indicator styling, and engine gotchas.',
          ),
      },
    },
    async (params) => {
      guideFetched = true;
      return {
        content: [
          {
            type: "text" as const,
            text:
              params?.detail === "advanced"
                ? GUIDE_ADVANCED
                : params?.detail === "recipes"
                  ? GUIDE_RECIPES
                  : GUIDE_CORE,
          },
        ],
        isError: false,
      };
    },
  );

  server.registerTool(
    "open_chart",
    {
      title: "Open Yahoo Finance Chart",
      description:
        "Navigate the user's browser to Yahoo Finance's Advanced Chart for a symbol " +
        "and wait until the chart is truly ready to read/draw on. Reuses an existing " +
        "Yahoo tab when there is one (otherwise opens a new tab), and fixes the " +
        "'must manually refresh once before the extension connects' problem. Call " +
        "this first when the user names a stock — then get_chart_data / drawing tools " +
        "work immediately without any manual step. Before drawing anything beyond a " +
        "single trivial line, call get_drawing_guide once and follow its design system " +
        "so overlays stay clean. Returns whether a tab was reused and how many bars loaded.",
      inputSchema: {
        symbol: z
          .string()
          .describe('Ticker symbol to open, e.g. "NVDA" or "AAPL". Case-insensitive.'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How long to wait for the chart to become ready, in ms. Defaults to 15000."),
      },
    },
    async (params) => forward(await bridge.sendToExtension("open_chart", params)),
  );

  server.registerTool(
    "get_chart_data",
    {
      title: "Get Chart Data",
      description:
        "Read the OHLCV bars currently loaded in the active Yahoo Finance chart " +
        "(ChartIQ engine). Read-only. Returns a compact summary head (symbol, " +
        "interval, total bars, loaded range, last close, window high/low with dates, " +
        "% change) plus a CSV block ('date,o,h,l,c,v', one row per bar). Defaults to " +
        "the most recent 50 bars to stay token-cheap; use get_chart_summary if you " +
        "only need the header. Use last_n / from / to to pick a window, and " +
        "max_points to downsample via bucket aggregation (extremes preserved).",
      inputSchema: {
        last_n: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return only the most recent N bars. Defaults to 50 when no window is given."),
        from: z
          .string()
          .optional()
          .describe("Inclusive lower bound on bar date (ISO-ish, e.g. as emitted in the CSV)."),
        to: z
          .string()
          .optional()
          .describe("Inclusive upper bound on bar date (ISO-ish)."),
        max_points: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Downsample the selected bars to at most this many points via bucket " +
              "aggregation (first-open/max-high/min-low/last-close/sum-volume per bucket). " +
              "Never stride-samples, so support/resistance extremes survive.",
          ),
      },
    },
    async (params) => forward(await bridge.sendToExtension("get_chart_data", params)),
  );

  server.registerTool(
    "get_chart_summary",
    {
      title: "Get Chart Summary",
      description:
        "Read just the compact summary head for the active Yahoo Finance chart " +
        "(symbol, interval, total bars, loaded range, last close, recent-window " +
        "high/low with dates, % change) with ZERO bar data. Read-only. Use this when " +
        "you only need to confirm which symbol/period is on screen without spending " +
        "tokens on bars.",
      // Zero-arg tool: no inputSchema (see read_drawings for why an empty
      // inputSchema wrongly rejects callers that omit `arguments`).
    },
    async () => forward(await bridge.sendToExtension("get_chart_summary", {})),
  );

  server.registerTool(
    "get_capabilities",
    {
      title: "Get Engine Capabilities",
      description:
        "Probe which ChartIQ engine methods are present on the live chart (a " +
        "typeof-map over the ~18 methods this tool depends on: drawing, chart-type, " +
        "periodicity, comparison, studies, layout export/import). Read-only. " +
        "Capability is decided purely by method presence — there is no readable " +
        "engine version. Use this to diagnose whether a Yahoo change has removed a " +
        "surface a tool needs.",
      // Zero-arg tool: no inputSchema.
    },
    async () => forward(await bridge.sendToExtension("get_capabilities", {})),
  );

  server.registerTool(
    "draw_support",
    {
      title: "Draw Support/Resistance Line",
      description:
        "Draw a horizontal support/resistance line at a given price on the active " +
        "Yahoo Finance chart. The line is drawn onto Yahoo's own chart and looks " +
        "identical to a hand-drawn one. Before drawing, call read_drawings to see " +
        "what's already on the chart (avoid duplicate lines) and get_chart_data to " +
        "get real bar dates/prices to anchor on — don't invent dates. For color/width " +
        "conventions (support=green #089981, resistance=red #F23645, major=2px), follow " +
        "get_drawing_guide. Note: programmatically drawn lines are NOT persisted by " +
        "Yahoo — they disappear on page refresh or symbol change.",
      inputSchema: {
        price: z
          .number()
          .describe("The price (y-axis value) at which to draw the horizontal line."),
        color: z
          .string()
          .optional()
          .describe(
            "Line color as a CSS hex/name string. Per get_drawing_guide: support = " +
              '"#089981" (green), resistance = "#F23645" (red). Optional.',
          ),
        line_width: z
          .number()
          .positive()
          .optional()
          .describe("Line width in pixels. Optional; defaults to 1."),
        pattern: patternSchema(),
        axis_label: axisLabelSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_support", params)),
  );

  server.registerTool(
    "draw_trendline",
    {
      title: "Draw Trend Line",
      description:
        "Draw a straight trend line between two (date, price) points on the active " +
        "Yahoo Finance chart. The line is drawn onto Yahoo's own chart and looks " +
        "identical to a hand-drawn one. Dates are snapped to the nearest loaded bar " +
        "(the response echoes which bar each endpoint landed on). Before drawing, " +
        "call read_drawings to see what's already on the chart (avoid duplicate " +
        "lines) and get_chart_data to get real bar dates/prices to anchor on — " +
        "don't invent dates. Note: programmatically drawn lines are NOT persisted " +
        "by Yahoo — they disappear on page refresh or symbol change.",
      inputSchema: {
        date1: z
          .string()
          .describe(
            "Date for point 1 (ISO-ish string, e.g. as returned by get_chart_data). " +
              "Snapped to the nearest loaded bar.",
          ),
        price1: z.number().describe("Price (y-axis value) for point 1."),
        date2: z
          .string()
          .describe(
            "Date for point 2 (ISO-ish string, e.g. as returned by get_chart_data). " +
              "Snapped to the nearest loaded bar.",
          ),
        price2: z.number().describe("Price (y-axis value) for point 2."),
        color: z
          .string()
          .optional()
          .describe('Line color as a CSS hex/name string, e.g. "#FF3B30". Optional.'),
        line_width: z
          .number()
          .positive()
          .optional()
          .describe("Line width in pixels. Optional; defaults to 1."),
        pattern: patternSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_trendline", params)),
  );

  server.registerTool(
    "draw_fib",
    {
      title: "Draw Fibonacci Retracement",
      description:
        "Draw a Fibonacci retracement between two (date, price) anchor points on " +
        "the active Yahoo Finance chart. Point ordering is significant: point 1 is " +
        "the 0% anchor and point 2 is the 100% anchor — retracement levels " +
        "(23.6/38.2/50/61.8/78.6%) are drawn between them, and extensions " +
        "(127.2/161.8/…%) lie beyond point 2. Practical convention: to measure a " +
        "pullback within an up-move, pass point 1 = swing low and point 2 = swing " +
        "high. Uses ChartIQ's default retracement levels. The drawing is drawn onto " +
        "Yahoo's own chart and looks identical to a hand-drawn one. Dates are " +
        "snapped to the nearest loaded bar (the response echoes which bar each " +
        "endpoint landed on). Before drawing, call read_drawings to see what's " +
        "already on the chart (avoid duplicate lines) and get_chart_data to get " +
        "real bar dates/prices to anchor on — don't invent dates. Note: " +
        "programmatically drawn lines are NOT persisted by Yahoo — they disappear " +
        "on page refresh or symbol change.",
      inputSchema: {
        date1: z
          .string()
          .describe(
            "Date for anchor point 1 — the 0% anchor (ISO-ish string, e.g. as " +
              "returned by get_chart_data). Snapped to the nearest loaded bar. For " +
              "a pullback-within-an-up-move measurement, use the swing low here.",
          ),
        price1: z
          .number()
          .describe("Price (y-axis value) for anchor point 1, the 0% anchor."),
        date2: z
          .string()
          .describe(
            "Date for anchor point 2 — the 100% anchor (ISO-ish string, e.g. as " +
              "returned by get_chart_data). Snapped to the nearest loaded bar. For " +
              "a pullback-within-an-up-move measurement, use the swing high here.",
          ),
        price2: z
          .number()
          .describe("Price (y-axis value) for anchor point 2, the 100% anchor."),
        color: z
          .string()
          .optional()
          .describe('Line/fill color as a CSS hex/name string, e.g. "#FF3B30". Optional.'),
        ...fibStyleSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_fib", params)),
  );

  server.registerTool(
    "draw_fib_arc",
    {
      title: "Draw Fibonacci Arc",
      description:
        "Draw a Fibonacci arc from a base (date, price) pivot through a second " +
        "(date, price) point, plus a 3rd price offsetting the arc radius (3 anchors). " +
        "Dates snap to the nearest loaded bar. Takes the same style args as draw_fib " +
        "(levels/colors/labels). For style conventions (weights, palette, when to " +
        "dash vs solid), follow get_drawing_guide.",
      inputSchema: {
        date1: z.string().describe("Date for anchor point 1 (ISO-ish). Snapped to nearest bar."),
        price1: z.number().describe("Price for anchor point 1."),
        date2: z.string().describe("Date for anchor point 2 (ISO-ish). Snapped to nearest bar."),
        price2: z.number().describe("Price for anchor point 2."),
        price3: z
          .number()
          .describe("Price offsetting the arc radius — required (no separate date, same offset axis)."),
        color: colorSchema(),
        ...fibStyleSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_fib_arc", params)),
  );

  server.registerTool(
    "draw_fib_fan",
    {
      title: "Draw Fibonacci Fan",
      description:
        "Draw a Fibonacci fan from a base (date, price) pivot through a second " +
        "(date, price) point, plus a 3rd price offsetting the fan lines (3 anchors). " +
        "Dates snap to the nearest loaded bar. Takes the same style args as draw_fib " +
        "(levels/colors/labels). For style conventions (weights, palette, when to " +
        "dash vs solid), follow get_drawing_guide.",
      inputSchema: {
        date1: z.string().describe("Date for anchor point 1 (ISO-ish). Snapped to nearest bar."),
        price1: z.number().describe("Price for anchor point 1."),
        date2: z.string().describe("Date for anchor point 2 (ISO-ish). Snapped to nearest bar."),
        price2: z.number().describe("Price for anchor point 2."),
        price3: z
          .number()
          .describe("Price offsetting the fan lines — required (no separate date)."),
        color: colorSchema(),
        ...fibStyleSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_fib_fan", params)),
  );

  server.registerTool(
    "draw_fib_projection",
    {
      title: "Draw Fibonacci Projection",
      description:
        "Draw a Fibonacci projection across three (date, price) points (a move, then " +
        "a retracement/pullback, projecting the next move's targets). Dates snap to " +
        "the nearest loaded bar. Takes the same style args as draw_fib " +
        "(levels/colors/labels). For style conventions (weights, palette, when to " +
        "dash vs solid), follow get_drawing_guide.",
      inputSchema: {
        date1: z.string().describe("Date for anchor point 1 (ISO-ish). Snapped to nearest bar."),
        price1: z.number().describe("Price for anchor point 1."),
        date2: z.string().describe("Date for anchor point 2 (ISO-ish). Snapped to nearest bar."),
        price2: z.number().describe("Price for anchor point 2."),
        date3: z.string().describe("Date for anchor point 3 (ISO-ish). Snapped to nearest bar."),
        price3: z.number().describe("Price for anchor point 3."),
        color: colorSchema(),
        ...fibStyleSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_fib_projection", params)),
  );

  server.registerTool(
    "draw_fib_timezone",
    {
      title: "Draw Fibonacci Time Zone",
      description:
        "Draw Fibonacci time-zone vertical lines anchored by two (date, price) " +
        "points, spacing future verticals by Fibonacci ratios of the base interval. " +
        "Dates snap to the nearest loaded bar. Takes the same style args as draw_fib " +
        "(levels/colors/labels). For style conventions (weights, palette, when to " +
        "dash vs solid), follow get_drawing_guide.",
      inputSchema: {
        date1: z.string().describe("Date for anchor point 1 (ISO-ish). Snapped to nearest bar."),
        price1: z.number().describe("Price for anchor point 1."),
        date2: z.string().describe("Date for anchor point 2 (ISO-ish). Snapped to nearest bar."),
        price2: z.number().describe("Price for anchor point 2."),
        color: colorSchema(),
        ...fibStyleSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_fib_timezone", params)),
  );

  server.registerTool(
    "read_drawings",
    {
      title: "Read Chart Drawings",
      description:
        "List the drawings currently on the active Yahoo Finance chart (both ones you " +
        "drew and ones the user drew by hand). Read-only. Use this before drawing to " +
        "see what's already there.",
      // No inputSchema: this is a zero-arg tool. Registering `inputSchema: {}`
      // would make the SDK build a z.object({}) that REJECTS an omitted
      // `arguments` field (the MCP spec allows omitting it) with InvalidParams
      // before the handler ever runs. Omitting inputSchema makes the SDK skip
      // input validation entirely, so callers can omit arguments safely.
    },
    async () => forward(await bridge.sendToExtension("read_drawings", {})),
  );

  server.registerTool(
    "draw_ray",
    {
      title: "Draw Ray",
      description:
        "Draw a ray (a line through two (date, price) points that extends beyond the " +
        "second point) on the active Yahoo Finance chart. Dates snap to the nearest " +
        "loaded bar. Use get_chart_data for real bar dates/prices to anchor on.",
      inputSchema: { ...twoPointSchema(), pattern: patternSchema() },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_ray", params)),
  );

  server.registerTool(
    "draw_rectangle",
    {
      title: "Draw Rectangle",
      description:
        "Draw a rectangle between two opposite (date, price) corners on the active " +
        "Yahoo Finance chart — e.g. to box a consolidation range or a supply/demand " +
        "zone. Dates snap to the nearest loaded bar. fill_color is optional.",
      inputSchema: {
        ...twoPointSchema(),
        fill_color: fillColorSchema(),
        pattern: patternSchema(),
        fill_opacity: fillOpacitySchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_rectangle", params)),
  );

  server.registerTool(
    "draw_channel",
    {
      title: "Draw Parallel Channel",
      description:
        "Draw a parallel channel from two (date, price) points on the active Yahoo " +
        "Finance chart (a trend line with a parallel band). Dates snap to the nearest " +
        "loaded bar. fill_color is optional.",
      inputSchema: {
        ...twoPointSchema(),
        fill_color: fillColorSchema(),
        pattern: patternSchema(),
        fill_opacity: fillOpacitySchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_channel", params)),
  );

  server.registerTool(
    "draw_vertical",
    {
      title: "Draw Vertical Line",
      description:
        "Draw a vertical line at a single date on the active Yahoo Finance chart — e.g. " +
        "to mark an event or earnings date. The date snaps to the nearest loaded bar.",
      inputSchema: {
        date: z
          .string()
          .describe("Date for the vertical line (ISO-ish, e.g. from get_chart_data). Snapped to nearest bar."),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
        axis_label: axisLabelSchema(),
        span_panels: spanPanelsSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_vertical", params)),
  );

  server.registerTool(
    "draw_callout",
    {
      title: "Draw Text Callout / Annotation",
      description:
        "Place a text label anchored at a (date, price) on the active Yahoo Finance " +
        "chart. boxed=true (default) draws a boxed callout; boxed=false draws a " +
        "borderless annotation. Use this to annotate an event (e.g. a dividend or a " +
        "pattern) directly on the chart. The date snaps to the nearest loaded bar.",
      inputSchema: {
        date: z.string().describe("Anchor date (ISO-ish, e.g. from get_chart_data). Snapped to nearest bar."),
        price: z.number().describe("Anchor price (y-axis value)."),
        text: z.string().describe("The label text."),
        color: colorSchema(),
        boxed: z
          .boolean()
          .optional()
          .describe("true (default) = boxed callout; false = borderless annotation."),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
        border_color: z
          .string()
          .optional()
          .describe("Border color as a CSS hex/name string. Meaningful for boxed callouts. Optional."),
        bg_color: z
          .string()
          .optional()
          .describe("Background fill color as a CSS hex/name string. Meaningful for boxed callouts. Optional."),
        font_size: fontSizeSchema(),
        font_weight: fontWeightSchema(),
        font_style: fontStyleSchema(),
        font_family: fontFamilySchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_callout", params)),
  );

  server.registerTool(
    "draw_raw",
    {
      title: "Draw Raw (Escape Hatch)",
      description:
        "Escape hatch for the long tail of ChartIQ drawing tools not given a dedicated " +
        "tool (pitchfork, gann fan, elliott wave, volume profile, etc.). Pass the " +
        "ChartIQ tool name as `type` and its already-serialized fields as `params` " +
        "(col/lw/ptrn/v0/v1/d0/d1/text/...). To discover the exact params for a tool, " +
        "hand-draw it once on Yahoo then call read_drawings to read them back.",
      inputSchema: {
        type: z.string().describe('ChartIQ tool name, e.g. "pitchfork", "gannfan", "volumeprofile".'),
        params: z
          .record(z.any())
          .describe("Serialized drawing fields (col/lw/ptrn/v0/v1/d0/d1/text/...). pnl is added for you."),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_raw", params)),
  );

  server.registerTool(
    "draw_crossline",
    {
      title: "Draw Crossline",
      description:
        "Draw a crossline (a full horizontal+vertical crosshair pinned at one " +
        "(date, price) point) on the active Yahoo Finance chart. The date snaps to " +
        "the nearest loaded bar. For style conventions (weights, palette, when to " +
        "dash vs solid), follow get_drawing_guide.",
      inputSchema: {
        date: z.string().describe("Anchor date (ISO-ish, e.g. from get_chart_data). Snapped to nearest bar."),
        price: z.number().describe("Anchor price (y-axis value)."),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
        axis_label: axisLabelSchema(),
        span_panels: spanPanelsSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_crossline", params)),
  );

  server.registerTool(
    "draw_line",
    {
      title: "Draw Infinite Line",
      description:
        "Draw a straight line through two (date, price) points that extends " +
        "infinitely in both directions (unlike draw_trendline, which stops at the " +
        "points) on the active Yahoo Finance chart. Dates snap to the nearest loaded " +
        "bar. For style conventions (weights, palette, when to dash vs solid), " +
        "follow get_drawing_guide.",
      inputSchema: { ...twoPointSchema(), pattern: patternSchema() },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_line", params)),
  );

  server.registerTool(
    "draw_arrow",
    {
      title: "Draw Arrow",
      description:
        "Draw an arrow between two (date, price) points on the active Yahoo Finance " +
        "chart, arrowhead at point 2. Dates snap to the nearest loaded bar. " +
        "fill_color styles the arrowhead. For style conventions (weights, palette, " +
        "when to dash vs solid), follow get_drawing_guide.",
      inputSchema: { ...twoPointSchema(), pattern: patternSchema(), fill_color: fillColorSchema(), fill_opacity: fillOpacitySchema() },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_arrow", params)),
  );

  server.registerTool(
    "draw_ellipse",
    {
      title: "Draw Ellipse",
      description:
        "Draw an ellipse on the active Yahoo Finance chart from a center point to an " +
        "edge point (point 1 = center, point 2 = a point on the ellipse's edge, not " +
        "an opposite corner). Dates snap to the nearest loaded bar. fill_color/" +
        "fill_opacity are optional. For style conventions (weights, palette, when to " +
        "dash vs solid), follow get_drawing_guide.",
      inputSchema: {
        date1: z.string().describe("Date for the center point (ISO-ish). Snapped to nearest bar."),
        price1: z.number().describe("Price for the center point."),
        date2: z.string().describe("Date for the edge point (ISO-ish). Snapped to nearest bar."),
        price2: z.number().describe("Price for the edge point."),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
        fill_color: fillColorSchema(),
        fill_opacity: fillOpacitySchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_ellipse", params)),
  );

  server.registerTool(
    "draw_pitchfork",
    {
      title: "Draw Andrews' Pitchfork",
      description:
        "Draw an Andrews' pitchfork (3 parallel rays fanning from an equidistant " +
        "center) across three (date, price) points on the active Yahoo Finance " +
        "chart. Dates snap to the nearest loaded bar. For style conventions " +
        "(weights, palette, when to dash vs solid), follow get_drawing_guide.",
      inputSchema: {
        date1: z.string().describe("Date for point 1 (ISO-ish). Snapped to nearest bar."),
        price1: z.number().describe("Price for point 1."),
        date2: z.string().describe("Date for point 2 (ISO-ish). Snapped to nearest bar."),
        price2: z.number().describe("Price for point 2."),
        date3: z.string().describe("Date for point 3 (ISO-ish). Snapped to nearest bar."),
        price3: z.number().describe("Price for point 3."),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_pitchfork", params)),
  );

  server.registerTool(
    "draw_gann_fan",
    {
      title: "Draw Gann Fan",
      description:
        "Draw a Gann fan (fixed-ratio angled lines) between two (date, price) " +
        "points on the active Yahoo Finance chart. Dates snap to the nearest loaded " +
        "bar. For style conventions (weights, palette, when to dash vs solid), " +
        "follow get_drawing_guide.",
      inputSchema: { ...twoPointSchema(), pattern: patternSchema(), fill_color: fillColorSchema(), fill_opacity: fillOpacitySchema() },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_gann_fan", params)),
  );

  server.registerTool(
    "draw_speed_arc",
    {
      title: "Draw Speed Resistance Arc",
      description:
        "Draw speed resistance arcs (1/3 and 2/3 retracement arcs of the move) " +
        "between two (date, price) points on the active Yahoo Finance chart. Dates " +
        "snap to the nearest loaded bar. For style conventions (weights, palette, " +
        "when to dash vs solid), follow get_drawing_guide.",
      inputSchema: { ...twoPointSchema(), pattern: patternSchema(), fill_color: fillColorSchema(), fill_opacity: fillOpacitySchema() },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_speed_arc", params)),
  );

  server.registerTool(
    "draw_speed_line",
    {
      title: "Draw Speed Resistance Line",
      description:
        "Draw speed resistance lines (1/3 and 2/3 retracement lines of the move) " +
        "between two (date, price) points on the active Yahoo Finance chart. Dates " +
        "snap to the nearest loaded bar. For style conventions (weights, palette, " +
        "when to dash vs solid), follow get_drawing_guide.",
      inputSchema: { ...twoPointSchema(), pattern: patternSchema(), fill_color: fillColorSchema(), fill_opacity: fillOpacitySchema() },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_speed_line", params)),
  );

  server.registerTool(
    "draw_time_cycle",
    {
      title: "Draw Time Cycle",
      description:
        "Draw repeating vertical time-cycle lines spaced by the interval between two " +
        "(date, price) points on the active Yahoo Finance chart. Dates snap to the " +
        "nearest loaded bar. For style conventions (weights, palette, when to dash " +
        "vs solid), follow get_drawing_guide.",
      inputSchema: { ...twoPointSchema(), pattern: patternSchema(), fill_color: fillColorSchema(), fill_opacity: fillOpacitySchema() },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_time_cycle", params)),
  );

  server.registerTool(
    "draw_measurement",
    {
      title: "Draw Measurement Line",
      description:
        "Draw a measurement line between two (date, price) points on the active " +
        "Yahoo Finance chart — shows the bar count and price delta between them by " +
        "default. Dates snap to the nearest loaded bar. For style conventions " +
        "(weights, palette, when to dash vs solid), follow get_drawing_guide.",
      inputSchema: { ...twoPointSchema(), pattern: patternSchema() },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_measurement", params)),
  );

  server.registerTool(
    "draw_volume_profile",
    {
      title: "Draw Volume Profile",
      description:
        "Draw a volume profile (a horizontal histogram of traded volume by price " +
        "bucket) over a date range on the active Yahoo Finance chart. Anchored by " +
        "two DATES ONLY — price levels/buckets are computed from the data in that " +
        "window, not from price args. Dates snap to the nearest loaded bar. For " +
        "style conventions (weights, palette, when to dash vs solid), follow " +
        "get_drawing_guide.",
      inputSchema: {
        ...dateRangeSchema(),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
        fill_color: fillColorSchema(),
        fill_opacity: fillOpacitySchema(),
        price_buckets: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Number of price buckets in the histogram. Optional; defaults to 30."),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_volume_profile", params)),
  );

  server.registerTool(
    "draw_quadrant_lines",
    {
      title: "Draw Quadrant Lines",
      description:
        "Draw quadrant lines (equal price-quartile dividers) over a date range on " +
        "the active Yahoo Finance chart. Anchored by two DATES ONLY — price levels " +
        "are computed from the data in that window, not from price args. Dates snap " +
        "to the nearest loaded bar. For style conventions (weights, palette, when to " +
        "dash vs solid), follow get_drawing_guide.",
      inputSchema: {
        ...dateRangeSchema(),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
        fill_color: fillColorSchema(),
        fill_opacity: fillOpacitySchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_quadrant_lines", params)),
  );

  server.registerTool(
    "draw_tirone_levels",
    {
      title: "Draw Tirone Levels",
      description:
        "Draw Tirone levels (a fixed set of horizontal support/resistance dividers) " +
        "over a date range on the active Yahoo Finance chart. Anchored by two DATES " +
        "ONLY — price levels are computed from the data in that window, not from " +
        "price args. Dates snap to the nearest loaded bar. For style conventions " +
        "(weights, palette, when to dash vs solid), follow get_drawing_guide.",
      inputSchema: {
        ...dateRangeSchema(),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
        fill_color: fillColorSchema(),
        fill_opacity: fillOpacitySchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_tirone_levels", params)),
  );

  server.registerTool(
    "draw_average_line",
    {
      title: "Draw Average (Regression + Axis Label) Line",
      description:
        "Draw a linear regression fit line with an axis label over a date range on " +
        "the active Yahoo Finance chart, with up to 3 optional standard-deviation " +
        "band channels around it. Anchored by two DATES ONLY — price levels are " +
        "computed from the data in that window, not from price args. Dates snap to " +
        "the nearest loaded bar. For style conventions (weights, palette, when to " +
        "dash vs solid), follow get_drawing_guide.",
      inputSchema: {
        ...dateRangeSchema(),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
        axis_label: axisLabelSchema(),
        bands: bandsSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_average_line", params)),
  );

  server.registerTool(
    "draw_regression_line",
    {
      title: "Draw Regression Line",
      description:
        "Draw a linear regression fit line over a date range on the active Yahoo " +
        "Finance chart, with up to 3 optional standard-deviation band channels " +
        "around it. Anchored by two DATES ONLY — price levels are computed from the " +
        "data in that window, not from price args. Dates snap to the nearest loaded " +
        "bar. For style conventions (weights, palette, when to dash vs solid), " +
        "follow get_drawing_guide.",
      inputSchema: {
        ...dateRangeSchema(),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
        bands: bandsSchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_regression_line", params)),
  );

  server.registerTool(
    "draw_gartley",
    {
      title: "Draw Gartley Pattern",
      description:
        "Draw a Gartley harmonic pattern across 5 (date, price) points — X, A, B, C, " +
        "D, in that sequence — on the active Yahoo Finance chart. Dates snap to the " +
        "nearest loaded bar. For style conventions (weights, palette, when to dash " +
        "vs solid), follow get_drawing_guide.",
      inputSchema: {
        xDate: z.string().describe("Date for point X (ISO-ish). Snapped to nearest bar."),
        xPrice: z.number().describe("Price for point X."),
        aDate: z.string().describe("Date for point A (ISO-ish). Snapped to nearest bar."),
        aPrice: z.number().describe("Price for point A."),
        bDate: z.string().describe("Date for point B (ISO-ish). Snapped to nearest bar."),
        bPrice: z.number().describe("Price for point B."),
        cDate: z.string().describe("Date for point C (ISO-ish). Snapped to nearest bar."),
        cPrice: z.number().describe("Price for point C."),
        dDate: z.string().describe("Date for point D (ISO-ish). Snapped to nearest bar."),
        dPrice: z.number().describe("Price for point D."),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: patternSchema(),
        fill_color: fillColorSchema(),
        fill_opacity: fillOpacitySchema(),
      },
    },
    async (params) => forwardDraw(await bridge.sendToExtension("draw_gartley", params)),
  );

  server.registerTool(
    "remove_drawing",
    {
      title: "Remove a Specific Drawing",
      description:
        "Remove a specific drawing from the active Yahoo Finance chart by matching its " +
        "ChartIQ type and price(s)/text (from a drawing's fingerprint or from " +
        "read_drawings). Removal is verified by re-reading the chart (robust to Yahoo's " +
        "buggy undo manager) and any matching saved/persisted copy is pruned too.",
      inputSchema: {
        type: z.string().describe('ChartIQ tool name to match, e.g. "horizontal", "segment", "callout".'),
        price: z.number().optional().describe("Primary price (v0) to match."),
        price2: z.number().optional().describe("Second price (v1) to match, for two-point tools."),
        text: z.string().optional().describe("Text to match, for callout/annotation."),
      },
    },
    async (params) => forward(await bridge.sendToExtension("remove_drawing", params)),
  );

  server.registerTool(
    "undo_drawing",
    {
      title: "Undo Last Drawing",
      description:
        "Undo the most recently added drawing on the active Yahoo Finance chart " +
        "(verified by re-reading the chart, robust to Yahoo's buggy undo manager).",
      // Zero-arg tool: no inputSchema.
    },
    async () => forward(await bridge.sendToExtension("undo_drawing", {})),
  );

  server.registerTool(
    "clear_drawings",
    {
      title: "Clear Chart Drawings",
      description:
        "Remove drawings from the active Yahoo Finance chart. By default (scope:'mine') " +
        "removes ONLY the drawings you drew via these tools, leaving the user's " +
        "hand-drawn lines untouched, and clears their saved copies. scope:'all' removes " +
        "everything including hand-drawn lines (the result reports how many were " +
        "hand-drawn). Removal is verified by re-reading the chart.",
      inputSchema: {
        scope: z
          .enum(["mine", "all"])
          .optional()
          .describe("'mine' (default) = only your drawings; 'all' = everything incl. hand-drawn."),
      },
    },
    async (params) => forward(await bridge.sendToExtension("clear_drawings", params)),
  );

  server.registerTool(
    "list_saved_drawings",
    {
      title: "List Saved Drawings",
      description:
        "List the drawings you drew that are persisted for a symbol (they auto-redraw " +
        "after a page refresh or when you reopen that symbol's chart). Defaults to the " +
        "current chart's symbol; pass symbol to list another.",
      inputSchema: {
        symbol: z.string().optional().describe("Symbol to list saved drawings for. Defaults to the current chart."),
      },
    },
    async (params) => forward(await bridge.sendToExtension("list_saved_drawings", params)),
  );

  server.registerTool(
    "delete_saved_drawing",
    {
      title: "Delete a Saved Drawing",
      description:
        "Delete one persisted drawing by its id (from list_saved_drawings or a draw " +
        "tool's saved_id) so it no longer auto-redraws on refresh. Does not remove the " +
        "currently-visible line — use remove_drawing/clear_drawings for that.",
      inputSchema: {
        id: z.string().describe("The saved drawing id to delete."),
      },
    },
    async (params) => forward(await bridge.sendToExtension("delete_saved_drawing", params)),
  );

  server.registerTool(
    "set_chart_style",
    {
      title: "Set Chart Style",
      description:
        "Switch the active Yahoo Finance chart's visual style: either chartType " +
        '("candle" | "line" | "mountain" | "bar" | "hlc" | "hollow_candle" | ' +
        '"baseline_delta" | "step") or aggregationType ("heikinashi" | "kagi" | ' +
        '"renko" | "pandf" | "rangebars" | "linebreak") — pass exactly one, not both. ' +
        "Synchronous (no data reload). Caveat: switching chartType to \"line\" resets " +
        "any active aggregationType back to plain OHLC — the result's warnings field " +
        "flags this when it happens. Read back the applied chartType/aggregationType " +
        "in the result to confirm it stuck.",
      inputSchema: {
        chartType: z
          .string()
          .optional()
          .describe(
            'Chart rendering style, e.g. "candle", "line", "mountain", "bar", "hlc", ' +
              '"hollow_candle", "baseline_delta", "step". Mutually exclusive with aggregationType.',
          ),
        aggregationType: z
          .string()
          .optional()
          .describe(
            'Bar aggregation style, e.g. "heikinashi", "kagi", "renko", "pandf", ' +
              '"rangebars", "linebreak". Mutually exclusive with chartType.',
          ),
      },
    },
    async (params) => forward(await bridge.sendToExtension("set_chart_style", params)),
  );

  server.registerTool(
    "set_periodicity",
    {
      title: "Set Chart Periodicity",
      description:
        "Change the active Yahoo Finance chart's bar periodicity (e.g. daily/weekly/" +
        "intraday). This triggers an ASYNC quotefeed reload of the chart's data — the " +
        "tool waits for it to finish (or times out) before returning, and reports " +
        "total_bars + dataset_rebuilt so you can confirm the reload really happened. " +
        'Weekly bars: pass interval:"week" with no timeUnit (the unit lives in the ' +
        'interval itself, and the engine reports timeUnit:null back). Daily: interval:1, ' +
        'timeUnit:"day". Intraday: interval:<minutes>, timeUnit:"minute".',
      inputSchema: {
        interval: z
          .union([z.string(), z.number()])
          .describe(
            'Bar interval: a number of minutes for intraday, or a string like "week"/"day". Required.',
          ),
        period: z.number().int().positive().optional().describe("Period multiplier. Optional; defaults to 1."),
        timeUnit: z
          .string()
          .optional()
          .describe(
            'Unit for a numeric interval, e.g. "minute" | "day". Omit for weekly ' +
              '(interval:"week" already carries the unit).',
          ),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Ready-wait budget for the async data reload, in ms. Optional; defaults to 10000."),
      },
    },
    async (params) => forward(await bridge.sendToExtension("set_periodicity", params)),
  );

  server.registerTool(
    "set_range",
    {
      title: "Set Chart Date Range",
      description:
        "Change how much history the active Yahoo Finance chart shows/loads — either a " +
        'relative span ("1y", "6m", "3m", "5d", "1d", "ytd", "all") or an explicit ' +
        "start/end date pair. This triggers an ASYNC quotefeed reload — the tool waits " +
        "for it to finish (or times out) before returning, and reports total_bars + " +
        "dataset_rebuilt + the resulting loaded range so you can confirm the reload " +
        "really happened. Pass either span, or both start and end — not a mix.",
      inputSchema: {
        span: z
          .string()
          .optional()
          .describe('Relative span shorthand: "1y", "6m", "3m", "5d", "1d", "ytd", or "all".'),
        start: z.string().optional().describe("Explicit range start (ISO-ish). Use together with end."),
        end: z.string().optional().describe("Explicit range end (ISO-ish). Use together with start."),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Ready-wait budget for the async data reload, in ms. Optional; defaults to 10000."),
      },
    },
    async (params) => forward(await bridge.sendToExtension("set_range", params)),
  );

  server.registerTool(
    "add_comparison",
    {
      title: "Add Comparison Series",
      description:
        "Overlay another symbol as a comparison series on the active Yahoo Finance " +
        "chart (e.g. compare AAPL vs. MSFT on the same chart). This triggers an ASYNC " +
        "quotefeed reload for the new series — the tool waits for it to finish (or " +
        "times out) before returning. Effect the user will see: adding a comparison " +
        "switches the chart's y-axis from absolute price to a PERCENT scale (all " +
        "series normalized to their starting value); removing the last comparison " +
        "restores the linear price scale. Errors with ALREADY_EXISTS if the symbol is " +
        "already overlaid.",
      inputSchema: {
        symbol: z.string().describe('Ticker symbol to overlay, e.g. "MSFT".'),
        color: colorSchema(),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Ready-wait budget for the async data reload, in ms. Optional; defaults to 10000."),
      },
    },
    async (params) => forward(await bridge.sendToExtension("add_comparison", params)),
  );

  server.registerTool(
    "remove_comparison",
    {
      title: "Remove Comparison Series",
      description:
        "Remove a comparison series previously added with add_comparison from the " +
        "active Yahoo Finance chart. Synchronous. Idempotent — removing a symbol " +
        "that isn't currently overlaid still succeeds and just reports the current " +
        "series list. Once the last comparison series is removed, the y-axis reverts " +
        "from percent scale back to linear price (reflected in the result's " +
        "percent_axis field).",
      inputSchema: {
        symbol: z.string().describe('Comparison ticker symbol to remove, e.g. "MSFT".'),
      },
    },
    async (params) => forward(await bridge.sendToExtension("remove_comparison", params)),
  );

  server.registerTool(
    "list_indicators",
    {
      title: "List Available/Active Indicators",
      description:
        "List ChartIQ's built-in technical indicators available to add (Yahoo's own " +
        "official library — RSI, MACD, Bollinger Bands, moving averages, etc.; NOT " +
        "self-computed), plus which ones are currently active on the chart. Read-only. " +
        "Call this before add_indicator/remove_indicator to get exact indicator names. " +
        "If Yahoo's bundling has changed enough that the live indicator API can't be " +
        "reached, this fails with UNSUPPORTED_CIQ_HANDLE rather than faking a list.",
      // Zero-arg tool: no inputSchema (see read_drawings for why).
    },
    async () => forward(await bridge.sendToExtension("list_indicators", {})),
  );

  server.registerTool(
    "add_indicator",
    {
      title: "Add Indicator",
      description:
        "Add one of ChartIQ's official technical indicators to the active Yahoo " +
        "Finance chart (e.g. RSI, MACD, moving average, Bollinger Bands) — rendered by " +
        "Yahoo's own live engine, not self-computed. `type` matches a library name from " +
        "list_indicators (exact or case-insensitive substring, e.g. \"rsi\", \"ma\", " +
        '"Bollinger Bands"). `inputs` are study-specific parameters, e.g. { Period: 14 }. ' +
        "Fails with BAD_REQUEST if type doesn't match any known indicator — call " +
        "list_indicators first. Fails with UNSUPPORTED_CIQ_HANDLE if the live indicator " +
        "API can't be reached.",
      inputSchema: {
        type: z.string().describe('Indicator name/key, e.g. "rsi", "ma", "Bollinger Bands". See list_indicators.'),
        inputs: z
          .record(z.any())
          .optional()
          .describe('Study-specific inputs, e.g. { "Period": 14 }. Optional — engine defaults are used otherwise.'),
        outputs: z
          .record(z.any())
          .optional()
          .describe(
            "Per-output-line style, keyed by the study's output names (see list_indicators' " +
              '`outputs` field once populated, e.g. "MA" or "Bollinger Bands Top"). Each value ' +
              'is either a color string (e.g. "#00FF00") or an object { color?, width?, pattern? }. ' +
              "Optional — this is the color/width/pattern knob for indicator lines.",
          ),
        parameters: z
          .record(z.any())
          .optional()
          .describe(
            'Study-level parameters, e.g. { "panelName": "New panel" } to force the study into ' +
              "its own panel, or oscillator zone settings. Optional.",
          ),
      },
    },
    async (params) => forward(await bridge.sendToExtension("add_indicator", params)),
  );

  server.registerTool(
    "remove_indicator",
    {
      title: "Remove Indicator",
      description:
        "Remove an active indicator from the active Yahoo Finance chart, matched by " +
        "type or name (exact type match, or case-insensitive substring match on name) " +
        "against the `active` list from list_indicators. Fails with BAD_REQUEST if " +
        "nothing active matches.",
      inputSchema: {
        type: z.string().describe('Active indicator\'s type or name to match, e.g. "rsi". See list_indicators.'),
      },
    },
    async (params) => forward(await bridge.sendToExtension("remove_indicator", params)),
  );

  server.registerTool(
    "get_corporate_events",
    {
      title: "Get Corporate Events (Dividends/Splits)",
      description:
        "Read dividend and split events from the active Yahoo Finance chart's loaded " +
        "history. Read-only. Returns a CSV block ('date,type,value', one row per " +
        "event). Note: this data only populates in DAILY-OR-LARGER periodicity views " +
        "(intraday has none) — call set_periodicity first if count comes back 0. To mark " +
        "one of these events directly on the chart, use draw_callout.",
      // Zero-arg tool: no inputSchema.
    },
    async () => forward(await bridge.sendToExtension("get_corporate_events", {})),
  );

  server.registerTool(
    "toggle_corporate_events",
    {
      title: "Toggle Corporate Events Display",
      description:
        "Best-effort: click Yahoo's own toolbar control for showing corporate-event " +
        "markers (dividends/splits) directly on the chart. This is a UI toggle, not a " +
        "data read — use get_corporate_events to actually read the events. Fails with " +
        "UNSUPPORTED if Yahoo's current layout doesn't expose such a control.",
      // Zero-arg tool: no inputSchema.
    },
    async () => forward(await bridge.sendToExtension("toggle_corporate_events", {})),
  );
}

// --- shared zod fragments for the drawing tools ----------------------------

function colorSchema() {
  return z.string().optional().describe('Line color as a CSS hex/name string, e.g. "#FF3B30". Optional.');
}
function fillColorSchema() {
  return z.string().optional().describe('Fill color for the shape. Optional; the engine derives one if omitted.');
}
function lineWidthSchema() {
  return z.number().positive().optional().describe("Line width in pixels. Optional; defaults to 1.");
}
function twoPointSchema() {
  return {
    date1: z.string().describe("Date for point 1 (ISO-ish, e.g. from get_chart_data). Snapped to nearest bar."),
    price1: z.number().describe("Price (y-axis value) for point 1."),
    date2: z.string().describe("Date for point 2 (ISO-ish). Snapped to nearest bar."),
    price2: z.number().describe("Price (y-axis value) for point 2."),
    color: colorSchema(),
    line_width: lineWidthSchema(),
  };
}
function patternSchema() {
  return z.string().optional().describe('Line pattern: "solid" | "dashed" | "dotted". Optional; defaults to solid.');
}
function axisLabelSchema() {
  return z
    .boolean()
    .optional()
    .describe(
      "Show the value/date tag on the axis for this drawing. Optional; defaults to off. " +
        "Guide: prefer this over a text label for a pure price level (native badge, zero " +
        "canvas ink); max 2 per chart, decision levels only.",
    );
}
function spanPanelsSchema() {
  return z
    .boolean()
    .optional()
    .describe(
      "Draw the line across all stacked panels (price + study panels) instead of just its " +
        "own panel. Optional; defaults to false.",
    );
}
function fillOpacitySchema() {
  return z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Fill opacity from 0 (transparent) to 1 (opaque), baked into fill_color as an rgba " +
        "alpha (ChartIQ has no separate opacity field). Only meaningful together with fill_color. " +
        "Guide budget: 0.10 zones/rectangles, 0.08 channels & large shapes, 0.15 max.",
    );
}
function fontSizeSchema() {
  return z
    .number()
    .positive()
    .optional()
    .describe(
      'Font size in pixels — a NUMBER (e.g. 14), not a CSS string like "14px". Optional. ' +
        "Guide default: 11 (12 for a single headline label).",
    );
}
function fontWeightSchema() {
  return z.string().optional().describe('Font weight, e.g. "normal" | "bold". Optional.');
}
function fontStyleSchema() {
  return z.string().optional().describe('Font style, e.g. "normal" | "italic". Optional.');
}
function fontFamilySchema() {
  return z.string().optional().describe('Font family, e.g. "Arial". Optional.');
}
function dateRangeSchema() {
  return {
    date1: z.string().describe("Range start date (ISO-ish, e.g. from get_chart_data). Snapped to nearest bar."),
    date2: z.string().describe("Range end date (ISO-ish). Snapped to nearest bar."),
  };
}
function bandsSchema() {
  return z
    .array(
      z.object({
        enabled: z.boolean().optional().describe("Whether this band is shown. Optional; defaults to true."),
        color: colorSchema(),
        line_width: lineWidthSchema(),
        pattern: z
          .string()
          .optional()
          .describe('Band line pattern: "solid" | "dashed" | "dotted". Optional; defaults to dotted for bands.'),
      }),
    )
    .max(3)
    .optional()
    .describe(
      "Up to 3 standard-deviation band channels around the fit line, in order (entry 0 = " +
        "band 1, entry 1 = band 2, entry 2 = band 3). Each entry is independently optional; " +
        "omit `bands` entirely for no bands. Pattern defaults to dotted for bands. " +
        "Guide: prefer ONE band, dotted, same (purple) hue as the line.",
    );
}
function fibStyleSchema() {
  return {
    line_width: lineWidthSchema(),
    pattern: patternSchema(),
    fill_color: z
      .string()
      .optional()
      .describe(
        "Fill color for the level bands. Optional. Guide: prefer \"transparent\" — the " +
          "engine's default wash buries the candles.",
      ),
    fill_opacity: fillOpacitySchema(),
    levels: z
      .array(z.number())
      .optional()
      .describe(
        "Which Fibonacci levels to show, as FRACTIONS (0.618, 1.272, -0.786 — not percent). " +
          "Optional; defaults to ChartIQ's standard on-set " +
          "[-0.618, -0.382, 0, 0.382, 0.5, 0.618, 1, 1.382, 1.618]. Guide: for a clean read " +
          "prefer [0, 0.382, 0.5, 0.618, 1]; add 1.272/1.618 only when projecting targets.",
      ),
    level_color: z
      .string()
      .optional()
      .describe("Color for the level lines as a CSS hex/name string. Optional; defaults to auto."),
    show_labels: z
      .boolean()
      .optional()
      .describe('Show the level % labels (e.g. "61.8%"). Optional; defaults to true.'),
    show_prices: z
      .boolean()
      .optional()
      .describe("Show the price value at each level. Optional; defaults to false."),
    extend_left: z
      .boolean()
      .optional()
      .describe("Extend the level lines to the left of the anchor points. Optional; defaults to false."),
  };
}
