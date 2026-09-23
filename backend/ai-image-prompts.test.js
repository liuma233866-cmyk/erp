const test = require("node:test");
const assert = require("node:assert/strict");
const { selectPromptForModel, FALLBACK_PROMPT } = require("./ai-image-prompts");

const prompts = [
  { id: "global", modelId: "", prompt: "通用提示词", isDefault: true },
  { id: "qwen-old", modelId: "MODEL-QWEN", prompt: "千问普通提示词", isDefault: false },
  { id: "qwen-default", modelId: "MODEL-QWEN", prompt: "千问默认提示词", isDefault: true }
];

test("uses the selected model's default prompt first", () => {
  assert.equal(selectPromptForModel(prompts, "MODEL-QWEN"), "千问默认提示词");
});

test("falls back to the global default for a model without a prompt", () => {
  assert.equal(selectPromptForModel(prompts, "MODEL-OTHER"), "通用提示词");
});

test("uses the built-in fallback when no prompts exist", () => {
  assert.equal(selectPromptForModel([], "MODEL-QWEN"), FALLBACK_PROMPT);
});
