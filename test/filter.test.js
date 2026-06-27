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
    usdPrice: 2.5
  },
  {
    model: "gpt-4o",
    region: "westeurope",
    direction: "Output",
    unit: "1M Tokens",
    usdPrice: 10
  },
  {
    model: "phi-4",
    region: "eastus",
    direction: "Cached input",
    unit: "1K Tokens",
    usdPrice: 0.0001
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

test("getUniqueFilterOptions returns sorted unique values", () => {
  assert.deepEqual(helpers.getUniqueFilterOptions(rows, "region"), ["eastus", "westeurope"]);
  assert.deepEqual(helpers.getUniqueFilterOptions(rows, "direction"), ["Cached input", "Input", "Output"]);
});

test("formatRowCount shows filtered and total counts only when filters reduce rows", () => {
  assert.equal(helpers.formatRowCount(3, 3), "3");
  assert.equal(helpers.formatRowCount(1, 3), "1 / 3");
});
