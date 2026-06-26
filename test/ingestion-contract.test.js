import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const ingestionPath = path.resolve("scripts/ingest.js");
const ingestionModule = existsSync(ingestionPath)
  ? await import(pathToFileURL(ingestionPath).href)
  : null;
const skipMissingIngestion =
  "scripts/ingest.js is not present yet; this contract activates when the ingestion public API is implemented.";

test(
  "collectPaginatedJson follows Azure Retail Prices NextPageLink values in order",
  { skip: ingestionModule ? false : skipMissingIngestion },
  async () => {
    assert.equal(typeof ingestionModule.collectPaginatedJson, "function");

    const calls = [];
    const pages = new Map([
      [
        "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview",
        {
          Items: [{ meterId: "page-1" }],
          NextPageLink: "https://prices.azure.com/api/retail/prices?page=2"
        }
      ],
      [
        "https://prices.azure.com/api/retail/prices?page=2",
        {
          Items: [{ meterId: "page-2a" }, { meterId: "page-2b" }],
          NextPageLink: null
        }
      ]
    ]);
    const fetchImpl = async (url) => {
      calls.push(url);
      assert.ok(pages.has(url), `unexpected fetch URL: ${url}`);
      return {
        ok: true,
        status: 200,
        json: async () => pages.get(url)
      };
    };

    const rows = await ingestionModule.collectPaginatedJson(
      fetchImpl,
      "https://prices.azure.com/api/retail/prices?api-version=2023-01-01-preview"
    );

    assert.deepEqual(calls, [...pages.keys()]);
    assert.deepEqual(
      rows.map((row) => row.meterId),
      ["page-1", "page-2a", "page-2b"]
    );
  }
);

test(
  "normalizePriceRows filters token consumption rows and emits frontend-ready USD fields",
  { skip: ingestionModule ? false : skipMissingIngestion },
  async () => {
    assert.equal(typeof ingestionModule.normalizePriceRows, "function");

    const rows = [
      {
        currencyCode: "USD",
        retailPrice: 2.5,
        unitPrice: 2.5,
        unitOfMeasure: "1M Tokens",
        priceType: "Consumption",
        serviceName: "Azure AI Foundry",
        productName: "Azure AI Foundry GPT-4o",
        skuName: "gpt-4o Input",
        meterName: "Input Tokens",
        armRegionName: "eastus",
        location: "US East",
        meterId: "token-meter"
      },
      {
        currencyCode: "USD",
        retailPrice: 1,
        unitPrice: 1,
        unitOfMeasure: "1 Hour",
        priceType: "Consumption",
        serviceName: "Azure AI Foundry",
        productName: "Azure AI Foundry Hosting",
        skuName: "Standard",
        meterName: "Hosting Hour",
        armRegionName: "eastus",
        location: "US East",
        meterId: "hour-meter"
      },
      {
        currencyCode: "USD",
        retailPrice: 99,
        unitPrice: 99,
        unitOfMeasure: "1M Tokens",
        priceType: "Reservation",
        serviceName: "Azure AI Foundry",
        productName: "Azure AI Foundry GPT-4o",
        skuName: "gpt-4o Output",
        meterName: "Output Tokens",
        armRegionName: "eastus",
        location: "US East",
        meterId: "reservation-meter"
      }
    ];

    const normalized = ingestionModule.normalizePriceRows(rows);

    assert.equal(normalized.length, 1);
    assert.deepEqual(normalized[0], {
      modelFamily: "Azure AI Foundry GPT-4o",
      modelName: "gpt-4o Input",
      region: "eastus",
      location: "US East",
      meterName: "Input Tokens",
      unitOfMeasure: "1M Tokens",
      currencyCode: "USD",
      usdUnitPrice: 2.5,
      usdPer1KTokens: 0.0025,
      source: {
        meterId: "token-meter",
        serviceName: "Azure AI Foundry",
        productName: "Azure AI Foundry GPT-4o",
        skuName: "gpt-4o Input",
        armRegionName: "eastus",
        priceType: "Consumption"
      }
    });
  }
);
