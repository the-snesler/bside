import { describe, expect, it } from "vitest";
import { describeModels, OPENAI_API_KEY_PROVIDER } from "@/lib/providers/openai";
import { OPENAI_MODELS } from "@/lib/providers/openai-models";

// Runs against Pi's real bundled catalog, so a Pi update that changes a
// model's supported efforts shows up here.
describe("model catalog: reasoning efforts from Pi", () => {
  it("offers each model the efforts Pi records for it, defaulting to medium", () => {
    expect(describeModels([{ id: "gpt-6-sol", name: "GPT-6 Sol" }, { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }])).toEqual([
      { id: "gpt-6-sol", name: "GPT-6 Sol", reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
      // The API rejects `none` for this model.
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
    ]);
  });

  it("offers only none for a model Pi does not list, which is sent without reasoning controls", () => {
    expect(describeModels([{ id: "gpt-future-1", name: "Future" }])).toEqual([
      { id: "gpt-future-1", name: "Future", reasoningEfforts: ["none"], defaultReasoningEffort: "none" },
    ]);
  });

  it("lists API-key models that Pi knows, each with reasoning controls", () => {
    expect(OPENAI_API_KEY_PROVIDER.models.map((model) => model.id)).toEqual(OPENAI_MODELS.map((model) => model.id));
    for (const model of OPENAI_API_KEY_PROVIDER.models) expect(model.reasoningEfforts).toContain("medium");
  });
});
