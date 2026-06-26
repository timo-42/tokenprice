#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AZURE_RETAIL_PRICES_URL = 'https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview';
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?from=USD';
const DEFAULT_KEEP_DAYS = 30;
const DEFAULT_TIMEOUT_MS = 60000;

function utcDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateString(date);
}

function asText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function compactText(value) {
  return asText(value).replace(/\s+/g, ' ').trim();
}

function lowerText(...values) {
  return values.map(asText).join(' ').toLowerCase();
}

function roundNumber(value, digits = 12) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function parseArgs(argv) {
  const options = {};

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg.startsWith('--date=')) {
      options.date = arg.slice('--date='.length);
    } else if (arg.startsWith('--data-dir=')) {
      options.dataDir = arg.slice('--data-dir='.length);
    } else if (arg.startsWith('--keep-days=')) {
      options.keepDays = Number(arg.slice('--keep-days='.length));
    } else if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/ingest.js [options]

Fetch Azure Retail Prices and Frankfurter FX snapshots into data/.

Options:
  --date=YYYY-MM-DD       Snapshot date, defaults to today's UTC date
  --data-dir=PATH         Output directory, defaults to ./data
  --keep-days=N           Dated snapshot retention, defaults to ${DEFAULT_KEEP_DAYS}
  --timeout-ms=N          Per-request timeout, defaults to ${DEFAULT_TIMEOUT_MS}
  --dry-run               Fetch and normalize without writing files
`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation available. Use Node 18+ or inject fetchImpl.');
  }

  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retries = options.retries === undefined ? 2 : options.retries;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response || typeof response.ok !== 'boolean') {
        throw new Error(`Invalid fetch response for ${url}`);
      }

      if (!response.ok) {
        const body = typeof response.text === 'function' ? await response.text() : '';
        throw new Error(`GET ${url} failed with ${response.status} ${response.statusText || ''}: ${body.slice(0, 500)}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await sleep(250 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

function parseTokenUnit(unitOfMeasure, meterName = '') {
  const unit = compactText(unitOfMeasure);
  const meter = compactText(meterName);
  const joined = `${unit} ${meter}`;

  const shorthand = unit.match(/^(\d+(?:\.\d+)?)\s*([kKmM])$/);
  if (shorthand) {
    const multiplier = shorthand[2].toLowerCase() === 'm' ? 1000000 : 1000;
    const amount = Number(shorthand[1]) * multiplier;
    return {
      unitOfMeasure: unit,
      unitSizeTokens: amount,
      normalizedUnit: amount === 1000000 ? '1M tokens' : amount === 1000 ? '1K tokens' : `${amount} tokens`,
    };
  }

  const explicit = joined.match(/(\d+(?:\.\d+)?)\s*(k|m|thousand|million)?\s*tokens?\b/i);
  if (explicit) {
    const amount = Number(explicit[1]);
    const scale = asText(explicit[2]).toLowerCase();
    const multiplier = scale === 'm' || scale === 'million' ? 1000000 : scale === 'k' || scale === 'thousand' ? 1000 : 1;
    const tokens = amount * multiplier;
    return {
      unitOfMeasure: unit,
      unitSizeTokens: tokens,
      normalizedUnit: tokens === 1000000 ? '1M tokens' : tokens === 1000 ? '1K tokens' : `${tokens} tokens`,
    };
  }

  return {
    unitOfMeasure: unit,
    unitSizeTokens: null,
    normalizedUnit: null,
  };
}

function hasTokenUnit(item) {
  const unit = compactText(item.unitOfMeasure);
  const meter = compactText(item.meterName);
  const unitLower = unit.toLowerCase();
  const meterLower = meter.toLowerCase();

  if (/\btokens?\b/.test(unitLower)) return true;
  if (/\btokens?\b/.test(meterLower) && /^(\d+(?:\.\d+)?)\s*[kKmM]$/.test(unit)) return true;
  if (/\btokens?\b/.test(meterLower) && parseTokenUnit(unit, meter).unitSizeTokens) return true;

  return false;
}

function hasFoundryModelMetadata(item) {
  const serviceName = lowerText(item.serviceName);
  const serviceFamily = lowerText(item.serviceFamily);
  const productName = lowerText(item.productName);
  const skuName = lowerText(item.skuName);
  const meterName = lowerText(item.meterName);
  const armSkuName = lowerText(item.armSkuName);
  const metadata = `${serviceName} ${serviceFamily} ${productName} ${skuName} ${meterName} ${armSkuName}`;

  if (serviceName.includes('foundry models')) return true;
  if (serviceName.includes('azure ai foundry') || productName.includes('azure ai foundry')) return true;
  if (serviceName.includes('azure openai') || productName.includes('azure openai')) return true;
  if (serviceFamily.includes('ai + machine learning') && /\b(openai|gpt|llama|mistral|cohere|grok|kimi|phi|deepseek|model|models)\b/.test(metadata)) {
    return true;
  }

  return false;
}

function shouldIncludeRetailItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (compactText(item.type || item.priceType).toLowerCase() !== 'consumption') return false;
  if (compactText(item.currencyCode).toUpperCase() !== 'USD') return false;
  if (!hasTokenUnit(item)) return false;
  if (!hasFoundryModelMetadata(item)) return false;

  const price = Number(item.unitPrice ?? item.retailPrice);
  if (!Number.isFinite(price)) return false;

  return true;
}

