# Free & Awesome A-Share Market Ops

Free & Awesome A-Share Market Ops is an open-source desktop application for monitoring the Chinese A-share market intraday and reviewing market structure after the close. It uses native HTML, CSS, JavaScript, and Node.js. The Windows edition runs through a local service and Microsoft Edge WebView2.

Current open-source version: `2.13.0`.

## Features

- Intraday charts for major indices, turnover, and sector-driven turning points
- Timeline-linked index contribution analysis using confirmed turning points and secondary-industry capital flows
- Atomic one-second capital-flow snapshots for secondary industries and concept sectors during A-share trading sessions
- Simultaneous top-ten inflow and outflow rankings with signed intraday flow charts and amount/percentage scales
- Manual market synchronization, source timestamps, and strict lunch/close freezing without synthetic extrapolation
- Limit-up, limit-down, previous-day continuation, and failed-breakout recovery analysis
- Market structure, breadth, trading effectiveness, and historical session comparisons
- Policy news, upcoming events, institutional positioning, historical replay, and stock search
- Local data services, historical caching, and Windows desktop packaging

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

## License

Program code is released under the [GNU AGPL v3](LICENSE). Branding, data files, and third-party assets may be subject to separate terms described in [NOTICE](NOTICE.md).

## Disclaimer

This project is intended for market-data organization and review. It does not provide investment advice. Users are responsible for validating data and making independent trading decisions.
