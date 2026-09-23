const AI_MODES = new Set(["all", "main", "none"]);
const PRICE_STRATEGIES = new Set(["convert", "keep"]);

function normalizeCopyOptions(body = {}) {
  const aiMode = String(body.aiMode || body.ai || "all").trim().toLowerCase();
  const priceStrategy = String(body.priceStrategy || body.price || "convert").trim().toLowerCase();
  return {
    dryRun: body.dryRun === true,
    aiMode: AI_MODES.has(aiMode) ? aiMode : "all",
    priceStrategy: PRICE_STRATEGIES.has(priceStrategy) ? priceStrategy : "convert",
    overwriteTitleDescription: body.overwriteTitleDescription !== false
  };
}

function isExchangeRateFresh(rateDate, now = new Date(), maxAgeDays = 3) {
  const date = new Date(`${String(rateDate || "").slice(0, 10)}T00:00:00Z`);
  if (!String(rateDate || "").trim() || !Number.isFinite(date.getTime())) return false;
  const ageDays = (new Date(now).getTime() - date.getTime()) / 86400000;
  return ageDays >= -1 && ageDays <= Math.max(0, Number(maxAgeDays) || 0);
}

module.exports = { isExchangeRateFresh, normalizeCopyOptions };
