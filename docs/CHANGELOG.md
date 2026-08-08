# Changelog

## 2.21.6 - 2026-08-08

- Rebind every Windows background synchronization task to the current extracted runtime whenever a new launcher version starts.
- Stop only stale review-service processes that still point at an older runtime before starting the current hidden service.
- Register the quantitative after-close task only in editions that contain the quantitative runner, and remove a stale quantitative task from editions that do not.

## 2.21.5 - 2026-08-04

- Cross-check the limit-down topic pool against a complete same-session all-A quote snapshot, so an erroneous provider total of zero cannot hide validated limit-down stocks.
- Rebuild recent comparison rows from structured daily archives and verify historical limit-up and limit-down counts against local Tongdaxin daily bars when available.
- Show up to ten real recent trading days without dropping a day solely because a topic endpoint returned two zero counts.
- Merge missing history from every prior Windows runtime during upgrades and preserve the historical statistics cache.

## 2.21.1 - 2026-08-03

- Shared the main-page zoom and font-size preferences with every independent toolbar and market-detail page.
- Added live cross-page display synchronization through browser storage and a local broadcast channel.
- Routed fixed page-specific font sizes through the global font scale so policy news, history, stock search, quantitative selection, member administration, and custom shortline pages all follow the selected size.
- Added edition-package injection and regression coverage so retained private pages cannot miss the display synchronizer.

## 2.21.0 - 2026-08-02

- Added a native macOS WebKit desktop launcher with one universal binary for Apple Silicon and Intel Macs.
- Replaced PowerShell-only refresh entry points on macOS with the same Node market, policy-news, derivatives, and quantitative engines used by Windows.
- Added macOS trading-application discovery that selects one locally installed app by actual usage history and navigates through the system accessibility adapter.
- Stored mutable runtime data under macOS Application Support and removed older runtime copies only after the new local service passes its health check.
- Added verified cross-platform packages containing matching Windows and macOS editions while preserving member, basic, personal, and custom feature boundaries.

## 2.20.1 - 2026-08-02

- Standardized the launcher filename for every desktop edition and migrate legacy aliases on startup.
- Removed same-edition `.previous.exe`, versioned download, and obsolete alias files after the replacement hash and process launch checks succeed.
- Kept rollback only on a failed replacement or failed launcher start; a completed update no longer retains a hidden old executable.
- Preserved strict edition boundaries so cleanup for one product never deletes another desktop edition.

## 2.20.0 - 2026-08-02

- Added a one-time three-day membership trial button to the top-right desktop toolbar of the Member edition.
- Bound trial eligibility and expiry to the local device state instead of browser storage, preserving the consumed state across restarts and application updates.
- Reused the existing clock-rollback protection and membership access checks so protected pages and APIs unlock immediately and relock at expiry.
- Kept the trial control out of the Basic, Personal, Custom, and mobile builds.

## 2.19.5 - 2026-08-01

- Changed Windows daily-K navigation to select exactly one locally installed trading application.
- Ranked detected applications by Windows launch and switching usage records, with running state and prior success used only as tie-breakers or fallbacks.
- Removed the personal-edition Tongdaxin lock so every desktop edition follows the current device's own usage preference.
- Stopped sequential fallback launches after a navigation failure, preventing one click from opening multiple trading applications.

## 2.19.4 - 2026-08-01

- Rebuilt the latest 15 trading-day archives from the richest verified snapshots retained across prior local releases.
- Restored missing or lower-sample archives for July 24, 27, 28, 30, and 31 without generating synthetic historical points.
- Added module-level archive quality comparison so a later low-sample refresh cannot overwrite a more complete same-day snapshot.
- Marked unrecoverable historical minute-flow gaps explicitly instead of presenting interpolated or fabricated data as captured history.

## 2.19.3 - 2026-08-01