function inferTokenDirection(item) {
  const text = lowerText(item.meterName, item.skuName, item.armSkuName);

  const hasInput = /\b(input|inpt|inp|prompt)\b/.test(text);
  const hasOutput = /\b(output|outpt|outp|completion|opt)\b/.test(text);
  const hasCache = /\b(cached|cache|cach|cchd|cd)\b/.test(text);
  const hasBatch = /\bbatch\b/.test(text);
  const hasImage = /\b(image|img)\b/.test(text);
  const hasAudio = /\b(audio|aud)\b/.test(text);
  const hasTraining = /\b(training|train|fine[-\s]?tuning)\b/.test(text);
  const hasEmbedding = /\b(embedding|embed)\b/.test(text);

  if (hasCache && hasInput) return 'cached_input';
  if (hasBatch && hasInput) return 'batch_input';
  if (hasBatch && hasOutput) return 'batch_output';
  if (hasImage && hasInput) return 'image_input';
  if (hasImage && hasOutput) return 'image_output';
  if (hasAudio && hasInput) return 'audio_input';
  if (hasAudio && hasOutput) return 'audio_output';
  if (hasInput) return 'input';
  if (hasOutput) return 'output';
  if (hasEmbedding) return 'embedding';
  if (hasTraining || /\bft\b/.test(text)) return 'fine_tuning';

  return null;
}

function inferModelFamily(item) {
  const product = compactText(item.productName);
  const label = compactText(item.skuName || item.armSkuName || item.meterName);
  const productWithoutAzure = product
    .replace(/^Azure\s+/i, '')
    .replace(/^OpenAI\s+/i, '')
    .replace(/\s+Models?$/i, '')
    .trim();

  if (/^OpenAI$/i.test(productWithoutAzure)) {
    const modelPrefix = label.match(/\b(gpt[-\s]?\d(?:[\w.\-]*|)|o\d(?:[\w.\-]*|)|text[-\s]?embedding[-\w.]*)\b/i);
    return modelPrefix ? modelPrefix[1].replace(/\s+/g, '-') : 'OpenAI';
  }

  if (/OpenAI\s+GPT\s*5/i.test(product) || /OpenAI\s+GPT5/i.test(product)) return 'GPT-5';
  if (/OpenAI\s+Media/i.test(product)) return 'OpenAI Media';
  if (productWithoutAzure) return productWithoutAzure;

  const fromLabel = label.match(/\b(gpt[-\s]?\d(?:[\w.\-]*|)|llama[\w.\-]*|mistral[\w.\-]*|grok[\w.\-]*|kimi[\w.\-]*|phi[\w.\-]*|deepseek[\w.\-]*)\b/i);
  return fromLabel ? fromLabel[1].replace(/\s+/g, '-') : 'Unknown';
}

