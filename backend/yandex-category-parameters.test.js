// Unit tests for the Yandex category content-parameter helpers.
//
// These decide two things that previously had no answer anywhere in the project:
// which parameters a category marks as required, and whether a product's attribute
// bag satisfies them.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildParameterLookup,
  findParameterForKey,
  normalizeCategoryParameter,
  normalizeCategoryParameters,
  normalizeParameterKey,
  summarizeValidation,
  validateProductAgainstParameters
} = require("./yandex-category-parameters");

function parameter(overrides = {}) {
  return {
    id: 1,
    name: "Цвет",
    type: "ENUM",
    required: false,
    allowCustomValues: true,
    recommendationTypes: [],
    values: [],
    constraints: {},
    valueRestrictions: [],
    ...overrides
  };
}

test("normalizeCategoryParameter keeps the required flag, allowed values and constraints", () => {
  const normalized = normalizeCategoryParameter({
    id: 10,
    name: "Цвет",
    description: "Цвет товара",
    type: "ENUM",
    required: true,
    distinctive: true,
    multivalue: true,
    allowCustomValues: false,
    recommendationTypes: ["HAS_VIDEO", "HAS_VIDEO", ""],
    unit: { defaultUnitId: 5 },
    values: [{ id: 1, value: "красный" }, { id: 2, value: "синий" }, { id: 1, value: "красный" }],
    constraints: { minValue: 1, maxValue: 10, maxLength: 20 },
    valueRestrictions: [{ limitingParameterId: 3, limitedValues: ["a"] }]
  });

  assert.equal(normalized.id, 10);
  assert.equal(normalized.required, true);
  assert.equal(normalized.distinctive, true);
  assert.equal(normalized.multivalue, true);
  assert.equal(normalized.allowCustomValues, false);
  assert.equal(normalized.unitId, 5);
  assert.deepEqual(normalized.recommendationTypes, ["HAS_VIDEO"], "duplicates are dropped");
  assert.deepEqual(normalized.values.map((option) => option.value), ["красный", "синий"]);
  assert.deepEqual(normalized.constraints, { minValue: 1, maxValue: 10, maxLength: 20 });
  assert.deepEqual(normalized.valueRestrictions, [{ limitingParameterId: 3, limitedValues: ["a"] }]);
});

test("normalizeCategoryParameter defaults allowCustomValues to true and required to false", () => {
  const normalized = normalizeCategoryParameter({ id: 3, name: "Материал" });
  assert.equal(normalized.allowCustomValues, true);
  assert.equal(normalized.required, false);
  assert.equal(normalized.type, "TEXT");
  assert.deepEqual(normalized.recommendationTypes, []);
  assert.deepEqual(normalized.valueRestrictions, []);
});

test("normalizeCategoryParameter rejects entries without a usable id or name", () => {
  assert.equal(normalizeCategoryParameter({ name: "no id" }), null);
  assert.equal(normalizeCategoryParameter({ id: 0, name: "zero id" }), null);
  assert.equal(normalizeCategoryParameter({ id: 5 }), null);
  assert.equal(normalizeCategoryParameter(null), null);
});

test("normalizeCategoryParameter flattens alternative value containers", () => {
  const normalized = normalizeCategoryParameter({ id: 7, name: "Сезон", values: { values: [{ value: "лето" }] } });
  assert.deepEqual(normalized.values.map((option) => option.value), ["лето"]);
});

test("normalizeCategoryParameters drops duplicates and unusable entries", () => {
  const list = normalizeCategoryParameters([
    parameter({ id: 1 }),
    parameter({ id: 1, name: "Дубликат" }),
    parameter({ id: 2, name: "Материал" }),
    { name: "no id" },
    null
  ]);
  assert.deepEqual(list.map((entry) => entry.id), [1, 2]);
  assert.equal(list[0].name, "Цвет", "the first entry wins");
});

test("normalizeParameterKey lowercases, folds ё and strips punctuation", () => {
  assert.equal(normalizeParameterKey("  Цвет, товара!  "), "цвет товара");
  assert.equal(normalizeParameterKey("Объём"), "объем");
  assert.equal(normalizeParameterKey(""), "");
});

test("findParameterForKey matches exactly first, then by containment", () => {
  const parameters = normalizeCategoryParameters([
    parameter({ id: 1, name: "Цвет" }),
    parameter({ id: 2, name: "Цвет товара" })
  ]);
  const lookup = buildParameterLookup(parameters);

  assert.equal(findParameterForKey("Цвет", lookup).id, 1, "exact match wins");
  assert.equal(findParameterForKey("цвет товара", lookup).id, 2);
  // Punctuation and case do not matter.
  assert.equal(findParameterForKey("ЦВЕТ!", lookup).id, 1);
});

