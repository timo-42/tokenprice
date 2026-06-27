import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

await import(pathToFileURL(path.resolve("app.js")).href);

const helpers = globalThis.AzureTokenPricesDashboard;

const rows = [
  {
    model: "gpt-4o",
    region: "eastus",
    direction: "Input",
    unit: "1M Tokens",
    usdPrice: 2.5,
    capabilities: ["image", "tool-calling"],
    capabilityLabels: ["Image", "Tool calling"],
    modelKeys: ["gpt4o"]
  },
  {
    model: "gpt-4o",
    region: "westeurope",
    direction: "Output",
    unit: "1M Tokens",
    usdPrice: 10,
    capabilities: ["image"],
    capabilityLabels: ["Image"],
    modelKeys: ["gpt4o"]
  },
  {
    model: "phi-4",
    region: "eastus",
    direction: "Cached input",
    unit: "1K Tokens",
    usdPrice: 0.0001,
    capabilities: ["reasoning"],
    capabilityLabels: ["Reasoning"],
    modelKeys: ["phi4"]
  }
];

test("filterRows returns all rows when filters are empty", () => {
  assert.deepEqual(helpers.filterRows(rows, {}), rows);
});

test("filterRows matches text across visible row fields case-insensitively", () => {
  assert.deepEqual(
    helpers.filterRows(rows, { search: "WEST" }).map((row) => row.region),
    ["westeurope"]
  );
  assert.deepEqual(
    helpers.filterRows(rows, { search: "cached" }).map((row) => row.model),
    ["phi-4"]
  );
  assert.deepEqual(
    helpers.filterRows(rows, { search: "1k" }).map((row) => row.model),
    ["phi-4"]
  );
});

test("filterRows combines dropdown filters and search with AND logic", () => {
  assert.deepEqual(
    helpers.filterRows(rows, {
      search: "gpt",
      model: "gpt-4o",
      region: "eastus",
      direction: "Input"
    }).map((row) => row.usdPrice),
    [2.5]
  );
  assert.deepEqual(
    helpers.filterRows(rows, {
      search: "gpt",
      model: "gpt-4o",
      region: "eastus",
      direction: "Output"
    }),
    []
  );
});

test("filterRows supports capability filters and capability search", () => {
  assert.deepEqual(
    helpers.filterRows(rows, { capability: "reasoning" }).map((row) => row.model),
    ["phi-4"]
  );
  assert.deepEqual(
    helpers.filterRows(rows, { search: "tool calling" }).map((row) => row.region),
    ["eastus"]
  );
});

test("getUniqueFilterOptions returns sorted unique values", () => {
  assert.deepEqual(helpers.getUniqueFilterOptions(rows, "region"), ["eastus", "westeurope"]);
  assert.deepEqual(helpers.getUniqueFilterOptions(rows, "direction"), ["Cached input", "Input", "Output"]);
});

test("formatRowCount shows filtered and total counts only when filters reduce rows", () => {
  assert.equal(helpers.formatRowCount(3, 3), "3");
  assert.equal(helpers.formatRowCount(1, 3), "1 / 3");
});

test("enrichRows attaches capabilities from catalog with exact and suffix matches", () => {
  const catalog = {
    tags: [
      { id: "reasoning", label: "Reasoning" },
      { id: "tool-calling", label: "Tool calling" }
    ],
    models: {
      gpt5: {
        capabilities: ["reasoning", "tool-calling"]
      },
      coherecommanda: {
        capabilities: ["tool-calling"]
      }
    }
  };

  const enriched = helpers.enrichRows([
    { model: "gpt-5", modelKeys: ["gpt5"] },
    { model: "Command A", modelKeys: ["commanda"] }
  ], catalog);

  assert.deepEqual(enriched[0].capabilityLabels, ["Reasoning", "Tool calling"]);
  assert.deepEqual(enriched[1].capabilityLabels, ["Tool calling"]);
});

test("enrichRows leaves rows unchanged when catalog is missing", () => {
  assert.deepEqual(helpers.enrichRows(rows, null), rows);
});

test("getCapabilityOptions returns sorted labels from enriched rows", () => {
  assert.deepEqual(helpers.getCapabilityOptions(rows, {
    image: "Image",
    reasoning: "Reasoning",
    "tool-calling": "Tool calling"
  }), [
    { id: "image", label: "Image" },
    { id: "reasoning", label: "Reasoning" },
    { id: "tool-calling", label: "Tool calling" }
  ]);
});
