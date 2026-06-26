import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const fixturesDir = path.resolve("test/fixtures");

async function readFixture(name) {
  return JSON.parse(await readFile(path.join(fixturesDir, name), "utf8"));
}

function convertUsd(usdAmount, currencyCode, fxSnapshot) {
  if (currencyCode === "USD") {
    return usdAmount;
  }
  const rate = fxSnapshot.rates[currencyCode];
  if (typeof rate !== "number") {
    throw new RangeError(`Missing FX rate for ${currencyCode}`);
  }
  return usdAmount * rate;
}

test("latest snapshot points at price and FX files with update metadata", async () => {
  const latest = await readFixture("latest.json");

  assert.equal(latest.schemaVersion, 1);
  assert.match(latest.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(latest.pricingDate, "2026-06-26");
  assert.deepEqual(latest.prices, {
    file: "prices-2026-06-26.json",
    count: 2
  });
  assert.deepEqual(latest.fx, {
    file: "fx-2026-06-26.json",
    date: "2026-06-26",
    base: "USD",
    stale: false
  });
});

test("price snapshot rows expose the fields the static frontend needs", async () => {
  const snapshot = await readFixture("prices-2026-06-26.json");

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.currencyCode, "USD");
  assert.equal(snapshot.prices.length, 2);

  for (const price of snapshot.prices) {
    assert.equal(typeof price.modelFamily, "string");
    assert.equal(typeof price.modelName, "string");
    assert.equal(typeof price.region, "string");
    assert.equal(typeof price.location, "string");
    assert.equal(typeof price.meterName, "string");
    assert.equal(typeof price.unitOfMeasure, "string");
    assert.equal(typeof price.usdUnitPrice, "number");
    assert.equal(typeof price.usdPer1KTokens, "number");
    assert.equal(price.currencyCode, "USD");
    assert.equal(typeof price.source.meterId, "string");
  }
});

test("FX snapshot supports USD default and non-USD frontend conversion", async () => {
  const prices = await readFixture("prices-2026-06-26.json");
  const fx = await readFixture("fx-2026-06-26.json");

  assert.equal(fx.base, "USD");
  assert.equal(fx.stale, false);
  assert.equal(convertUsd(prices.prices[0].usdUnitPrice, "USD", fx), 2.5);
  assert.ok(Math.abs(convertUsd(prices.prices[0].usdUnitPrice, "EUR", fx) - 2.3) < 0.000001);
  assert.throws(() => convertUsd(1, "ZZZ", fx), /Missing FX rate/);
});
