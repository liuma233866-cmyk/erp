const { buildZhCategoryFromRuEn, normalizeCategoryLevelsWithDash } = require("./yandex-category-text");

// 从 server.js 拆出的类目知识/佣金目录归一化（纯函数）。

const YANDEX_LEGAL_RATE_URL_RU = "https://yandex.ru/legal/marketplace_crossborder_services_rate_table/ru/";

const YANDEX_LEGAL_RATE_URL_ZH = "https://yandex.ru/legal/marketplace_crossborder_services_rate_table/zh/";

function normalizeProductCategoryKnowledge(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const samples = Array.isArray(data.samples) ? data.samples : [];
  const rules = Array.isArray(data.rules) ? data.rules : [];
  const splitKeywords = (value) => {
    if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
    return String(value || "")
      .split(/[\r\n,，]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  };
  return {
    fetchedAt: String(data.fetchedAt || "").trim(),
    samples: samples
      .map((item) => ({
        id: String(item?.id || "").trim(),
        platform: String(item?.platform || "").trim().toLowerCase(),
        shopId: String(item?.shopId || "").trim(),
        titleKey: String(item?.titleKey || "").trim(),
        sourceCategoryPath: String(item?.sourceCategoryPath || "").trim(),
        categoryName: String(item?.categoryName || "").trim(),
        categoryPath: String(item?.categoryPath || "").trim(),
        brand: String(item?.brand || "").trim(),
        keywords: splitKeywords(item?.keywords),
        categoryId: Number(item?.categoryId || 0) || 0,
        count: Math.max(1, Number(item?.count || 1) || 1),
        updatedAt: String(item?.updatedAt || new Date().toISOString())
      }))
      .filter((item) => item.titleKey && item.categoryId > 0),
    rules: rules
      .map((item) => ({
        id: String(item?.id || "").trim(),
        name: String(item?.name || "").trim(),
        platform: String(item?.platform || "").trim().toLowerCase(),
        shopId: String(item?.shopId || "").trim(),
        sourceCategoryPath: String(item?.sourceCategoryPath || "").trim(),
        keywords: splitKeywords(item?.keywords || item?.keyword),
        excludedKeywords: splitKeywords(item?.excludedKeywords),
        categoryName: String(item?.categoryName || "").trim(),
        categoryPath: String(item?.categoryPath || "").trim(),
        categoryId: Number(item?.categoryId || 0) || 0,
        priority: Number(item?.priority || 50) || 50,
        enabled: item?.enabled !== false && item?.enabled !== 0 && item?.enabled !== "0" && item?.enabled !== "false",
        notes: String(item?.notes || "").trim(),
        createdAt: String(item?.createdAt || new Date().toISOString()),
        updatedAt: String(item?.updatedAt || new Date().toISOString())
      }))
      .filter((item) => item.categoryId > 0)
  };
}

function normalizeYandexCommissionCatalog(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const links = data.links && typeof data.links === "object" ? data.links : {};
  const items = Array.isArray(data.items) ? data.items : [];
  const hasCjk = (text) => /[\u3400-\u9fff]/.test(String(text || ""));
  const hasCyr = (text) => /[А-Яа-яЁё]/.test(String(text || ""));
  const latinCount = (text) => (String(text || "").match(/[A-Za-z]/g) || []).length;
  const cjkCount = (text) => (String(text || "").match(/[\u3400-\u9fff]/g) || []).length;
  const shouldReuseZh = (rawZh) => {
    const text = String(rawZh || "").trim();
    if (!text) return false;
    if (!hasCjk(text)) return false;
    if (hasCyr(text)) return false;
    if (/\|/.test(text)) return false;
    const latin = latinCount(text);
    const cjk = cjkCount(text);
    if (!cjk) return false;
    // 半中半英且英文比例高的旧数据会误判为“已翻译”，这里强制重建
    return latin <= Math.max(2, Math.floor(cjk * 0.25));
  };
  return {
    links: {
      ru: String(links.ru || YANDEX_LEGAL_RATE_URL_RU).trim() || YANDEX_LEGAL_RATE_URL_RU,
      zh: String(links.zh || YANDEX_LEGAL_RATE_URL_ZH).trim() || YANDEX_LEGAL_RATE_URL_ZH
    },
    source: String(data.source || "yandex_legal").trim() || "yandex_legal",
    warning: String(data.warning || "").trim(),
    fetchedAt: String(data.fetchedAt || "").trim(),
    itemCount: Math.max(0, Number(data.itemCount || items.length || 0) || 0),
    items: items
      .map((item) => {
        const categoryRu = normalizeCategoryLevelsWithDash(String(item?.categoryRu || "").trim());
        const categoryEn = normalizeCategoryLevelsWithDash(String(item?.categoryEn || "").trim());
        const rawZh = String(item?.categoryZh || "").trim();
        const categoryZh = shouldReuseZh(rawZh)
          ? normalizeCategoryLevelsWithDash(rawZh)
          : normalizeCategoryLevelsWithDash(buildZhCategoryFromRuEn(categoryRu, categoryEn));
        return {
          shopId: String(item?.shopId || "").trim(),
          shopName: String(item?.shopName || "").trim(),
          categoryId: String(item?.categoryId || "").trim(),
          categoryRu,
          categoryZh,
          categoryEn,
          commissionPercent: Number(item?.commissionPercent || 0) || 0,
          fetchedAt: String(item?.fetchedAt || "").trim(),
          keywords: Array.isArray(item?.keywords) ? item.keywords.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean) : []
        };
      })
      .filter((item) => item.categoryRu)
  };
}

module.exports = {
  YANDEX_LEGAL_RATE_URL_RU,
  YANDEX_LEGAL_RATE_URL_ZH,
  normalizeProductCategoryKnowledge,
  normalizeYandexCommissionCatalog
};