function cleanModelName(item) {
  const source = compactText(item.skuName || item.armSkuName || item.meterName);
  const directionPattern = /\b(cached|cache|cach|cchd|input|inpt|inp|prompt|output|outpt|outp|completion|opt|batch)\b/ig;
  const scopePattern = /\b(glbl|global|gl|regnl|regional|data zone|dzone|dz)\b/ig;

  const cleaned = source
    .replace(/\b\d+(?:\.\d+)?\s*[kKmM]\s+tokens?\b/ig, ' ')
    .replace(/\btokens?\b/ig, ' ')
    .replace(directionPattern, ' ')
    .replace(scopePattern, ' ')
    .replace(/[-_\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || source || 'Unknown';
}

function normalizeRetailItem(item) {
  const unit = parseTokenUnit(item.unitOfMeasure, item.meterName);
  const unitPriceUsd = Number(item.unitPrice ?? item.retailPrice);
  const retailPriceUsd = Number(item.retailPrice ?? item.unitPrice);
  const usdPerToken = unit.unitSizeTokens ? unitPriceUsd / unit.unitSizeTokens : null;
  const usdPer1KTokens = usdPerToken === null ? null : usdPerToken * 1000;
  const usdPer1MTokens = usdPerToken === null ? null : usdPerToken * 1000000;
  const tokenDirection = inferTokenDirection(item);

  return {
    id: compactText(`${item.meterId || ''}:${item.skuId || ''}:${item.armRegionName || item.location || ''}`),
    modelFamily: inferModelFamily(item),
    modelName: cleanModelName(item),
    region: compactText(item.armRegionName) || null,
    location: compactText(item.location) || null,
    meterName: compactText(item.meterName) || null,
    direction: tokenDirection,
    tokenDirection,
    unitOfMeasure: unit.unitOfMeasure,
    unitSizeTokens: unit.unitSizeTokens,
    normalizedUnit: unit.normalizedUnit,
    usdUnitPrice: roundNumber(unitPriceUsd),
    unitPriceUsd: roundNumber(unitPriceUsd),
    retailPriceUsd: roundNumber(retailPriceUsd),
    usdPerToken: roundNumber(usdPerToken, 15),
    usdPer1KTokens: roundNumber(usdPer1KTokens),
    usdPer1MTokens: roundNumber(usdPer1MTokens),
    tokenNormalizedPrice: roundNumber(usdPer1KTokens),
    tokenNormalizedUnit: '1K tokens',
    effectiveStartDate: compactText(item.effectiveStartDate) || null,
    tierMinimumUnits: Number.isFinite(Number(item.tierMinimumUnits)) ? Number(item.tierMinimumUnits) : null,
    currencyCode: 'USD',
    source: {
      meterId: compactText(item.meterId) || null,
      serviceName: compactText(item.serviceName) || null,
      productName: compactText(item.productName) || null,
      skuName: compactText(item.skuName) || null,
      armRegionName: compactText(item.armRegionName) || null,
      priceType: compactText(item.type || item.priceType) || null,
    },
    raw: {
      meterId: compactText(item.meterId) || null,
      productId: compactText(item.productId) || null,
      skuId: compactText(item.skuId) || null,
      productName: compactText(item.productName) || null,
      skuName: compactText(item.skuName) || null,
      serviceName: compactText(item.serviceName) || null,
      serviceId: compactText(item.serviceId) || null,
      serviceFamily: compactText(item.serviceFamily) || null,
      armSkuName: compactText(item.armSkuName) || null,
      type: compactText(item.type || item.priceType) || null,
      priceType: compactText(item.priceType || item.type) || null,
      isPrimaryMeterRegion: typeof item.isPrimaryMeterRegion === 'boolean' ? item.isPrimaryMeterRegion : null,
    },
  };
}

function normalizePriceRows(rows) {
  if (!Array.isArray(rows)) return [];

  return rows.filter(shouldIncludeRetailItem).map((item) => {
    const unit = parseTokenUnit(item.unitOfMeasure, item.meterName);
    const usdUnitPrice = Number(item.unitPrice ?? item.retailPrice);
    const usdPer1KTokens = unit.unitSizeTokens ? usdUnitPrice * 1000 / unit.unitSizeTokens : null;

    return {
      modelFamily: compactText(item.productName) || inferModelFamily(item),
      modelName: compactText(item.skuName || item.armSkuName || item.meterName) || 'Unknown',
      region: compactText(item.armRegionName) || null,
      location: compactText(item.location) || null,
      meterName: compactText(item.meterName) || null,
      unitOfMeasure: compactText(item.unitOfMeasure) || null,
      currencyCode: 'USD',
      usdUnitPrice: roundNumber(usdUnitPrice),
      usdPer1KTokens: roundNumber(usdPer1KTokens),
      source: {
        meterId: compactText(item.meterId) || null,
        serviceName: compactText(item.serviceName) || null,
        productName: compactText(item.productName) || null,
        skuName: compactText(item.skuName) || null,
        armRegionName: compactText(item.armRegionName) || null,
        priceType: compactText(item.type || item.priceType) || null,
      },
    };
  });
}

function sortPrices(rows) {
  return rows.sort((a, b) => {
    return [
      a.modelFamily.localeCompare(b.modelFamily),
      a.modelName.localeCompare(b.modelName),
      (a.region || '').localeCompare(b.region || ''),
      (a.tokenDirection || '').localeCompare(b.tokenDirection || ''),
      (a.meterName || '').localeCompare(b.meterName || ''),
      a.unitPriceUsd - b.unitPriceUsd,
    ].find((value) => value !== 0) || 0;
  });
}

async function fetchAzureTokenPrices(options = {}) {
  const rows = [];
  const seenUrls = new Set();
  const stats = {
    pages: 0,
    sourceRows: 0,
    includedRows: 0,
  };

  let nextUrl = options.priceUrl || AZURE_RETAIL_PRICES_URL;

  while (nextUrl) {
    if (seenUrls.has(nextUrl)) {
      throw new Error(`Azure Retail Prices pagination loop detected at ${nextUrl}`);
    }
    seenUrls.add(nextUrl);

    const page = await fetchJson(nextUrl, options);
    const items = Array.isArray(page.Items) ? page.Items : [];

    stats.pages += 1;
    stats.sourceRows += items.length;

    for (const item of items) {
      if (shouldIncludeRetailItem(item)) {
        rows.push(normalizeRetailItem(item));
      }
    }

    stats.includedRows = rows.length;

    if (typeof options.onPage === 'function') {
      await options.onPage({
        page: stats.pages,
        sourceRows: stats.sourceRows,
        includedRows: stats.includedRows,
        nextPageLink: page.NextPageLink || page.nextPageLink || null,
      });
    }

    nextUrl = page.NextPageLink || page.nextPageLink || null;

    if (options.maxPages && stats.pages >= options.maxPages) {
      break;
    }
  }

  return {
    rows: sortPrices(rows),
    stats,
  };
}

async function collectPaginatedJson(fetchImpl, startUrl, options = {}) {
  const rows = [];
  const seenUrls = new Set();
  let nextUrl = startUrl;

  while (nextUrl) {
    if (seenUrls.has(nextUrl)) {
      throw new Error(`Pagination loop detected at ${nextUrl}`);
    }
    seenUrls.add(nextUrl);

    const page = await fetchJson(nextUrl, Object.assign({}, options, { fetchImpl }));
    const items = Array.isArray(page.Items) ? page.Items : [];
    rows.push(...items);
    nextUrl = page.NextPageLink || page.nextPageLink || null;
  }

  return rows;
}

function buildPriceSnapshot(rows, stats, options = {}) {
  const generatedAt = (options.now || new Date()).toISOString();
  const date = options.date || utcDateString(options.now || new Date());

  return {
    schemaVersion: 1,
    generatedAt,
    pricingDate: date,
    currencyCode: 'USD',
    source: {
      name: 'Azure Retail Prices API',
      url: options.priceUrl || AZURE_RETAIL_PRICES_URL,
      apiVersion: '2023-01-01-preview',
    },
    filter: {
      type: 'Consumption',
      currencyCode: 'USD',
      unit: 'token-related unit measures',
      metadata: 'Foundry Models, Azure OpenAI, or AI model metadata',
    },
    count: rows.length,
    sourceRowsScanned: stats.sourceRows,
    pagesScanned: stats.pages,
    prices: rows,
  };
}

function normalizeFxPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid Frankfurter payload');
  }

  const base = compactText(payload.base || 'USD').toUpperCase();
  if (base !== 'USD') {
    throw new Error(`Frankfurter FX base must be USD, got ${base || 'unknown'}`);
  }

  const rates = Object.assign({}, payload.rates || {});
  rates.USD = 1;

  for (const [currency, value] of Object.entries(rates)) {
    if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(Number(value))) {
      throw new Error(`Invalid FX rate for ${currency}`);
    }
    rates[currency] = Number(value);
  }

  return {
    schemaVersion: 1,
    generatedAt: (options.now || new Date()).toISOString(),
    date: compactText(payload.date) || options.date || utcDateString(options.now || new Date()),
    base,
    stale: false,
    source: {
      name: 'Frankfurter',
      url: options.fxUrl || FRANKFURTER_URL,
    },
    rates: Object.fromEntries(Object.entries(rates).sort(([a], [b]) => a.localeCompare(b))),
  };
}

