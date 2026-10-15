import { describe, expect, it } from "vitest";
import { runWorkflow, validateJsonSchema } from "../src/runtime.js";

describe("JSON Schema integer results", () => {
  it.each([0, 1, -2, Number.MAX_SAFE_INTEGER])("accepts the integer %s", (value) => {
    expect(validateJsonSchema(value, { type: "integer" })).toEqual([]);
  });
  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null])("rejects a non-integer %s", (value) => {
    expect(validateJsonSchema(value, { type: "integer" })).not.toEqual([]);
  });
  it("keeps nested, union and numeric bounds semantics", () => {
    const schema = {
      type: "object",
      properties: { line: { type: ["integer", "null"], minimum: 1, maximum: 10 } },
      required: ["line"],
    };
    expect(validateJsonSchema({ line: 5 }, schema)).toEqual([]);
    expect(validateJsonSchema({ line: null }, schema)).toEqual([]);
    expect(validateJsonSchema({ line: 1.5 }, schema)).not.toEqual([]);
    expect(validateJsonSchema({ line: 0 }, schema)).toEqual(["$.line: below minimum 1"]);
    expect(validateJsonSchema({ line: 11 }, schema)).toEqual(["$.line: above maximum 10"]);
  });
  it("accepts an actual integer agent result without schema repair or another model dispatch", async () => {
    let calls = 0;
    const { result } = await runWorkflow(
      'export const meta = { name: "integer-result", description: "test" }; return await agent("answer", { schema: { type: "object", properties: { line: { type: "integer" } }, required: ["line"] } });',
      {
        agent: {
          run: async () => {
            calls++;
            return '{"line": 4}';
          },
        },
      },
    );
    expect(result).toEqual({ line: 4 });
    expect(calls).toBe(1);
  });
});
