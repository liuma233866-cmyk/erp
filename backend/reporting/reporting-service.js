"use strict";
// 报表 / 费率 / 审计洞察域。
//
// 从 server.js 拆出三块互相独立的聚合逻辑：
//   1. getRecentAuditIssues       —— 审计日志里"近期有问题"的条目（仪表盘/日志页用）
//   2. refreshOrderProfitSnapshots —— 启动时按最新汇率与审核规则回填订单利润快照
//   3. CBR 汇率读取（内存缓存 → 实时拉取 → exchange_rates_daily 兜底）
// 依赖全部通过 createReportingService(deps) 注入，模块本身不直连 MySQL/网络。
//
// 行为与原实现保持一致，注入点：
//   db / sqlReady / sqlPool / sqlWriters / console.error / 各纯函数与常量。

function createReportingService(deps = {}) {
  const {
    getDb,
    isSqlReady = () => false,
    getSqlPool = () => null,
    sqlWriters = {},
    logError = (message) => console.error(message),
    fetchJson,
    normalizeNullableNumber,
    isExchangeRateFresh,
    findMatchingReviewRule,
    computeOrderProfit,
    deriveRates,
    cbrDailyJsonUrl,
    currencyRateMaxAgeDays = 3
  } = deps;

  if (typeof getDb !== "function") throw new TypeError("createReportingService requires getDb");

  // CBR 响应的进程内缓存（30 分钟），原先散落在 server.js 顶层。
  let cachedRates = { ts: 0, payload: null };

  function getRecentAuditIssues(hours = 24) {
    const db = getDb();
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return (db.auditLogs || []).filter((item) => {
      const ts = new Date(item.ts).getTime();
      if (!Number.isFinite(ts) || ts < cutoff) return false;
      return !item.success || String(item.warningMessage || "").trim();
    });
  }

  async function refreshOrderProfitSnapshots() {
    const db = getDb();
    if (!isSqlReady() || !getSqlPool()) return 0;
    let rubPurchaseCostRate = 0;
    let cnyRateRub = 0;
    try {
      const [rows] = await getSqlPool().query(
        `SELECT cnyRateRub, rubPurchaseCostRate
         FROM exchange_rates_daily
         WHERE (cnyRateRub IS NOT NULL AND cnyRateRub > 0) OR (rubPurchaseCostRate IS NOT NULL AND rubPurchaseCostRate > 0)
         ORDER BY rateDate DESC
         LIMIT 1`
      );
      const row = rows?.[0];
      cnyRateRub = normalizeNullableNumber(row?.cnyRateRub) || 0;
      rubPurchaseCostRate = normalizeNullableNumber(row?.rubPurchaseCostRate) || 0;
    } catch (error) {
      logError(`Order profit refresh: exchange rates unavailable: ${String(error)}`);
      return 0;
    }

    const rates = deriveRates(rubPurchaseCostRate, cnyRateRub);
    const rules = Array.isArray(db.reviewRules) ? db.reviewRules : [];
    const now = new Date().toISOString();
    let changed = 0;
    for (const order of Array.isArray(db.orders) ? db.orders : []) {
      const rule = findMatchingReviewRule(order, rules);
      if (!rule) continue;
      if (normalizeNullableNumber(order?.amount) === null) continue;
      if (order.profitUpdatedAt) continue;
      const profit = computeOrderProfit(order, rule, rates);
      order.profitRmb = profit.profitRmb;
      order.profitRub = profit.profitRub;
      order.profitUpdatedAt = now;
      Object.assign(order, {
        matchedRuleId: profit.matchedRuleId,
        matchedRuleName: profit.matchedRuleName,
        purchaseCostRmb: profit.purchaseCostRmb,
        purchaseCostRub: profit.purchaseCostRub,
        commissionPercent: profit.commissionPercent,
        commissionRmb: profit.commissionRmb,
        commissionRub: profit.commissionRub,
        logisticsFeeRmb: profit.logisticsFeeRmb,
        logisticsFeeRub: profit.logisticsFeeRub,
        otherFeeRmb: profit.otherFeeRmb,
        otherFeeRub: profit.otherFeeRub,
        packingFeeRmb: profit.packingFeeRmb,
        packingFeeRub: profit.packingFeeRub,
        withdrawPercent: profit.withdrawPercent,
        withdrawFeeRmb: profit.withdrawFeeRmb,
        withdrawFeeRub: profit.withdrawFeeRub,
        transferPercent: profit.transferPercent,
        transferFeeRmb: profit.transferFeeRmb,
        transferFeeRub: profit.transferFeeRub
      });
      changed += 1;
    }
    if (changed > 0 && typeof sqlWriters.saveOrdersToSql === "function") {
      await sqlWriters.saveOrdersToSql(db.orders);
    }
    return changed;
  }

  function mapCbrRate(payload, currency) {
    if (!payload || !payload.Valute || !payload.Valute[currency]) {
      return { ok: false, status: 404, message: `Currency ${currency} not found` };
    }
    const item = payload.Valute[currency];
    const value = Number(item.Value);
    const nominal = Number(item.Nominal || 1);
    if (!Number.isFinite(value) || !Number.isFinite(nominal) || nominal <= 0) {
      return { ok: false, status: 500, message: "Invalid rate data" };
    }
    const rate = value / nominal;
    return {
      ok: true,
      data: {
        base: "RUB",
        currency,
        rate,
        date: payload.Date || payload.Timestamp || ""
      }
    };
  }

  async function fetchStoredCbrRate(currency) {
    if (String(currency || "").trim().toUpperCase() !== "CNY" || !isSqlReady() || !getSqlPool()) {
      return { ok: false, status: 404, message: "Stored CBR rate unavailable" };
    }
    try {
      const [rows] = await getSqlPool().query(
        `SELECT rateDate, cnyRateRub, source
         FROM exchange_rates_daily
         WHERE cnyRateRub IS NOT NULL AND cnyRateRub > 0
         ORDER BY rateDate DESC
         LIMIT 1`
      );
      const row = rows?.[0];
      const rate = normalizeNullableNumber(row?.cnyRateRub);
      if (rate !== null && rate > 0) {
        const rateDate = String(row.rateDate || "");
        const stale = !isExchangeRateFresh(rateDate, new Date(), currencyRateMaxAgeDays);
        return {
          ok: true,
          stale,
          warning: stale ? `Stored CBR rate is older than ${currencyRateMaxAgeDays} days` : "",
          data: {
            base: "RUB",
            currency: "CNY",
            rate,
            date: rateDate,
            source: String(row.source || "exchange_rates_daily")
          }
        };
      }
    } catch (error) {
      logError(`MySQL CBR snapshot unavailable: ${String(error)}`);
    }
    return { ok: false, status: 404, message: "Stored CBR rate unavailable" };
  }

  async function fetchCbrRate(currency) {
    const now = Date.now();
    if (cachedRates.payload && now - cachedRates.ts < 30 * 60 * 1000) {
      return mapCbrRate(cachedRates.payload, currency);
    }

    try {
      const result = await fetchJson(cbrDailyJsonUrl);
      if (!result.ok || !result.data) {
        const stored = await fetchStoredCbrRate(currency);
        return stored.ok ? stored : { ok: false, status: result.status, message: "Failed to fetch CBR rates" };
      }
      cachedRates = { ts: now, payload: result.data };
      return mapCbrRate(result.data, currency);
    } catch (error) {
      const stored = await fetchStoredCbrRate(currency);
      return stored.ok ? stored : { ok: false, status: 502, message: String(error) };
    }
  }

  async function fetchRubPurchaseCostRate() {
    if (isSqlReady() && getSqlPool()) {
      try {
        const [rows] = await getSqlPool().query(
          `SELECT rateDate, rubPurchaseCostRate, source
           FROM exchange_rates_daily
           WHERE rubPurchaseCostRate IS NOT NULL AND rubPurchaseCostRate > 0
           ORDER BY rateDate DESC
           LIMIT 1`
        );
        const row = rows?.[0];
        const rate = normalizeNullableNumber(row?.rubPurchaseCostRate);
        if (rate !== null && rate > 0) {
          return {
            ok: true,
            data: {
              rate,
              date: String(row.rateDate || ""),
              source: String(row.source || "exchange_rates_daily")
            }
          };
        }
      } catch (error) {
        logError(`MySQL exchange_rates_daily unavailable: ${String(error)}`);
      }
    }

    const cbr = await fetchCbrRate("CNY");
    const cnyRateRub = normalizeNullableNumber(cbr?.data?.rate);
    if (cbr.ok && cnyRateRub !== null && cnyRateRub > 0) {
      return {
        ok: true,
        data: {
          rate: 1 / cnyRateRub,
          date: String(cbr.data.date || ""),
          source: "cbr-derived"
        }
      };
    }
    return { ok: false, status: 502, message: "RUB purchase cost rate unavailable" };
  }

  return {
    getRecentAuditIssues,
    refreshOrderProfitSnapshots,
    fetchCbrRate,
    fetchStoredCbrRate,
    fetchRubPurchaseCostRate,
    mapCbrRate
  };
}

module.exports = { createReportingService };
