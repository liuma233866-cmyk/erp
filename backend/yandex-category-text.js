// 从 server.js 拆出的 Yandex 类目文本解析与索引构建（纯函数，无共享状态）。

const CATEGORY_MATCH_STOP_WORDS = new Set([
  "для",
  "the",
  "and",
  "with",
  "или",
  "это",
  "что",
  "товар",
  "товары",
  "на",
  "в",
  "по",
  "из",
  "к",
  "за",
  "a",
  "an",
  "of",
  "to",
  "for",
  "и",
  "или",
  "с",
  "без",
  "набор",
  "комплект",
  "шт"
]);

function buildProductMatchKey(item, index) {
  const key = String(item?.__key || item?.publish_id || item?.publishId || item?.offerId || item?.product_id || item?.productId || "").trim();
  return key || `row-${index}`;
}

function normalizeCategoryMatchText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeCategoryMatchText(text) {
  const normalized = normalizeCategoryMatchText(text);
  const raw = normalized.match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (const token of raw) {
    const t = String(token || "").trim();
    if (t.length < 2) continue;
    if (CATEGORY_MATCH_STOP_WORDS.has(t)) continue;
    out.push(t);
    if (t.length >= 6) {
      const stem = t.slice(0, 5);
      if (!CATEGORY_MATCH_STOP_WORDS.has(stem)) out.push(stem);
    }
  }
  return Array.from(new Set(out));
}

function getCategoryNodeChildren(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node.children)) return node.children;
  if (Array.isArray(node.categories)) return node.categories;
  if (Array.isArray(node.subCategories)) return node.subCategories;
  if (Array.isArray(node.subcategories)) return node.subcategories;
  return [];
}

function getYandexCategoryTreeRoot(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) return { id: 0, name: "", children: payload };
  if (Array.isArray(payload.categories)) return { id: 0, name: "", children: payload.categories };
  if (Array.isArray(payload.children)) return payload;
  const result = payload.result;
  if (result && typeof result === "object") {
    if (Array.isArray(result)) return { id: 0, name: "", children: result };
    if (Array.isArray(result.categories)) return { id: 0, name: "", children: result.categories };
    if (Array.isArray(result.children)) return result;
    if (result.category && typeof result.category === "object") return result.category;
  }
  return null;
}

function getYandexCategoryListItems(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.categories)) return payload.categories;
  if (Array.isArray(payload.result?.categories)) return payload.result.categories;
  if (Array.isArray(payload.result)) return payload.result;
  if (Array.isArray(payload.data?.categories)) return payload.data.categories;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function buildYandexCategoryIndexFromList(items) {
  const source = Array.isArray(items) ? items : [];
  const byRawId = new Map();
  const childCount = new Map();
  for (const item of source) {
    const id = Number(item?.id || item?.categoryId || item?.hid || 0) || 0;
    if (!(id > 0)) continue;
    const name = String(item?.name || item?.fullName || item?.title || "").trim();
    if (!name) continue;
    const parentId = Number(item?.parentId || item?.parent?.id || item?.parentCategoryId || 0) || 0;
    byRawId.set(id, { id, name, parentId, fullPath: String(item?.fullName || item?.path || item?.pathText || "").trim() });
    if (parentId > 0) childCount.set(parentId, (childCount.get(parentId) || 0) + 1);
  }
  if (!byRawId.size) return { leaves: [], byId: new Map(), tokenMap: new Map() };

  const resolvePath = (id) => {
    const chain = [];
    const seen = new Set();
    let cur = byRawId.get(id) || null;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur.name);
      cur = cur.parentId > 0 ? byRawId.get(cur.parentId) || null : null;
    }
    return chain.reverse().join(" > ");
  };

  const leaves = [];
  const byId = new Map();
  const tokenMap = new Map();
  const rows = Array.from(byRawId.values());
  const useRows = rows.filter((x) => (childCount.get(x.id) || 0) === 0);
  const pick = useRows.length ? useRows : rows;
  for (const row of pick) {
    const pathText = row.fullPath || resolvePath(row.id) || row.name;
    const nameNorm = normalizeCategoryMatchText(row.name);
    const tokens = Array.from(new Set(tokenizeCategoryMatchText(pathText)));
    const record = {
      id: row.id,
      name: row.name,
      pathText,
      nameNorm,
      tokens,
      tokenWeight: tokens.reduce((sum, t) => sum + t.length, 0)
    };
    byId.set(row.id, record);
    const idx = leaves.length;
    leaves.push(record);
    for (const token of tokens) {
      let set = tokenMap.get(token);
      if (!set) {
        set = new Set();
        tokenMap.set(token, set);
      }
      set.add(idx);
    }
  }
  return { leaves, byId, tokenMap };
}

