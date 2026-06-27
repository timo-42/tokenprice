# Requirements: Azure Foundry Token Prices Dashboard

## Objective
Build a GitHub Pages site that displays worldwide Azure AI Foundry token prices and supports user-selected currency conversion, using daily snapshots produced from API data (no backend).

## Success Criteria
- Fetch and store daily Azure AI Foundry token prices from Azure Retail Prices API.
- Fetch and store daily FX conversion rates (USD base) from an external converter API.
- Persist snapshots in repo for static consumption by the Pages site.
- Render a worldwide view of token prices with a currency selector.
- Enrich model rows with best-effort capability metadata from MicrosoftDocs source files.
- Display update metadata (pricing date + FX date) and fallback behavior when FX data is unavailable.

## Functional Requirements

### 1) Data Ingestion (Automated, Daily)
- A scheduled workflow must run daily at **03:17 UTC** to avoid API rate-limit pressure around midnight UTC.
- It must:
  - Download Azure Retail Prices records via OData endpoint:
    - `https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview`
  - Handle pagination using `NextPageLink`.
  - Filter to Foundry token rows (Consumption price type, token-related unit measures).
  - Normalize each row to include:
    - model family/name
    - region/location
    - meter name
    - unit of measure (`1K`, `1M`, etc.)
    - USD unit price and token-normalized unit price
    - raw source fields needed for traceability.
- A second call must fetch FX rates from Frankfurter:
  - `https://api.frankfurter.app/latest?from=USD`
- The workflow must run in GitHub Actions and commit updated snapshot files.

### 2) Storage and Snapshot Data
- Persist snapshot files under `data/`:
  - `data/latest.json` (pointer to current files + metadata)
  - `data/prices-YYYY-MM-DD.json`
  - `data/fx-YYYY-MM-DD.json` (or equivalent embedded in latest snapshot)
- Keep a retention window (recommended: last 30 days).
- Snapshots are the only source consumed by the frontend.

### 3) Frontend
- Host as a static GitHub Pages site (`index.html`, `app.js`, CSS as needed).
- Load `data/latest.json` and selected price snapshot.
- Render a worldwide price table with:
  - model
  - region
  - meter/token direction (input/output/etc.)
  - unit
  - USD price
  - user-selected currency price
- Include currency selector populated from FX keys.
- Include best-effort capability filters when `data/model-capabilities.json` is available.
- Default display currency is USD.
- Show conversion timestamp and price snapshot timestamp.

### 4) Capability Enrichment
- A separate workflow should fetch MicrosoftDocs markdown sources from `MicrosoftDocs/azure-ai-docs`.
- It should generate `data/model-capabilities.json` with conservative capability tags such as reasoning, audio, image, video, embeddings, tool calling, structured outputs, fine-tuning, realtime, and batch.
- Capability enrichment is best-effort documentation metadata and must not block Azure pricing ingestion.
- If the capability catalog is unavailable, the frontend must continue to render prices without capability filters.

### 5) Failure Behavior
- If FX fetch fails on ingestion day:
  - continue publishing prices.
  - use the previous FX snapshot and mark FX as stale.
- If snapshot price fetch fails:
  - workflow should fail and report clearly (no partial/invalid data publish).
- If capability enrichment fails:
  - capability workflow should fail clearly.
  - existing prices and Pages site should continue using the last committed capability catalog, or no catalog if none exists.

## Non-Functional Requirements
- No runtime backend service.
- No API keys required.
- Minimal dependencies (Node scripts only for ingestion).
- Keep page responsive and readable on desktop/mobile.
- Deterministic parsing and filtering to avoid accidental regressions.

## Assumptions
- Exchange rates are sourced from Frankfurter and based on USD.
- Azure prices remain in USD in source records.
- “Worldwide” is interpreted as all regions returned by Azure API entries.

## Open Questions
- None required for baseline; scope is all available foundry token SKUs, all regions, all currencies provided by FX snapshot.

## Acceptance Tests
- Ingestion script successfully writes both price and FX snapshots for a sample run.
- `NextPageLink` traversal completes without misses.
- UI renders and converts prices using a non-USD currency.
- Changing currency updates all displayed converted values instantly.
- Price list degrades to USD-only only when FX is unavailable and stale notice is shown.
- Capability filters work when the generated catalog is present and disappear/degrade when it is unavailable.
- GitHub Pages site works from committed snapshots without any server runtime.