test("findParameterForKey matches by parameter id and returns null when unsure", () => {
  const parameters = normalizeCategoryParameters([parameter({ id: 42, name: "Цвет" })]);
  const lookup = buildParameterLookup(parameters);
  assert.equal(findParameterForKey("42", lookup).id, 42);
  assert.equal(findParameterForKey("совершенно другое", lookup), null);
  assert.equal(findParameterForKey("", lookup), null);
});

test("validateProductAgainstParameters reports what a product is missing", () => {
  const parameters = normalizeCategoryParameters([
    parameter({ id: 1, name: "Цвет", required: true }),
    parameter({ id: 2, name: "Материал", required: true }),
    parameter({ id: 3, name: "Бренд", required: false, recommendationTypes: ["HAS_DESCRIPTION"] }),
    parameter({ id: 4, name: "Вес", required: false })
  ]);

  const result = validateProductAgainstParameters(parameters, { "Цвет": "красный" });
  assert.equal(result.requiredTotal, 2);
  assert.equal(result.filledRequired, 1);
  assert.deepEqual(result.missingRequired.map((entry) => entry.name), ["Материал"]);
  assert.deepEqual(result.missingRecommended.map((entry) => entry.name), ["Бренд"]);
  assert.equal(result.readiness, 50);
});

test("validateProductAgainstParameters reports attribute keys it could not match", () => {
  const parameters = normalizeCategoryParameters([parameter({ id: 1, name: "Цвет", required: true })]);
  const result = validateProductAgainstParameters(parameters, { "Цвет": "красный", "颜色备注": "偏深" });
  assert.deepEqual(result.unmatchedAttributeKeys, ["颜色备注"]);
  assert.deepEqual(result.missingRequired, []);
  assert.equal(result.readiness, 100);
});

test("validateProductAgainstParameters ignores empty attribute values", () => {
  const parameters = normalizeCategoryParameters([parameter({ id: 1, name: "Цвет", required: true })]);
  const result = validateProductAgainstParameters(parameters, { "Цвет": "   ", "Материал": "" });
  assert.equal(result.filledRequired, 0);
  assert.equal(result.missingRequired.length, 1);
  assert.equal(result.readiness, 0);
});

test("validateProductAgainstParameters treats an array value as filled when any entry has text", () => {
  const parameters = normalizeCategoryParameters([parameter({ id: 1, name: "Цвет", required: true })]);
  assert.equal(validateProductAgainstParameters(parameters, { "Цвет": ["", "красный"] }).readiness, 100);
  assert.equal(validateProductAgainstParameters(parameters, { "Цвет": [] }).readiness, 0);
});

test("validateProductAgainstParameters is ready when a category has no required parameters", () => {
  const parameters = normalizeCategoryParameters([parameter({ id: 1, name: "Цвет", required: false })]);
  const result = validateProductAgainstParameters(parameters, {});
  assert.equal(result.requiredTotal, 0);
  assert.equal(result.readiness, 100);
  assert.deepEqual(result.missingRequired, []);
});

test("validateProductAgainstParameters copes with missing or malformed input", () => {
  const result = validateProductAgainstParameters(null, null);
  assert.equal(result.readiness, 100);
  assert.deepEqual(result.missingRequired, []);
  assert.deepEqual(result.unmatchedAttributeKeys, []);
});

test("summarizeValidation counts blocked products and ranks the most common gaps", () => {
  const parameters = normalizeCategoryParameters([
    parameter({ id: 1, name: "Цвет", required: true }),
    parameter({ id: 2, name: "Материал", required: true })
  ]);
  const entryFor = (terms) => ({
    missingRequired: [],
    readiness: 0,
    ...validateProductAgainstParameters(parameters, terms)
  });

  const summary = summarizeValidation([
    entryFor({ "Цвет": "red", "Материал": "cotton" }), // complete
    entryFor({ "Цвет": "red" }),                        // missing Материал
    entryFor({})                                        // missing both
  ]);

  assert.equal(summary.productCount, 3);
  assert.equal(summary.readyCount, 1);
  assert.equal(summary.blockedCount, 2);
  // Материал is absent from two products, Цвет from one, so Материал must rank first.
  assert.equal(summary.topMissingRequired[0].name, "Материал");
  assert.equal(summary.topMissingRequired[0].count, 2);
  assert.equal(summary.topMissingRequired[1].name, "Цвет");
  assert.equal(summary.topMissingRequired[1].count, 1);
  assert.equal(summary.averageReadiness, Math.round((100 + 50 + 0) / 3));
});

test("summarizeValidation handles an empty product list", () => {
  const summary = summarizeValidation([]);
  assert.equal(summary.productCount, 0);
  assert.equal(summary.averageReadiness, 0);
  assert.deepEqual(summary.topMissingRequired, []);
});
