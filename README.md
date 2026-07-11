<div align="center">

# Tratto

### Yahoo left a charting engine on the page. Tratto hands your AI the pen.

[![npm](https://img.shields.io/npm/v/tratto-mcp-server?logo=npm&label=tratto-mcp-server&color=cb3837)](https://www.npmjs.com/package/tratto-mcp-server)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](#)
![MCP](https://img.shields.io/badge/MCP-server-000000)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![local](https://img.shields.io/badge/100%25-local-2ea44f)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

> **tratto** · *Italian* — a stroke; a line drawn in one movement.

Tratto lets your AI draw technical-analysis markup — support/resistance, trendlines, Fibonacci — **directly onto Yahoo Finance's own chart**. Not a screenshot. Not a new widget. The real chart already on the page.

<div align="center">

**1 bridge · 0 chart libraries · 30 MCP tools · 100% local**

</div>

---

## The trick

Open any Yahoo Finance chart, open DevTools, and run:

```js
document.querySelector('.chartContainer').stx
```

That's a **live ChartIQ engine** — the commercial engine behind many brokerage platforms — sitting on the page with its full public drawing API exposed. Tratto is the bridge that lets your coding agent pick it up:

- 🩹 **Borrows everything** — the chart, the OHLC data, and the drawing tools are all already on the page.
- 🧼 **Owns nothing** — no scraping, no bundled chart library, no cloud, no account.
- ✍️ **Native strokes** — the AI's lines are drawn by the same engine as yours, pixel-identical to hand-drawn.

## What it feels like

You're staring at NVDA after earnings, wondering where support is. You ask your AI — and get three paragraphs of prose. You wanted a *line on the chart*.

```text
you › mark the key support and resistance
  ai › ✎ drew 2 levels — support $172.30, resistance $195.80
you › draw the fib from the March low to the June high
  ai › ✎ Fibonacci retracement placed (0 → 100%)
```

<!-- 👉 Highest-impact upgrade: drop a demo GIF here — an agent prompt, then the line appearing on a live Yahoo chart. -->

**Reach for Tratto when:**

- You already read charts on Yahoo Finance and already live in Claude Code / Codex — it's the missing wire between them.
- You want *"where did this trend break?"* answered as a drawn line, not a paragraph.
- You want the AI to **read your chart** too — `read_drawings` sees your hand-drawn markup, so it critiques *your* chart, not a copy of it.

## Quick start

**Prerequisites:** Node.js · Google Chrome

**1 — Register the MCP server** with your coding agent. `npx` fetches it; nothing to install:

```bash
# Claude Code
claude mcp add tratto -- npx -y tratto-mcp-server

# Codex
codex mcp add tratto -- npx -y tratto-mcp-server
```

**2 — Install the Chrome extension** (it bridges the server to the page):

```bash
git clone https://github.com/Taoo425/tratto && cd tratto
npm install && npm run build
```

Then in Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `packages/extension/dist`.

**3 — Draw.** Open a chart (`finance.yahoo.com/chart/NVDA`, or the embedded `/quote/NVDA/chart`) and ask your agent in plain language.

## The tools

30 MCP tools. The AI reads the chart, draws on it, and manages what's there — all on Yahoo's native ChartIQ engine.

| | Tools | On the Yahoo / ChartIQ chart |
|---|---|---|
| 👁 **Read** | `get_chart_data` · `get_chart_summary` · `read_drawings` · `get_capabilities` · `list_indicators` · `get_corporate_events` | Live OHLC bars, existing drawings (including your own), engine capabilities, active studies, dividends & splits |
| ✍️ **Draw** | `draw_support` · `draw_trendline` · `draw_fib` · `draw_ray` · `draw_rectangle` · `draw_channel` · `draw_vertical` · `draw_callout` · `draw_raw` | Support/resistance, trendlines, Fibonacci, rays, rectangles, parallel channels, vertical markers, text callouts — plus a raw escape hatch to any ChartIQ tool |
| 🗂 **Manage** | `remove_drawing` · `undo_drawing` · `clear_drawings` · `list_saved_drawings` · `delete_saved_drawing` | Remove one, undo the last, clear all; list or delete the drawings Tratto remembers |
| 🎛 **View** | `open_chart` · `set_chart_style` · `set_periodicity` · `set_range` · `add_comparison` · `remove_comparison` · `toggle_corporate_events` | Jump to a symbol, switch candle / line / bar, change timeframe & range, overlay comparison symbols, toggle event markers |
| 📊 **Indicators** | `add_indicator` · `remove_indicator` | Add or remove ChartIQ studies — RSI, MACD, Bollinger Bands, moving averages… |
| 🎨 **Guide** | `get_drawing_guide` | Tratto's built-in design system (palette, weights, budget) so the AI draws clean, readable markup — not clutter |

> **The design guide travels with the tools.** LLMs don't know ChartIQ's 30+ drawing tools or how to keep a chart readable — so Tratto ships its own design system *inside the MCP server*. Any MCP-speaking agent gets it with zero extra install.

## How it works

```
Claude Code / Codex  ──MCP (stdio)──►  local MCP server  ──WebSocket──►  Chrome extension  ──►  .chartContainer.stx
   (your words)                        (127.0.0.1:8787)                  (on the Yahoo page)       (ChartIQ engine)
```

Everything runs on your machine. A shared-token handshake over a `127.0.0.1`-only socket keeps it local.

## Good to know

- **Yahoo won't save AI-drawn lines** — they'd vanish on refresh. So Tratto **remembers them itself** and re-draws them when you come back.
- **Yahoo redesigns are our weather.** The mount point is ChartIQ-standard, but when it drifts, that's the #1 place to contribute — a selector fix or a fresh recipe keeps Tratto alive.
- **It only draws.** No trading, no orders, no moving money — ever.

## Design philosophy

Tratto is **parasitic enhancement**: instead of rebuilding the chart, it drives the one already there. Minimal code, maximally native, cleanest possible footprint. The chart, the data, and the pen were all on the page — Tratto just taught your AI to reach them.

## Disclaimer

Personal, non-commercial, educational tool. It drives Yahoo Finance's own on-page engine — it does not scrape, redistribute, or store market data, and adds no trading capability. Because it depends on Yahoo's page structure, a redesign may break it until the mount point is updated. Use of Yahoo Finance is subject to [Yahoo's Terms of Service](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html). Provided "as is", without warranty of any kind.

## License

[MIT](LICENSE) © [Taoo425](https://github.com/Taoo425)
