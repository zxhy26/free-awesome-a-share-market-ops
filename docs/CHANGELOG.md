# Changelog

## 2.17.6 - 2026-07-29

- Restored stock and sector daily-chart actions to the current device's installed market application instead of rendering a first-party daily chart.
- Re-enabled Windows discovery across running processes, prior successful choices, App Paths, uninstall registry entries, Start Menu shortcuts, and common installation folders.
- Added verified multi-candidate failover so an unlogged or unavailable first application is skipped and the next detected trading application is tried automatically.
- Pinned the Windows Self edition to Tongdaxin while leaving Member and Basic on automatic per-device discovery.
- Removed Eastmoney webpage fallback; a failed discovery now reports the missing or unready local application without opening a browser page.
- Added Android/iOS trading-app deep links with a remembered per-device preference and removed the mobile in-application market-detail page.
- Kept policy, news, event, and other text-oriented details inside the application.

## 2.17.5 - 2026-07-29

- Replaced Eastmoney-page and local-stock-application jumps with first-party stock, sector, policy, news, and event detail pages.
- Added a loopback market-detail endpoint so the Windows editions can retrieve real quotes and adjusted daily K-line history without weakening the desktop content-security policy.
- Added responsive Android/iOS PWA builds with internal navigation and real-time data refresh behavior shared with the Windows editions.
- Preserved edition boundaries: Member has no quantitative assets, Basic includes quantitative selection without activation administration, and Self includes the complete private administration toolset.
- Added regression coverage for internal navigation, market-detail target normalization, live public-data retrieval, mobile package structure, and horizontal-overflow protection.

## 2.17.4 - 2026-07-28

- Fixed quantitative-only refreshes so completed full-A scans are written to the application data endpoint without requiring a legacy market-page snapshot.
- Preserved the latest quantitative result during regular market refreshes in Basic and Self editions.
- Reused automatically discovered local Tongdaxin daily data during scheduled full-market refreshes, not only manual quantitative refreshes.
- Kept the previous valid candidate set when a replacement scan has materially incomplete daily-history coverage.
- Removed stale quantitative data from Member payloads that do not include the quantitative page.
- Added regression coverage for quantitative export, edition boundaries, and completion reporting.

## 2.12.1 - 2026-07-27

- Fixed trading-session detection to always use Asia/Shanghai time regardless of the device or CI runner time zone.
- Preserved exact lunch and close boundaries for users running the application outside China.

## 2.12.0 - 2026-07-27

- Added atomic one-second official-source snapshots for secondary-industry and concept-sector capital flows.
- Preserved manual synchronization while separating the lightweight live channel from the complete review-data refresh.
- Added source time, fetch latency, source latency, and connection-state indicators to the main dashboard.
- Stopped live requests immediately after the morning and afternoon closing seconds and prohibited synthetic fund-flow extrapolation.
- Added one-second refresh, lunch freeze, close freeze, and atomic failure-retention tests.

## 2.11.0 - 2026-07-27

- Added verified Basic-edition packaging for a complete quantitative stock-selection payload.
- Restricted activation-code generation, issuer history, administration assets, and the signing private key to the Self edition.
- Added explicit Member, Basic, and Self runtime identities plus packaging-time edition-boundary checks.
- Made launcher extraction reliable when the Windows temporary directory and application runtime directory are on different drives.

## 2.10.0 - 2026-07-27

- Added automatic reconciliation for secondary-industry and concept-sector capital flows after every refresh.
- Corrected only the latest real ranking sample when the official minute-series endpoint differs, without rewriting earlier intraday history.
- Added correction counts and before/after audit details to the local flow cache and data-health report.
- Added startup integrity repair when a sector dataset has not completed reconciliation.

## 2.9.0 - 2026-07-27

- Added a device-bound custom permanent membership plan priced at CNY 1,599.
- Added explicit permanent-license signing and verification semantics instead of simulating permanence with a distant expiry date.
- Added permanent membership status rendering and preserved compatibility with existing monthly and annual activation codes.
- Added an end-to-end unit test covering permanent activation generation, signature verification, and member status.

## 2.8.0 - 2026-07-27

- Added a timeline-linked Index Contribution section to the main dashboard.
- Added index switching for seven A-share benchmarks, with separate leading and dragging industry attribution lists.
- Displayed turning-point time, confirmation time, cumulative flow, confirmation-window change, and attribution confidence.
- Kept attribution methodology explicit: real index turning points matched to contemporaneous secondary-industry flows, not fabricated constituent-weight point contributions.

## 2.7.0 - 2026-07-27

- Removed the synthetic pre-close-to-snapshot index fallback. A failed minute endpoint now produces one explicitly marked real snapshot.
- Restricted the local HTTP service to loopback hosts and same-origin browser writes; refresh and local stock-launch actions now require POST.
- Added pending semantics for CFFEX rankings before the normal publication window.
- Added absolute and normalized views for ten-line sector fund-flow charts.
- Added explicit 30-session history accumulation status and policy event-chain completeness checks.
- Added independent unit tests, audited release packaging, payload SHA256 validation, and tag-driven GitHub source releases.
- Replaced the duplicate next-week updater implementation with a compatibility wrapper.
