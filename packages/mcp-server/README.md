# tratto-mcp-server

Local MCP server for [Tratto](https://github.com/Taoo425/tratto) — draw
technical-analysis lines (support/resistance, trendlines, Fibonacci
retracements) directly on Yahoo Finance's native chart via an AI coding agent.
Fully local, no cloud, no bundled chart library.

## Install

Register it with any MCP-speaking coding agent (e.g. Claude Code). `npx` fetches
and runs it — no local path needed:

```
claude mcp add tratto -- npx -y tratto-mcp-server
```

The server is a stdio MCP server that also opens a WebSocket on `127.0.0.1:8787`.
It needs the **Tratto Chrome extension**, which bridges it to the Yahoo Finance
page. See the repository for extension setup and usage:
<https://github.com/Taoo425/tratto>

## Tools

- `get_drawing_guide` — Tratto's drawing design system (palette, weights, budget, composition rules).
- `get_chart_data` — read the OHLCV bars currently on the chart.
- `draw_support` — horizontal support/resistance line at a price.
- `draw_trendline` — straight trendline between two (date, price) points.
- `draw_fib` — Fibonacci retracement between two anchor points.
- `read_drawings` — list the drawings currently on the chart.
- `clear_drawings` — remove drawings from the chart.

## License

MIT © [Taoo425](https://github.com/Taoo425)
