# tratto-mcp-server

Local MCP server for [Tratto](https://github.com/Taoo425/tratto). It lets an AI coding agent draw technical-analysis markup (support and resistance, trendlines, Fibonacci, and more) onto a finance chart already open in your browser, using the page's own drawing engine. Fully local, no cloud, no bundled chart library.

Personal, non-commercial, educational tool. It only draws: no trading, no orders, no moving money.

## Install

Register it with any MCP-speaking coding agent (for example, Claude Code). `npx` fetches and runs it, so there's no local path to set up:

```
claude mcp add tratto -- npx -y tratto-mcp-server
```

The server speaks MCP over stdio and also opens a WebSocket on `127.0.0.1:8787`. It needs the **Tratto Chrome extension**, which bridges it to the page. See the repository for extension setup and usage:
<https://github.com/Taoo425/tratto>

## Tools

50 tools in all. A few of the core ones:

- `get_drawing_guide`: Tratto's drawing design system (palette, weights, budget, composition rules).
- `get_chart_data`: read the OHLCV bars currently on the chart.
- `read_drawings`: list the drawings currently on the chart, including hand-drawn ones.
- `draw_support`: horizontal support or resistance line at a price.
- `draw_trendline`: straight trendline between two (date, price) points.
- `draw_fib`: Fibonacci retracement between two anchor points.
- `clear_drawings`: remove drawings from the chart.

The rest cover the full Fibonacci family, analytical tools (pitchfork, Gann, harmonic patterns, regression), indicators, view controls, and drawing management. See the repository for the complete list.

## License

MIT © [Taoo425](https://github.com/Taoo425)
</content>