async function fetchFreshFxSnapshot(options = {}) {
  const payload = await fetchJson(options.fxUrl || FRANKFURTER_URL, options);
  return normalizeFxPayload(payload, options);
}

async function findPreviousFxSnapshot(dataDir, beforeDate) {
  let entries;
  try {
    entries = await fs.readdir(dataDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }

  const candidates = entries
    .map((file) => {
      const match = file.match(/^fx-(\d{4}-\d{2}-\d{2})\.json$/);
      return match ? { file, date: match[1] } : null;
    })
    .filter(Boolean)
    .filter((entry) => !beforeDate || entry.date < beforeDate)
    .sort((a, b) => b.date.localeCompare(a.date));

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(path.join(dataDir, candidate.file), 'utf8');
      return {
        file: candidate.file,
        snapshot: JSON.parse(raw),
      };
    } catch (_) {
      // Keep looking; a corrupt old FX file should not hide a usable older one.
    }
  }

  return null;
}

function buildStaleFxSnapshot(previous, error, options = {}) {
  const now = options.now || new Date();
  const date = options.date || utcDateString(now);
  const previousSnapshot = previous && previous.snapshot ? previous.snapshot : null;
  const previousRates = previousSnapshot && previousSnapshot.rates ? previousSnapshot.rates : { USD: 1 };

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    date: previousSnapshot && previousSnapshot.date ? previousSnapshot.date : date,
    snapshotDate: date,
    base: previousSnapshot && previousSnapshot.base ? previousSnapshot.base : 'USD',
    stale: true,
    staleReason: error ? String(error.message || error) : 'FX fetch failed',
    fallbackFrom: previous ? previous.file : null,
    source: previousSnapshot && previousSnapshot.source ? previousSnapshot.source : {
      name: 'USD-only fallback',
      url: options.fxUrl || FRANKFURTER_URL,
    },
    rates: Object.fromEntries(Object.entries(Object.assign({ USD: 1 }, previousRates)).sort(([a], [b]) => a.localeCompare(b))),
  };
}

