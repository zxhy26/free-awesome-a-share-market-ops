# Changelog

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
