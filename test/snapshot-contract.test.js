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

test("committed latest snapshot points at matching production snapshots", async () => {
  const dataDir = path.resolve("data");
  const latest = JSON.parse(await readFile(path.join(dataDir, "latest.json"), "utf8"));
  const prices = JSON.parse(await readFile(path.join(dataDir, latest.prices.file), "utf8"));
  const fx = JSON.parse(await readFile(path.join(dataDir, latest.fx.file), "utf8"));

  assert.equal(latest.schemaVersion, 1);
  assert.equal(prices.schemaVersion, 1);
  assert.equal(fx.schemaVersion, 1);
  assert.equal(latest.prices.count, prices.prices.length);
  assert.equal(latest.pricingDate, prices.pricingDate);
  assert.equal(latest.fx.date, fx.date);
  assert.equal(latest.fx.base, fx.base);
  assert.equal(latest.fx.stale, fx.stale);
});

test("committed capability catalog exposes documented tag metadata and models", async () => {
  const catalog = JSON.parse(await readFile(path.resolve("data/model-capabilities.json"), "utf8"));

  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.modelCount > 0);
  assert.ok(catalog.sources.length >= 3);
  assert.ok(catalog.tags.some((tag) => tag.id === "reasoning" && tag.label === "Reasoning"));
  assert.ok(catalog.tags.some((tag) => tag.id === "audio" && tag.label === "Audio"));
  assert.ok(catalog.models.gpt5.capabilities.includes("reasoning"));
});
