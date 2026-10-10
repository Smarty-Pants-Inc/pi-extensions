import assert from "node:assert/strict";
import { test } from "vitest";
import { askUserQuestionTool } from "../src/ask-user-question.js";

for (const label of ["Other (free text)", "Back (revise previous answer)", "Done"]) {
  test(`RPC literal reserved label is an option: ${label}`, async () => {
    let inputs = 0;
    const result = await askUserQuestionTool.execute(
      "reserved",
      {
        questions: [
          { question: "Choose?", options: [{ label, value: "literal" }, { label: "Second" }], allowOther: false },
        ],
      },
      undefined,
      undefined,
      {
        mode: "rpc",
        hasUI: true,
        ui: {
          select: async (_title: string, options: string[]) => {
            assert.equal(options.length, 2);
            assert.ok(options.every((option) => option.startsWith("[option:")));
            return options[0];
          },
          input: async () => {
            inputs++;
            return "unexpected";
          },
        },
      } as never,
    );
    assert.equal(result.details.cancelled, false);
    assert.deepEqual(result.details.answers[0]?.selected, { label, value: "literal", index: 0 });
    assert.equal(inputs, 0);
  });
}

test("RPC duplicate labels preserve distinct values and indexes", async () => {
  const result = await askUserQuestionTool.execute(
    "duplicates",
    {
      questions: [
        {
          question: "Choose?",
          options: [
            { label: "Same", value: "a" },
            { label: "Same", value: "b" },
          ],
          allowOther: false,
        },
      ],
    },
    undefined,
    undefined,
    {
      mode: "rpc",
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          assert.equal(new Set(options).size, options.length);
          return options[1];
        },
      },
    } as never,
  );
  assert.deepEqual(result.details.answers[0]?.selected, { label: "Same", value: "b", index: 1 });
});

for (const toggles of [
  [0, 1],
  [0, 1, 0],
]) {
  test(`RPC duplicate multi-select choices toggle independently: ${toggles}`, async () => {
    const choices = [...toggles];
    const result = await askUserQuestionTool.execute(
      "multi",
      {
        questions: [
          {
            question: "Choose?",
            options: [
              { label: "Same", value: "a" },
              { label: "Same", value: "b" },
            ],
            allowOther: false,
            multiSelect: true,
          },
        ],
      },
      undefined,
      undefined,
      {
        mode: "rpc",
        hasUI: true,
        ui: {
          select: async (_title: string, options: string[]) => {
            assert.equal(new Set(options).size, options.length);
            const index = choices.shift();
            return index === undefined ? options.find((option) => option.startsWith("[action:done]")) : options[index];
          },
        },
      } as never,
    );
    assert.equal(result.details.cancelled, false);
    assert.deepEqual(
      result.details.answers[0]?.selected,
      toggles.length === 2
        ? [
            { label: "Same", value: "a", index: 0 },
            { label: "Same", value: "b", index: 1 },
          ]
        : [{ label: "Same", value: "b", index: 1 }],
    );
  });
}

for (const unavailable of ["[action:other] Other (free text)", "[action:back] Back (revise previous answer)"]) {
  test(`RPC rejects actions not offered: ${unavailable}`, async () => {
    const result = await askUserQuestionTool.execute(
      "invalid-action",
      {
        questions: [{ question: "Choose?", options: [{ label: "One" }, { label: "Two" }], allowOther: false }],
      },
      undefined,
      undefined,
      { mode: "rpc", hasUI: true, ui: { select: async () => unavailable } } as never,
    );
    assert.equal(result.details.reason, "ui_error");
  });
}