function buildYandexCategoryIndexFromTree(root) {
  const leaves = [];
  const byId = new Map();
  const tokenMap = new Map();

  const visit = (node, parentPath = []) => {
    if (!node || typeof node !== "object") return;
    const id = Number(node.id || node.categoryId || node.hid || 0) || 0;
    const name = String(node.name || node.fullName || node.title || "").trim();
    const children = getCategoryNodeChildren(node);
    const pathArr = name ? [...parentPath, name] : [...parentPath];

    if (id > 0 && name) {
      const pathText = pathArr.join(" > ");
      const nameNorm = normalizeCategoryMatchText(name);
      const tokens = Array.from(new Set(tokenizeCategoryMatchText(pathText)));
      const record = {
        id,
        name,
        pathText,
        nameNorm,
        tokens,
        tokenWeight: tokens.reduce((sum, t) => sum + t.length, 0)
      };
      byId.set(id, record);
      if (!children.length) {
        const idx = leaves.length;
        leaves.push(record);
        for (const token of tokens) {
          let set = tokenMap.get(token);
          if (!set) {
            set = new Set();
            tokenMap.set(token, set);
          }
          set.add(idx);
        }
      }
    }

    for (const child of children) {
      visit(child, pathArr);
    }
  };

  visit(root, []);
  return { leaves, byId, tokenMap };
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeCommissionKeyword(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s|>\-\/→›»]+/gu, " ")
    .replace(/\b(all items|все товары)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupCommissionCategoryText(text) {
  const raw = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";
  const parts = raw
    .split(/\s*\|\s*|\s*-\s*|\s*>\s*|\s*\/\s*/g)
    .map((p) => p.trim())
    .filter(Boolean);
  const deduped = [];
  const seen = new Set();
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }
  return deduped.join("-").slice(0, 320);
}

