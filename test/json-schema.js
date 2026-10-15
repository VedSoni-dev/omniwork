"use strict";
// The JSON Schema subset completion results are validated against.
// Run: node test/json-schema.js
const { validate, describe } = require("../electron/json-schema");

let fails = 0;
const check = (name, ok) => { console.log((ok ? "✓" : "✗"), name); if (!ok) fails++; };
const ok = (schema, value) => validate(schema, value).length === 0;

// A scoring schema of the kind a review pipeline uses.
const SCORE = {
  type: "object",
  required: ["company", "score", "flags"],
  additionalProperties: false,
  properties: {
    company: { type: "string", minLength: 1 },
    score: { type: "integer", minimum: 0, maximum: 10 },
    flags: { type: "array", items: { enum: ["injection", "incomplete", "none"] }, uniqueItems: true },
    notes: { type: ["string", "null"], maxLength: 20 },
  },
};
check("a conforming object passes", ok(SCORE, { company: "Acme", score: 7, flags: ["none"], notes: null }));
check("a missing required property fails, with its path", validate(SCORE, { company: "Acme", flags: [] }).some((e) => e.path === "/score" && /required/.test(e.message)));
check("an extra property fails when additionalProperties is false", validate(SCORE, { company: "A", score: 1, flags: [], extra: 1 }).some((e) => e.path === "/extra"));
check("integer rejects 7.5", !ok(SCORE, { company: "A", score: 7.5, flags: [] }));
check("maximum is enforced", !ok(SCORE, { company: "A", score: 11, flags: [] }));
check("enum items are enforced", validate(SCORE, { company: "A", score: 1, flags: ["evil"] }).some((e) => e.path === "/flags/0"));
check("uniqueItems is enforced", !ok(SCORE, { company: "A", score: 1, flags: ["none", "none"] }));
check("type arrays allow null", ok(SCORE, { company: "A", score: 1, flags: [], notes: null }));
check("maxLength counts characters", !ok(SCORE, { company: "A", score: 1, flags: [], notes: "x".repeat(21) }));
check("minLength is enforced", !ok(SCORE, { company: "", score: 1, flags: [] }));
check("the wrong root type fails once, clearly", (() => { const e = validate(SCORE, [1]); return e.length === 1 && /expected object, got array/.test(e[0].message); })());
check("{} is not a valid score (no silent empty object)", !ok(SCORE, {}));

// Composition, refs, conditionals.
const COMPOSED = {
  $defs: { money: { type: "number", exclusiveMinimum: 0 }, stage: { enum: ["seed", "series-a"] } },
  type: "object",
  properties: {
    ask: { $ref: "#/$defs/money" },
    stage: { $ref: "#/$defs/stage" },
    contact: { oneOf: [{ type: "string", pattern: "^[^@]+@[^@]+$" }, { type: "null" }] },
    tags: { type: "array", prefixItems: [{ const: "primary" }], items: { type: "string" }, maxItems: 3 },
  },
  // `required` too: an `if` on an absent property passes vacuously.
  if: { properties: { stage: { const: "series-a" } }, required: ["stage"] },
  then: { required: ["ask"] },
};
check("$ref into $defs resolves", ok(COMPOSED, { ask: 1, stage: "seed" }) && !ok(COMPOSED, { ask: 0 }));
check("if/then applies the conditional requirement", !ok(COMPOSED, { stage: "series-a" }) && ok(COMPOSED, { stage: "seed" }) && ok(COMPOSED, {}));
check("an if on an absent property passes vacuously (spec semantics)", !ok({ if: { properties: { a: { const: 1 } } }, then: { required: ["b"] } }, {}));
check("oneOf + pattern", ok(COMPOSED, { contact: "a@b.co" }) && ok(COMPOSED, { contact: null }) && !ok(COMPOSED, { contact: "nope" }));
check("prefixItems + items + maxItems", ok(COMPOSED, { tags: ["primary", "x"] }) && !ok(COMPOSED, { tags: ["other"] }) && !ok(COMPOSED, { tags: ["primary", "a", "b", "c"] }));
check("anyOf / allOf / not", ok({ anyOf: [{ type: "string" }, { type: "number" }] }, 3) && !ok({ allOf: [{ minimum: 1 }, { maximum: 2 }] }, 3) && !ok({ not: { type: "null" } }, null));
check("draft-4 boolean exclusiveMinimum", !ok({ minimum: 0, exclusiveMinimum: true }, 0) && ok({ minimum: 0, exclusiveMinimum: true }, 0.1));
check("multipleOf tolerates float rounding", ok({ multipleOf: 0.1 }, 0.3) && !ok({ multipleOf: 2 }, 3));
check("dependentRequired", !ok({ dependentRequired: { a: ["b"] } }, { a: 1 }) && ok({ dependentRequired: { a: ["b"] } }, { a: 1, b: 2 }));
check("patternProperties + additionalProperties schema", ok({ patternProperties: { "^x-": { type: "string" } }, additionalProperties: { type: "number" } }, { "x-a": "s", n: 1 }) && !ok({ patternProperties: { "^x-": { type: "string" } }, additionalProperties: { type: "number" } }, { n: "s" }));
check("contains / minContains", ok({ contains: { const: 1 } }, [0, 1]) && !ok({ contains: { const: 1 } }, [0]));
check("nullable (OpenAPI style) admits null", ok({ type: "string", nullable: true }, null));
check("an unresolvable $ref is reported, not thrown", validate({ $ref: "#/$defs/missing" }, 1).length === 1);
check("a circular $ref stops instead of recursing forever", validate({ $defs: { a: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" }, 1).length >= 1);
check("unknown keywords (format, title) are ignored", ok({ type: "string", format: "email", title: "x" }, "not-an-email"));
check("boolean schemas", ok(true, 1) && !ok(false, 1));
check("describe() lists errors for a retry prompt", /\/score: is required/.test(describe(validate(SCORE, { company: "A", flags: [] }))));

console.log(fails ? `\n❌ ${fails} FAILED` : "\n✅ JSON SCHEMA TEST PASSED");
process.exit(fails ? 1 : 0);
