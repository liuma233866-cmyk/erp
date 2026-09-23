// 从 app.js 拆出的 Yandex 费率模块（classic script，全局作用域）。

const yandexModelTabs = document.getElementById("yandexModelTabs");
const yandexFeeCurrency = document.getElementById("yandexFeeCurrency");
const yandexBaseFee = document.getElementById("yandexBaseFee");
const yandexPerKgFee = document.getElementById("yandexPerKgFee");
const yandexWeightKg = document.getElementById("yandexWeightKg");
const yandexChargeWeight = document.getElementById("yandexChargeWeight");
const yandexFeeTotal = document.getElementById("yandexFeeTotal");
const yandexFeeHint = document.getElementById("yandexFeeHint");
const rateModelTitle = document.getElementById("rateModelTitle");
const yandexServiceSections = document.querySelectorAll(".rate-section[data-rate-section]");

const YANDEX_MODEL_CONFIG = {
  fbp: { label: "FBP", useVolumetric: true },
  fbs: { label: "FBS", useVolumetric: true },
  fbs_lm: { label: "FBS最后一公里", useVolumetric: true }
};
let currentYandexModel = "fbp";

const YANDEX_RATE_TABLE = {
  RUB: { perOrder: 300, perKg: 100 },
  USD: { perOrder: 3.56, perKg: 1.19 },
  CNY: { perOrder: 26.02, perKg: 8.67 }
};

function onYandexModelTabClick(event) {
  const btn = event.target.closest("button[data-yandex-model]");
  if (!btn || !yandexModelTabs) return;
  const model = String(btn.dataset.yandexModel || "");
  if (!YANDEX_MODEL_CONFIG[model]) return;
  currentYandexModel = model;
  yandexModelTabs.querySelectorAll("button[data-yandex-model]").forEach((b) => b.classList.toggle("active", b === btn));
  if (rateModelTitle) rateModelTitle.textContent = YANDEX_MODEL_CONFIG[model]?.label || model;
  if (yandexServiceSections?.length) {
    yandexServiceSections.forEach((section) => {
      section.classList.toggle("hidden", section.dataset.rateSection !== model);
    });
  }
  updateYandexModelHint();
  computeYandexFee();
}

function getActiveYandexModel() {
  if (!yandexModelTabs) return currentYandexModel;
  const active = yandexModelTabs.querySelector("button[data-yandex-model].active");
  const model = String(active?.dataset.yandexModel || "");
  if (model && YANDEX_MODEL_CONFIG[model]) currentYandexModel = model;
  return currentYandexModel;
}

function updateYandexModelHint() {
  if (!yandexFeeHint) return;
  yandexFeeHint.textContent = "服务费=基础费+每公斤费×计费重量；计费重量为实重向上取整到0.1kg。";
}

function toNum(value) {
  const num = Number(String(value || "").replace(",", "."));
  return Number.isFinite(num) ? num : 0;
}

function roundUp01kg(value) {
  return Math.ceil(value * 10) / 10;
}

function applyYandexRateTable() {
  if (!yandexFeeCurrency || !yandexBaseFee || !yandexPerKgFee) return;
  const currency = yandexFeeCurrency.value || "RUB";
  const rates = YANDEX_RATE_TABLE[currency];
  if (!rates) {
    yandexBaseFee.value = "";
    yandexPerKgFee.value = "";
  } else {
    yandexBaseFee.value = String(rates.perOrder);
    yandexPerKgFee.value = String(rates.perKg);
  }
  yandexBaseFee.readOnly = true;
  yandexPerKgFee.readOnly = true;
  computeYandexFee();
}

function computeYandexFee() {
  if (!yandexChargeWeight || !yandexFeeTotal) return;
  const base = toNum(yandexBaseFee?.value);
  const perKg = toNum(yandexPerKgFee?.value);
  const weight = toNum(yandexWeightKg?.value);
  const charge = weight ? roundUp01kg(weight) : 0;
  const fee = base + perKg * (charge || 0);
  const currency = yandexFeeCurrency?.value || "RUB";
  yandexChargeWeight.textContent = charge ? charge.toFixed(1) : "-";
  yandexFeeTotal.textContent = fee ? `${fee.toFixed(2)} ${currency}` : "-";
}

function bindYandexRateEvents() {
  if (yandexModelTabs) yandexModelTabs.addEventListener("click", onYandexModelTabClick);
  [yandexFeeCurrency, yandexBaseFee, yandexPerKgFee, yandexWeightKg].forEach((el) => {
    if (el) el.addEventListener("input", computeYandexFee);
  });
  if (yandexFeeCurrency) yandexFeeCurrency.addEventListener("change", applyYandexRateTable);
}
