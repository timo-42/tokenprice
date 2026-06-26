(function () {
  "use strict";

  var DATA_ROOT = "data/";
  var MAX_FX_AGE_DAYS = 2;

  var state = {
    rows: [],
    fxRates: { USD: 1 },
    fxDate: null,
    priceDate: null,
    fxUnavailable: false,
    fxStale: false,
    selectedCurrency: "USD"
  };

  var elements = {
    currency: document.getElementById("currency"),
    priceDate: document.getElementById("price-date"),
    fxDate: document.getElementById("fx-date"),
    rowCount: document.getElementById("row-count"),
    notice: document.getElementById("notice"),
    rows: document.getElementById("price-rows"),
    conversionNote: document.getElementById("conversion-note"),
    selectedHeading: document.getElementById("selected-price-heading")
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    elements.currency.addEventListener("change", function (event) {
      state.selectedCurrency = event.target.value || "USD";
      renderRows();
      renderMetadata();
    });

    loadSnapshots().catch(function (error) {
      showFatalError(error);
    });
  }

  async function loadSnapshots() {
    var latest = await fetchJson(resolveDataPath("latest.json"));
    var prices = await loadPriceSnapshot(latest);
    var fx = await loadFxSnapshot(latest);

    state.rows = normalizeRows(prices);
    state.priceDate = firstValue(
      latest.pricingDate,
      latest.priceDate,
      latest.pricesDate,
      prices.pricingDate,
      prices.priceDate,
      prices.date,
      latest.generatedAt,
      prices.generatedAt
    );

    applyFxSnapshot(latest, fx);
    populateCurrencies();
    renderRows();
    renderMetadata();
  }

  async function loadPriceSnapshot(latest) {
    var embedded = firstSnapshotObjectOrArray(latest.prices, latest.priceSnapshot, latest.priceData);
    if (embedded) {
      return embedded;
    }

    var path = firstValue(
      latest.prices && latest.prices.file,
      latest.priceSnapshot,
      latest.priceSnapshotPath,
      latest.pricesSnapshot,
      latest.pricesSnapshotPath,
      latest.pricesFile,
      latest.pricesPath
    );

    if (!path || typeof path !== "string") {
      throw new Error("data/latest.json does not reference a price snapshot.");
    }

    return fetchJson(resolveDataPath(path));
  }

  async function loadFxSnapshot(latest) {
    var embedded = firstSnapshotObjectOrArray(latest.fx, latest.fxSnapshot, latest.fxData, latest.rates);
    if (embedded) {
      return embedded;
    }

    var path = firstValue(
      latest.fx && latest.fx.file,
      latest.fxSnapshot,
      latest.fxSnapshotPath,
      latest.fxFile,
      latest.fxPath,
      latest.ratesPath
    );

    if (!path || typeof path !== "string") {
      return null;
    }

    try {
      return await fetchJson(resolveDataPath(path));
    } catch (error) {
      console.warn("FX snapshot could not be loaded:", error);
      return null;
    }
  }

  async function fetchJson(path) {
    var response = await fetch(path, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Could not load " + path + " (" + response.status + ").");
    }
    return response.json();
  }

  function resolveDataPath(path) {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    if (path.indexOf(DATA_ROOT) === 0) {
      return path;
    }

    return DATA_ROOT + path.replace(/^\.?\//, "");
  }

  function applyFxSnapshot(latest, fx) {
    var rates = fx ? firstValue(fx.rates, fx.fxRates, fx.conversionRates) : null;
    var date = fx ? firstValue(fx.date, fx.fxDate, fx.generatedAt) : null;
    var staleFlag = Boolean(firstValue(latest.fxStale, fx && fx.stale, latest.isFxStale));

    state.fxRates = { USD: 1 };
    state.fxDate = date || null;
    state.fxUnavailable = !rates || typeof rates !== "object";

    if (rates && typeof rates === "object") {
      Object.keys(rates).forEach(function (currency) {
        var rate = Number(rates[currency]);
        if (Number.isFinite(rate) && rate > 0) {
          state.fxRates[currency.toUpperCase()] = rate;
        }
      });
    }

    state.fxStale = staleFlag || isFxDateStale(state.fxDate);
    if (state.fxUnavailable) {
      state.fxStale = true;
    }
  }

  function normalizeRows(snapshot) {
    var rawRows = Array.isArray(snapshot)
      ? snapshot
      : firstArray(snapshot.rows, snapshot.prices, snapshot.items, snapshot.data, snapshot.records);

    if (!rawRows.length) {
      return [];
    }

    return rawRows.map(function (row) {
      var unitPrice = firstNumber(
        row.usdUnitPrice,
        row.unitPriceUsd,
        row.unitPriceUSD,
        row.retailPrice,
        row.unitPrice,
        row.price
      );

      var normalizedPrice = firstNumber(
        row.usdNormalizedPrice,
        row.normalizedUsdPrice,
        row.tokenNormalizedUnitPrice,
        row.tokenNormalizedPrice,
        row.normalizedPrice
      );

      return {
        model: firstValue(row.model, row.modelName, row.modelFamily, row.productName, row.armSkuName, row.skuName, "Unknown model"),
        region: firstValue(row.region, row.location, row.armRegionName, row.regionName, "Worldwide"),
        direction: normalizeDirection(firstValue(row.direction, row.tokenDirection, row.meterName, row.meter, row.skuName, "Token")),
        unit: firstValue(row.unit, row.unitOfMeasure, row.unitMeasure, row.uom, "unit"),
        usdPrice: Number.isFinite(normalizedPrice) ? normalizedPrice : unitPrice,
        sourceUsdPrice: unitPrice
      };
    }).filter(function (row) {
      return Number.isFinite(row.usdPrice);
    }).sort(function (a, b) {
      return compareText(a.model, b.model) || compareText(a.region, b.region) || compareText(a.direction, b.direction);
    });
  }

  function populateCurrencies() {
    var currencies = Object.keys(state.fxRates).sort();
    if (currencies.indexOf("USD") === -1) {
      currencies.unshift("USD");
    } else {
      currencies = ["USD"].concat(currencies.filter(function (currency) {
        return currency !== "USD";
      }));
    }

    elements.currency.innerHTML = "";
    currencies.forEach(function (currency) {
      var option = document.createElement("option");
      option.value = currency;
      option.textContent = currency;
      elements.currency.appendChild(option);
    });

    state.selectedCurrency = "USD";
    elements.currency.value = "USD";
    elements.currency.disabled = currencies.length < 2;
  }

  function renderRows() {
    var currency = state.selectedCurrency;
    var rate = state.fxRates[currency] || 1;
    var fragment = document.createDocumentFragment();

    elements.rows.innerHTML = "";

    if (!state.rows.length) {
      var emptyRow = document.createElement("tr");
      var emptyCell = document.createElement("td");
      emptyCell.colSpan = 6;
      emptyCell.className = "empty";
      emptyCell.textContent = "No price rows were found in the current snapshot.";
      emptyRow.appendChild(emptyCell);
      elements.rows.appendChild(emptyRow);
      return;
    }

    state.rows.forEach(function (row) {
      var tr = document.createElement("tr");
      appendCell(tr, row.model);
      appendCell(tr, row.region);
      appendCell(tr, row.direction);
      appendCell(tr, row.unit);
      appendCell(tr, formatCurrency(row.usdPrice, "USD"), "numeric");
      appendCell(tr, formatCurrency(row.usdPrice * rate, currency), "numeric");
      fragment.appendChild(tr);
    });

    elements.rows.appendChild(fragment);
  }

  function renderMetadata() {
    var currency = state.selectedCurrency;

    elements.priceDate.textContent = formatDateLabel(state.priceDate);
    elements.fxDate.textContent = state.fxUnavailable ? "Unavailable" : formatDateLabel(state.fxDate);
    elements.rowCount.textContent = String(state.rows.length);
    elements.selectedHeading.textContent = currency + " price";

    if (currency === "USD") {
      elements.conversionNote.textContent = "Prices are shown in USD.";
    } else {
      elements.conversionNote.textContent = "Converted with USD-based FX rate for " + currency + ".";
    }

    renderNotice();
  }

  function renderNotice() {
    var messages = [];

    if (state.fxUnavailable) {
      messages.push("FX data is unavailable. The table is in USD only until a current FX snapshot is published.");
    } else if (state.fxStale) {
      messages.push("FX data may be stale. Converted prices use the latest available FX snapshot; use USD as the fallback reference.");
    }

    if (!messages.length) {
      elements.notice.hidden = true;
      elements.notice.className = "notice";
      elements.notice.textContent = "";
      return;
    }

    elements.notice.hidden = false;
    elements.notice.className = "notice" + (state.fxUnavailable ? " error" : "");
    elements.notice.textContent = messages.join(" ");
  }

  function showFatalError(error) {
    console.error(error);
    elements.priceDate.textContent = "Unavailable";
    elements.fxDate.textContent = "Unavailable";
    elements.rowCount.textContent = "0";
    elements.currency.disabled = true;
    elements.notice.hidden = false;
    elements.notice.className = "notice error";
    elements.notice.textContent = error.message || "Price data could not be loaded.";
    elements.rows.innerHTML = '<tr><td colspan="6" class="empty">Unable to load price snapshots.</td></tr>';
  }

  function appendCell(row, value, className) {
    var cell = document.createElement("td");
    cell.textContent = value == null || value === "" ? "Unknown" : String(value);
    if (className) {
      cell.className = className;
    }
    row.appendChild(cell);
  }

  function normalizeDirection(value) {
    var text = String(value || "").trim();
    var lower = text.toLowerCase();
    if (lower.indexOf("cached") !== -1) return "Cached input";
    if (lower.indexOf("input") !== -1) return "Input";
    if (lower.indexOf("output") !== -1) return "Output";
    if (lower.indexOf("prompt") !== -1) return "Input";
    if (lower.indexOf("completion") !== -1) return "Output";
    return text || "Token";
  }

  function formatCurrency(value, currency) {
    var maximumFractionDigits = value >= 1 ? 4 : 8;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency,
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: 0,
        maximumFractionDigits: maximumFractionDigits
      }).format(value);
    } catch (error) {
      return currency + " " + formatNumber(value, maximumFractionDigits);
    }
  }

  function formatNumber(value, maximumFractionDigits) {
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: maximumFractionDigits
    }).format(value);
  }

  function formatDateLabel(value) {
    if (!value) {
      return "Unknown";
    }

    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return date.toISOString().slice(0, 10);
  }

  function isFxDateStale(value) {
    if (!value) {
      return true;
    }

    var fxDate = new Date(value);
    if (Number.isNaN(fxDate.getTime())) {
      return true;
    }

    var today = new Date();
    var utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    var utcFxDate = Date.UTC(fxDate.getUTCFullYear(), fxDate.getUTCMonth(), fxDate.getUTCDate());
    var ageDays = Math.floor((utcToday - utcFxDate) / 86400000);
    return ageDays > MAX_FX_AGE_DAYS;
  }

  function firstArray() {
    for (var i = 0; i < arguments.length; i += 1) {
      if (Array.isArray(arguments[i])) {
        return arguments[i];
      }
    }
    return [];
  }

  function firstSnapshotObjectOrArray() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (Array.isArray(value)) {
        return value;
      }
      if (value && typeof value === "object" && hasSnapshotPayload(value)) {
        return value;
      }
    }
    return null;
  }

  function hasSnapshotPayload(value) {
    return Array.isArray(value.prices) ||
      Array.isArray(value.rows) ||
      Array.isArray(value.items) ||
      Array.isArray(value.data) ||
      Array.isArray(value.records) ||
      Boolean(value.rates || value.fxRates || value.conversionRates);
  }

  function firstNumber() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = Number(arguments[i]);
      if (Number.isFinite(value)) {
        return value;
      }
    }
    return NaN;
  }

  function firstValue() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
    return null;
  }

  function compareText(a, b) {
    return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
  }
})();