async function getFxSnapshot(options = {}) {
  try {
    return await fetchFreshFxSnapshot(options);
  } catch (error) {
    const previous = await findPreviousFxSnapshot(options.dataDir || path.resolve(process.cwd(), 'data'), options.date);
    return buildStaleFxSnapshot(previous, error, options);
  }
}

function buildLatestSnapshot(priceSnapshot, fxSnapshot, options = {}) {
  const date = options.date || priceSnapshot.pricingDate;
  const priceFile = options.priceFile || `prices-${date}.json`;
  const fxFile = options.fxFile || `fx-${date}.json`;

  return {
    schemaVersion: 1,
    generatedAt: (options.now || new Date()).toISOString(),
    pricingDate: priceSnapshot.pricingDate,
    prices: {
      file: priceFile,
      count: priceSnapshot.count,
    },
    fx: {
      file: fxFile,
      date: fxSnapshot.date,
      base: fxSnapshot.base,
      stale: Boolean(fxSnapshot.stale),
    },
    priceSnapshot: priceFile,
    priceSnapshotPath: `data/${priceFile}`,
    fxDate: fxSnapshot.date,
    fxSnapshot: fxFile,
    fxSnapshotPath: `data/${fxFile}`,
    fxStale: Boolean(fxSnapshot.stale),
    counts: {
      prices: priceSnapshot.count,
      pricePagesScanned: priceSnapshot.pagesScanned,
      priceSourceRowsScanned: priceSnapshot.sourceRowsScanned,
      currencies: fxSnapshot.rates ? Object.keys(fxSnapshot.rates).length : 0,
    },
    sources: {
      prices: priceSnapshot.source,
      fx: fxSnapshot.source,
    },
  };
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tempFile, json, 'utf8');
  await fs.rename(tempFile, filePath);
}

