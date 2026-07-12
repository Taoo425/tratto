<div align="center">

# Tratto

### The chart already has a drawing engine. Tratto hands your AI the pen.

[![npm](https://img.shields.io/npm/v/tratto-mcp-server?logo=npm&label=tratto-mcp-server&color=cb3837)](https://www.npmjs.com/package/tratto-mcp-server)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](#)
![MCP](https://img.shields.io/badge/MCP-server-000000)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![local](https://img.shields.io/badge/100%25-local-2ea44f)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

> **tratto** · *Italian* for a stroke, a line drawn in one movement.

Tratto lets your AI draw technical-analysis markup (support and resistance, trendlines, Fibonacci) straight onto the Yahoo Finance chart you're already looking at. It isn't a screenshot, and it isn't a second chart bolted on top. It's the real chart on the page.

<div align="center">

**1 bridge · 0 chart libraries · 50 MCP tools · 100% local**

</div>

---

## The trick

Open any Yahoo Finance chart, open DevTools, and run:

```js
document.querySelector('.chartContainer').stx
```

That's a live charting engine, the same one rendering the page you're on, sitting there with its full public drawing API exposed. Tratto is the thin bridge that lets your coding agent pick up that pen:

- **It borrows what's already there.** The chart, the OHLC data, and the drawing tools all ship with the page.
- **It owns nothing.** No scraping, no bundled chart library, no cloud, no account.
- **The strokes are native.** The AI's lines come out of the same engine that draws yours, so they look identical to hand-drawn markup.

## What it feels like

You're staring at NVDA after earnings, wondering where support is. You ask your AI, and back come three paragraphs of prose. But you wanted a *line on the chart*.

```text
you › mark the key support and resistance
  ai › ✎ drew 2 levels — support $172.30, resistance $195.80
you › draw the fib from the March low to the June high
  ai › ✎ Fibonacci retracement placed (0 → 100%)
```

<div align="center">

<video src="https://raw.githubusercontent.com/Taoo425/tratto/main/assets/demo.mp4" controls muted playsinline width="720"></video>

</div>

**Reach for Tratto when:**

- You already read charts on Yahoo Finance and already live in Claude Code or Codex. Tratto is the missing wire between them.
- You want *"where did this trend break?"* answered as a drawn line, not a paragraph.
- You want the AI to **read your chart** too. `read_drawings` sees your own hand-drawn markup, so it critiques *your* chart instead of a copy of it.

## Quick start

**Prerequisites:** Node.js and Google Chrome.

**1. Register the MCP server** with your coding agent. `npx` fetches it, so there's nothing to install:

```bash
# Claude Code
claude mcp add tratto -- npx -y tratto-mcp-server

# Codex
codex mcp add tratto -- npx -y tratto-mcp-server
```

**2. Install the Chrome extension** (it bridges the server to the page):

```bash
git clone https://github.com/Taoo425/tratto && cd tratto
npm install && npm run build
```

Then in Chrome go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `packages/extension/dist`.

**3. Draw.** Open a chart (`finance.yahoo.com/chart/NVDA`, or the embedded `/quote/NVDA/chart`) and ask your agent in plain language.

## The tools

50 MCP tools. The AI reads the chart, draws on it, styles what it draws, and manages what's there.

| | Tools | On the chart |
|---|---|---|
| 👁 **Read** | `get_chart_data` · `get_chart_summary` · `read_drawings` · `get_capabilities` · `list_indicators` · `get_corporate_events` | Live OHLC bars, existing drawings (including your own), engine capabilities, active studies, dividends and splits |
| ✍️ **Draw** | `draw_support` · `draw_trendline` · `draw_ray` · `draw_line` · `draw_crossline` · `draw_arrow` · `draw_vertical` · `draw_channel` · `draw_rectangle` · `draw_ellipse` · `draw_callout` · `draw_raw` | Support and resistance, trendlines, rays, rectangles, ellipses, parallel channels, vertical markers, text callouts, plus a raw escape hatch to any tool the engine has |
| 📐 **Fibonacci** | `draw_fib` · `draw_fib_arc` · `draw_fib_fan` · `draw_fib_projection` · `draw_fib_timezone` | The full Fib family: retracement, arcs, fan, projection, and time zones, with per-level selection and styling |
| 🧮 **Analytical** | `draw_pitchfork` · `draw_gann_fan` · `draw_gartley` · `draw_speed_arc` · `draw_speed_line` · `draw_time_cycle` · `draw_measurement` · `draw_volume_profile` · `draw_quadrant_lines` · `draw_tirone_levels` · `draw_average_line` · `draw_regression_line` | Pitchforks, Gann fans, harmonic patterns, speed resistance, volume profile, regression and average lines with standard-deviation bands |
| 🗂 **Manage** | `remove_drawing` · `undo_drawing` · `clear_drawings` · `list_saved_drawings` · `delete_saved_drawing` | Remove one, undo the last, clear all, and list or delete the drawings Tratto remembers |
| 🎛 **View** | `open_chart` · `set_chart_style` · `set_periodicity` · `set_range` · `add_comparison` · `remove_comparison` · `toggle_corporate_events` | Jump to a symbol, switch candle, line, or bar, change timeframe and range, overlay comparison symbols, toggle event markers |
| 📊 **Indicators** | `add_indicator` · `remove_indicator` | Add or remove studies (RSI, MACD, Bollinger Bands, moving averages) with per-line color, width, and parameters |
| 🎨 **Guide** | `get_drawing_guide` | Tratto's built-in design system (palette, weights, budget) so the AI draws clean, readable markup instead of clutter |

> **The design guide travels with the tools.** An LLM doesn't know the chart engine's 30-plus drawing tools, or how to keep a chart readable, so Tratto ships its own design system *inside the MCP server*. Any MCP-speaking agent gets it with zero extra install, loaded once and progressively as needed to stay token-cheap.

## How it works

```
Claude Code / Codex  ──MCP (stdio)──►  local MCP server  ──WebSocket──►  Chrome extension  ──►  .chartContainer.stx
   (your words)                        (127.0.0.1:8787)                  (on the page)             (charting engine)
```

Everything runs on your machine. A shared-token handshake over a `127.0.0.1`-only socket keeps it that way.

## Good to know

- **The page won't save AI-drawn lines,** so they'd vanish on refresh. Tratto remembers them itself and redraws them when you come back, storing the semantics (price, date, text) and recomputing the anchors against the current data.
- **Front-end redesigns are our weather.** The mount point is a standard one, but when it drifts, that's the number-one place to contribute: a selector fix or a fresh recipe keeps Tratto alive.
- **It only draws.** No trading, no orders, no moving money, ever.

## Design philosophy

Tratto is parasitic enhancement. Instead of rebuilding the chart, it drives the one already there: minimal code, maximally native, cleanest possible footprint. The chart, the data, and the pen were all sitting on the page. Tratto just taught your AI to reach them.

## Disclaimer

Personal, non-commercial, educational tool. It uses the chart's own on-page drawing engine. It does not scrape, redistribute, or store market data, and it adds no trading capability. Because it depends on the page structure it runs against, a redesign may break it until the mount point is updated. Use of Yahoo Finance is subject to [Yahoo's Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html). Provided "as is", without warranty of any kind.

## License

[MIT](LICENSE) © [Taoo425](https://github.com/Taoo425)
</content>
</invoke>