function normalizeCategoryLevelsWithDash(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const parts = raw
    .split(/\s*\|\s*|\s*-\s*|\s*>\s*|\s*\/\s*|\s*→\s*|\s*›\s*|\s*»\s*/g)
    .map((x) => x.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join("-").slice(0, 320);
}

function latinCharCount(text) {
  const m = String(text || "").match(/[A-Za-z]/g);
  return m ? m.length : 0;
}

function cyrillicCharCount(text) {
  const m = String(text || "").match(/[А-Яа-яЁё]/g);
  return m ? m.length : 0;
}

function pickDominantSegmentByScript(text, script = "latin") {
  const source = String(text || "");
  const segments = source.split(/\s*\|\s*/g).map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return source.trim();
  let best = segments[0];
  let bestScore = -1;
  for (const seg of segments) {
    const score = script === "latin" ? latinCharCount(seg) : cyrillicCharCount(seg);
    if (score > bestScore) {
      bestScore = score;
      best = seg;
    }
  }
  return best;
}

function extractEnglishCategoryPath(text) {
  const picked = pickDominantSegmentByScript(text, "latin");
  const latinWords = String(picked || "").match(/[A-Za-z][A-Za-z0-9'&/+\-]*/g) || [];
  const normalized = latinWords.join(" ");
  return cleanupCommissionCategoryText(normalized || picked);
}

function extractRussianCategoryPath(text) {
  const picked = pickDominantSegmentByScript(text, "cyrillic");
  const normalized = cleanupCommissionCategoryText(picked);
  return normalizeCategoryLevelsWithDash(normalized || picked);
}

function buildZhCategoryFromRuEn(ru, en) {
  const ruText = cleanupCommissionCategoryText(String(ru || "").trim());
  const enText = cleanupCommissionCategoryText(String(en || "").trim());
  const sourceText = enText || ruText;
  if (!sourceText) return "";

  const enMap = [
    [/\ball products\b/gi, "全部商品"],
    [/\ball items\b/gi, "全部商品"],
    [/\bvehicle\b/gi, "汽车"],
    [/\bauto\b/gi, "汽车"],
    [/\bautomotive\b/gi, "汽车"],
    [/\baudio and video equipment\b/gi, "音视频设备"],
    [/\bcar acoustics\b/gi, "车载音响"],
    [/\bcar speakers?\b/gi, "车载扬声器"],
    [/\bcar subwoofers?\b/gi, "车载低音炮"],
    [/\bfm transmitters?\b/gi, "FM发射器"],
    [/\btransition(al)? frameworks?\b/gi, "过渡框架"],
    [/\bisolation\b/gi, "隔音"],
    [/\bcabin fresheners?\b/gi, "车内香氛"],
    [/\bcar flavors?\b/gi, "车用香薰"],
    [/\baccessories for car interior fragrance\b/gi, "车内香氛配件"],
    [/\bbody care products\b/gi, "车身护理用品"],
    [/\bcar body\b/gi, "车身"],
    [/\bcar body coverings?\b/gi, "车身覆盖层"],
    [/\bpolishes?\b/gi, "抛光剂"],
    [/\bpastes?\b/gi, "膏体"],
    [/\babrasive and polishing pastes?\b/gi, "研磨抛光膏"],
    [/\bkits?\b/gi, "套装"],
    [/\bantennas?\b/gi, "天线"],
    [/\baccessories\b/gi, "配件"],
    [/spare parts/gi, "配件"],
    [/body parts/gi, "车身件"],
    [/accessories and equipment/gi, "配件与设备"],
    [/automotive chemicals and cosmetics/gi, "汽车化学品与美容"],
    [/motor vehicles/gi, "摩托车"],
    [/equipment and protection/gi, "装备与防护"],
    [/luggage systems/gi, "行李系统"],
    [/interior design/gi, "内饰"],
    [/emergency supplies/gi, "应急用品"],
    [/suspension/gi, "悬挂"],
    [/batteries/gi, "电池"],
    [/headlight/gi, "大灯"],
    [/xenon/gi, "氙气灯"],
    [/shock absorbers?/gi, "减震器"],
    [/steering wheel/gi, "方向盘"],
    [/wheels?/gi, "车轮"],
    [/transmission/gi, "传动系统"],
    [/waxes?/gi, "蜡"],
    [/sets and kits/gi, "套装"],
    [/towbars?/gi, "拖车钩"],
    [/warning triangles?/gi, "三角警示牌"],
    [/seat covers?/gi, "座椅套"],
    [/rugs?/gi, "脚垫"],
    [/windshield washer fluid/gi, "玻璃水"]
  ];

  const ruMap = [
    [/все товары/gi, "全部商品"],
    [/автохимия/gi, "汽车化学品"],
    [/автокосметика/gi, "汽车美容"],
    [/средства для ухода за кузовом/gi, "车身护理用品"],
    [/воски/gi, "蜡"],
    [/строительство и ремонт/gi, "施工和维修"],
    [/инструменты/gi, "工具"],
    [/ручной инструмент/gi, "手工具"],
    [/электроинструмент/gi, "电动工具"],
    [/измерительные инструменты/gi, "测量工具"],
    [/сантехника/gi, "卫浴管道"],
    [/комплектующие/gi, "配件"],
    [/материалы/gi, "材料"],
    [/напольные покрытия/gi, "地板覆盖物"],
    [/освещение/gi, "照明"],
    [/бытовая техника/gi, "家用电器"],
    [/электроника/gi, "电子产品"],
    [/компьютеры/gi, "电脑"],
    [/ноутбуки/gi, "笔记本电脑"],
    [/смартфоны/gi, "智能手机"],
    [/аксессуары/gi, "配件"],
    [/одежда/gi, "服装"],
    [/обувь/gi, "鞋靴"],
    [/дом и сад/gi, "家居与花园"],
    [/детские товары/gi, "母婴用品"],
    [/зоотовары/gi, "宠物用品"],
    [/красота и здоровье/gi, "美妆与健康"],
    [/спорт и отдых/gi, "运动与休闲"],
    [/авто/gi, "汽车"],
    [/аудио/gi, "音频"],
    [/видео/gi, "视频"],
    [/видеотехника/gi, "视频设备"],
    [/автоакустика/gi, "车载音响"],
    [/колонки автомобильные/gi, "车载扬声器"],
    [/сабвуферы автомобильные/gi, "车载低音炮"],
    [/fm-трансмиттеры/gi, "FM发射器"],
    [/переходные рамки/gi, "过渡框架"],
    [/изоляция/gi, "隔音"],
    [/ароматизаторы салона/gi, "车内香氛"],
    [/полироли и пасты для кузова/gi, "车身抛光剂和膏体"],
    [/абразивные и полировальные пасты/gi, "研磨抛光膏"],
    [/покрытия для кузова автомобиля/gi, "车身覆盖层"],
    [/автомагнитолы/gi, "车载收音机"],
    [/антенны автомобильные/gi, "车载天线"],
    [/антенны/gi, "天线"],
    [/комплектующие для автоантенн/gi, "车载天线配件"],
    [/усилители/gi, "功放"],
    [/адаптеры/gi, "适配器"],
    [/переходники/gi, "转接头"],
    [/разъемы/gi, "连接器"],
    [/для аудиотехники/gi, "用于音频设备"],
    [/аксессуары для аудио и видеотехники/gi, "音视频设备配件"],
    [/аудиопроцессоры/gi, "音频处理器"],
    [/дистрибьютеры питания/gi, "电源分配器"],
    [/кабели для автоаудиотехники/gi, "车载音频线缆"],
    [/конденсаторы для автоаудиотехники/gi, "车载音频电容"],
    [/контроллеры и пульты для автоаудиотехники/gi, "车载音频控制器和遥控器"]
  ];

  const applyRules = (input, rules) => {
    let out = String(input || "");
    for (const [re, zh] of rules) out = out.replace(re, zh);
    return out.trim();
  };
  const latinCount = (s) => (String(s || "").match(/[A-Za-z]/g) || []).length;
  const cjkCount = (s) => (String(s || "").match(/[\u3400-\u9fff]/g) || []).length;
  const cyrCount = (s) => (String(s || "").match(/[А-Яа-яЁё]/g) || []).length;

  const ruSeg = normalizeCategoryLevelsWithDash(ruText).split("-").map((x) => x.trim()).filter(Boolean);
  const enSeg = normalizeCategoryLevelsWithDash(enText).split("-").map((x) => x.trim()).filter(Boolean);
  const count = Math.max(ruSeg.length, enSeg.length);
  const outSeg = [];
  for (let i = 0; i < count; i += 1) {
    const r = ruSeg[i] || "";
    const e = enSeg[i] || "";
    const fromEn = e ? applyRules(e, enMap) : "";
    const fromRu = r ? applyRules(r, ruMap) : "";
    let chosen = fromEn || fromRu || e || r;
    if (latinCount(chosen) > 2 && cjkCount(fromRu) > 0) chosen = fromRu;
    if (latinCount(chosen) > 2 && cjkCount(fromEn) > 0) chosen = fromEn;
    if (cyrCount(chosen) > 0) {
      const ruClean = r ? applyRules(r, ruMap) : "";
      if (ruClean && cyrCount(ruClean) < cyrCount(chosen)) chosen = ruClean;
      if (cyrCount(chosen) > 0 && fromEn && cjkCount(fromEn) > 0 && cyrCount(fromEn) === 0) chosen = fromEn;
      if (cyrCount(chosen) > 0) {
        const dropped = String(chosen).replace(/[А-Яа-яЁё]+/g, " ").replace(/\s+/g, " ").trim();
        if (dropped) chosen = dropped;
      }
    }
    if (!chosen) continue;
    outSeg.push(chosen);
  }

  const normalized = normalizeCategoryLevelsWithDash(outSeg.join("-"))
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .trim();
  return normalized.slice(0, 320);
}

function buildCommissionKeywords(entry) {
  const base = [
    ...tokenizeCategoryMatchText(String(entry.categoryRu || "")),
    ...tokenizeCategoryMatchText(String(entry.categoryEn || "")),
    ...tokenizeCategoryMatchText(String(entry.categoryZh || ""))
  ];
  return Array.from(new Set(base.filter((t) => t.length >= 2)));
}

function parseYandexLegalCommissionCatalogFromHtml(html) {
  const stripped = decodeHtmlEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
  );
  const text = ` ${stripped} `;
  const re = /([А-Яа-яЁё][^%]{12,220}?)\s(\d{1,2},\d{2})%\s([A-Za-z][^%]{12,220}?)\s\2%/g;
  const dedupe = new Map();
  let m;
  while ((m = re.exec(text))) {
    const categoryRuRaw = extractRussianCategoryPath(normalizeCommissionKeyword(m[1]));
    const categoryEnRaw = extractEnglishCategoryPath(normalizeCommissionKeyword(m[3]));
    const commissionPercent = Number(String(m[2] || "").replace(",", ".")) || 0;
    if (!categoryRuRaw || !categoryEnRaw || !(commissionPercent > 0)) continue;
    const categoryRu = categoryRuRaw.slice(0, 320);
    const categoryEn = categoryEnRaw.slice(0, 320);
    const categoryZh = buildZhCategoryFromRuEn(categoryRu, categoryEn).slice(0, 360);
    const key = `${categoryRu}|${commissionPercent.toFixed(2)}`;
    if (dedupe.has(key)) continue;
    dedupe.set(key, {
      categoryRu,
      categoryZh,
      categoryEn,
      commissionPercent,
      keywords: []
    });
  }

  const items = Array.from(dedupe.values()).map((item) => ({
    ...item,
    keywords: buildCommissionKeywords(item)
  }));
  return items;
}

// 从 server.js 拆出的 Yandex 类目匹配。

const CATEGORY_MATCH_AMBIGUOUS_TOKENS = new Set([
  "питание",
  "питания",
  "блок",
  "аксессуары",
  "средства",
  "обеспечения",
  "назначения",
  "специального",
  "разное",
  "прочее",
  "прочие",
  "другое"
]);

function matchProductToYandexCategory(product, categoryIndex) {
  const index = categoryIndex || {};
  if (!Array.isArray(index.leaves) || !index.leaves.length) return null;
  const text = normalizeCategoryMatchText(`${product?.title || ""} ${product?.description || ""}`);
  const tokens = tokenizeCategoryMatchText(text);
  if (!tokens.length) return null;
  const tokenSet = new Set(tokens);
  const candidateScores = new Map();
  const candidateOverlap = new Map();

  for (const token of tokenSet) {
    const idxSet = index.tokenMap?.get(token);
    if (!idxSet || !idxSet.size) continue;
    const tokenWeight = CATEGORY_MATCH_AMBIGUOUS_TOKENS.has(token) ? 1 : Math.min(8, Math.max(1, token.length - 1));
    for (const idx of idxSet) {
      candidateScores.set(idx, (candidateScores.get(idx) || 0) + tokenWeight);
      candidateOverlap.set(idx, (candidateOverlap.get(idx) || 0) + 1);
    }
  }

  if (!candidateScores.size) return null;
  const topCandidates = Array.from(candidateScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 400);

  let best = null;
  let bestScore = 0;
  for (const [idx, baseScore] of topCandidates) {
    const category = index.leaves[idx];
    if (!category) continue;
    const overlapCount = candidateOverlap.get(idx) || 0;
    let score = baseScore;
    if (category.nameNorm && text.includes(category.nameNorm)) score += 18;
    if (overlapCount < 2 && !(category.nameNorm && text.includes(category.nameNorm))) continue;
    let overlapStrict = 0;
    let strictCount = 0;
    for (const t of category.tokens) {
      if (tokenSet.has(t)) {
        const base = CATEGORY_MATCH_AMBIGUOUS_TOKENS.has(t) ? 1 : Math.min(10, t.length + 1);
        score += base;
        if (!CATEGORY_MATCH_AMBIGUOUS_TOKENS.has(t)) overlapStrict += 1;
      }
      if (!CATEGORY_MATCH_AMBIGUOUS_TOKENS.has(t)) {
        strictCount += 1;
      }
    }
    if (strictCount >= 3 && overlapStrict / strictCount < 0.22 && !(category.nameNorm && text.includes(category.nameNorm))) continue;
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }

  if (!best || bestScore < 8) return null;
  const confidence = Math.min(1, bestScore / Math.max(24, best.tokenWeight + 20));
  return {
    categoryId: best.id,
    name: best.name,
    pathText: best.pathText,
    confidence: Number(confidence.toFixed(4))
  };
}

module.exports = {
  buildCommissionKeywords,
  buildProductMatchKey,
  buildYandexCategoryIndexFromList,
  buildYandexCategoryIndexFromTree,
  buildZhCategoryFromRuEn,
  cleanupCommissionCategoryText,
  cyrillicCharCount,
  decodeHtmlEntities,
  extractEnglishCategoryPath,
  extractRussianCategoryPath,
  getCategoryNodeChildren,
  getYandexCategoryListItems,
  getYandexCategoryTreeRoot,
  latinCharCount,
  normalizeCategoryLevelsWithDash,
  normalizeCategoryMatchText,
  normalizeCommissionKeyword,
  matchProductToYandexCategory,
  parseYandexLegalCommissionCatalogFromHtml,
  pickDominantSegmentByScript,
  tokenizeCategoryMatchText
};