async function pruneSnapshots(dataDir, options = {}) {
  const keepDays = options.keepDays || DEFAULT_KEEP_DAYS;
  const date = options.date || utcDateString(options.now || new Date());
  const cutoff = addDays(date, -(keepDays - 1));
  let entries;

  try {
    entries = await fs.readdir(dataDir);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }

  const deleted = [];
  for (const file of entries) {
    const match = file.match(/^(prices|fx)-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!match) continue;
    if (match[2] >= cutoff) continue;

    await fs.unlink(path.join(dataDir, file));
    deleted.push(file);
  }

  return deleted.sort();
}

async function runIngestion(options = {}) {
  const now = options.now || new Date();
  const date = options.date || utcDateString(now);
  const dataDir = options.dataDir || path.resolve(process.cwd(), 'data');
  const priceFile = `prices-${date}.json`;
  const fxFile = `fx-${date}.json`;

  const priceResult = await fetchAzureTokenPrices(Object.assign({}, options, {
    priceUrl: options.priceUrl || AZURE_RETAIL_PRICES_URL,
  }));
  const priceSnapshot = buildPriceSnapshot(priceResult.rows, priceResult.stats, Object.assign({}, options, { date, now }));

  const fxSnapshot = await getFxSnapshot(Object.assign({}, options, {
    date,
    now,
    dataDir,
    fxUrl: options.fxUrl || FRANKFURTER_URL,
  }));

  const latestSnapshot = buildLatestSnapshot(priceSnapshot, fxSnapshot, {
    date,
    now,
    priceFile,
    fxFile,
  });

  if (!options.dryRun) {
    await fs.mkdir(dataDir, { recursive: true });
    await writeJsonAtomic(path.join(dataDir, priceFile), priceSnapshot);
    await writeJsonAtomic(path.join(dataDir, fxFile), fxSnapshot);
    await writeJsonAtomic(path.join(dataDir, 'latest.json'), latestSnapshot);
    latestSnapshot.retentionDeleted = await pruneSnapshots(dataDir, { date, keepDays: options.keepDays || DEFAULT_KEEP_DAYS });
    if (latestSnapshot.retentionDeleted.length) {
      await writeJsonAtomic(path.join(dataDir, 'latest.json'), latestSnapshot);
    }
  }

  return {
    date,
    dataDir,
    priceFile,
    fxFile,
    priceSnapshot,
    fxSnapshot,
    latestSnapshot,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error('--date must use YYYY-MM-DD');
  }

  if (options.keepDays !== undefined && (!Number.isInteger(options.keepDays) || options.keepDays < 1)) {
    throw new Error('--keep-days must be a positive integer');
  }

  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new Error('--timeout-ms must be a positive number');
  }

  const result = await runIngestion(options);
  const staleText = result.fxSnapshot.stale ? 'stale' : 'fresh';
  const writeText = options.dryRun ? 'validated' : 'wrote';

  console.log(`${writeText} ${result.priceSnapshot.count} Azure token price rows from ${result.priceSnapshot.pagesScanned} pages`);
  console.log(`${writeText} FX snapshot ${result.fxFile} (${staleText}, ${Object.keys(result.fxSnapshot.rates).length} currencies)`);
  if (!options.dryRun) {
    console.log(`updated data/latest.json`);
  }
}

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

export {
  AZURE_RETAIL_PRICES_URL,
  FRANKFURTER_URL,
  DEFAULT_KEEP_DAYS,
  parseTokenUnit,
  hasTokenUnit,
  hasFoundryModelMetadata,
  shouldIncludeRetailItem,
  inferTokenDirection,
  inferModelFamily,
  cleanModelName,
  normalizeRetailItem,
  normalizePriceRows,
  sortPrices,
  fetchJson,
  collectPaginatedJson,
  fetchAzureTokenPrices,
  buildPriceSnapshot,
  normalizeFxPayload,
  fetchFreshFxSnapshot,
  findPreviousFxSnapshot,
  buildStaleFxSnapshot,
  getFxSnapshot,
  buildLatestSnapshot,
  writeJsonAtomic,
  pruneSnapshots,
  runIngestion,
};