- Restricted CLS intraday annotations to official plate events and excluded all stock-detail anchors at both ingestion and rendering boundaries.
- Added durable desktop preferences for selected indices, selected industry/concept boards, global font size, and page zoom.
- Migrated existing browser preferences into the preserved desktop settings file and flushes changes when the app is hidden or closed.

## 2.19.2 - 2026-07-31

- Replaced locally inferred index turning-point labels with original event names, timestamps, and directions from the public CLS market-live feed.
- Positioned CLS events on each domestic index timeline without generating causal explanations, confidence scores, or sector-flow attribution text.
- Retained only same-trading-day CLS events during a temporary source outage; otherwise the chart shows no annotation substitute.
- Added second-precision session mapping, source-state metadata, and regression coverage for the CLS annotation contract.

## 2.19.1 - 2026-07-31

- Made the main index workspace reflow automatically from one through eight selected indices.
- Arranged two indices side by side, four as a two-by-two grid, six as three-by-two, and eight as four-by-two.
- Removed empty reserved rows when fewer indices are selected and retained a narrow-screen layout capped at two readable columns.
- Added regression coverage for each layout mapping and refreshed desktop and mobile offline caches.

## 2.19.0 - 2026-07-30

- Replaced the fixed eight-index dashboard with a persistent, searchable catalog of 19 Shanghai, Shenzhen, CSI, Beijing, and Nasdaq indices.
- Kept the major-index area capped at eight charts and preserved the stable four-by-two desktop layout.
- Added on-demand real minute timelines for newly selected indices and appended each domestic index from the same live quote snapshot used by the dashboard.
- Added Word-style page zoom from 70% to 130% with a one-click 100% reset.
- Added four persistent global font-size choices and made chart labels, controls, metrics, tables, dialogs, and membership text follow the selected size.
- Added offline caching and regression coverage for the new display controls, index catalog, timeline parser, selection persistence, and API boundaries.

## 2.18.0 - 2026-07-30

- Added an in-application GitHub update button to the distributed Member edition.
- Added automatic update checks at startup and every 30 minutes, while keeping installation user-initiated.
- Downloaded releases are restricted to the configured GitHub repository, size checked, SHA-256 verified, and confirmed as Windows executables before replacement.
- Added a hidden replacement helper that closes the current runtime, replaces the original launcher, restarts the application, and retains a rollback copy until startup is verified.
- Added launcher metadata so a renamed or relocated `大a后勤部.exe` updates its actual current path instead of relying on a machine-specific location.
- Preserved local review history during stable updates and migrated it from the latest legacy Member runtime on the first updater-enabled launch.
- Added regression coverage for semantic versions, hostile download URLs, corrupt payload rejection, the hidden installer, and the frontend update contract.

## 2.17.9 - 2026-07-30

- Started live market monitoring at 09:15 for the call auction and kept auction samples out of the regular 240-minute session history.
- Displayed all intraday timestamps at second precision.
- Added the portable full-A symbol universe and accepted the provider's 500-of-504 concept-board response cap without discarding the entire live snapshot.

## 2.17.8 - 2026-07-29

- Required every Windows stock and sector action to verify both the requested target and the daily-K page before reporting success.
- Added Tongdaxin's official `exec_to_tdx` internal target URL as the preferred direct-navigation path, with the verified keyboard flow retained as a fallback.
- Resolved Eastmoney board identifiers through each local Tongdaxin installation's index catalog and required an exact chart-title match, preventing a stock such as Ping An Bank from being mistaken for the Bank sector.
- Distinguished a real Tongdaxin login window from the market workspace and returned a dedicated login-required error instead of treating application launch as navigation success.
- Preserved automatic installed-application discovery in Member and Basic while keeping Self pinned to Tongdaxin.

## 2.17.7 - 2026-07-29

- Anchored the green outflow bars in the lower capital-flow rankings to the left so live width changes animate linearly from left to right.
- Left the sector-flow trajectory charts, values, and ranking order unchanged.
- Added regression coverage for the outflow-bar direction and included the corrected stylesheet explicitly in every packaged edition.

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
