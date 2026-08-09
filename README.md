# Free & Awesome A-Share Market Ops

Free & Awesome A-Share Market Ops is an open-source desktop application for monitoring the Chinese A-share market intraday and reviewing market structure after the close. It uses native HTML, CSS, JavaScript, and Node.js. The Windows edition runs through a local service and Microsoft Edge WebView2.

Current open-source version: `2.21.9`.

## Features

- A persistent, searchable 19-index catalog with up to eight user-selected real intraday charts in an automatic count-aware grid
- Word-style 70%-130% page zoom and four persistent global font-size choices
- A six-slot custom workspace for real secondary-industry and thematic-concept index charts, with persistent concept-flow labels at confirmed major turns, full-session trade samples, and one-second live quote polling
- Automatically refreshed index contribution rankings from public constituent weights and live quotes, with no stock-software process required
- Atomic one-second capital-flow snapshots for secondary industries and concept sectors from the 09:15 call auction through the close
- Separate top-ten inflow and outflow panels for secondary industries and concept sectors, each with its own intraday chart, amount bar, and amount/percentage scale
- Second-level intraday timestamps, manual market synchronization, and strict lunch/close freezing without synthetic extrapolation
- Limit-up, limit-down, previous-day continuation, and failed-breakout recovery analysis
- Market structure, breadth, trading effectiveness, and historical session comparisons
- Policy news, upcoming events, institutional positioning, historical replay, and stock search
- A real-time thematic-topic handbook with rankings, evidence-based interpretation, constituent maps, and on-demand verified company-to-topic profiles from public F10 records
- Automatic discovery of the current device's installed market application for stock and sector daily-chart actions
- The Windows Self edition pins daily-chart actions to Tongdaxin, while Member and Basic retain verified automatic application discovery
- In-application policy, news, and event details without opening third-party market pages
- Responsive Android/iOS PWA packages with remembered trading-app deep-link preferences
- Local data services, historical caching, and Windows desktop packaging
- In-application GitHub update checks with verified download, SHA-256 validation, replacement, and automatic restart for the distributed Member edition

## Open Source

The source code is released under the [GNU AGPL v3](LICENSE). You may inspect, modify, and redistribute it in compliance with the license.

- `app/` contains the frontend, local services, and data-processing code.
- `windows-launcher/` contains the Windows single-file launcher source.
- `scripts/` contains syntax checks, public-source audits, and verified Windows packaging tools.
- `tests/` covers local-service security, market-session timing, real-snapshot fallback behavior, and health-state semantics.
- Data under `app/data/` is provided for development and format compatibility only. It is not guaranteed to be complete or real-time.
- Private keys, access tokens, and production credentials are not included.

See [Open-Source Scope](docs/open-source-scope.md) for details.

## Run Locally

Node.js 20 or later is required:

```powershell
npm start
```

Open the application at:

```text
http://127.0.0.1:18765/app/
```

Run the public-source checks:

```powershell
npm test
```

See [Build and Run](docs/build-and-run.md) for complete instructions.
See [Member Edition GitHub Updates](docs/member-github-updates.md) for the verified self-update release contract.

## License

Program code is released under the [GNU AGPL v3](LICENSE). Branding, data files, and third-party assets may be subject to separate terms described in [NOTICE](NOTICE.md).

## Disclaimer

This project is intended for market-data organization and review. It does not provide investment advice. Users are responsible for validating data and making independent trading decisions.
