"use strict";
// A small JSON Schema validator for completion results — the subset structured
// output actually uses (types, properties/required/additionalProperties,
// items/prefixItems, enum/const, string/number/array/object bounds, pattern,
// anyOf/oneOf/allOf/not, if/then/else, local $ref). Keywords it doesn't know
// (format, title, description, …) are ignored, as the spec allows.
//
// validate(schema, value) → [{ path, message }]; empty means valid.

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean"
}

function matchesType(v, t) {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  return typeOf(v) === t;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

// "#", "#/$defs/x", "#/definitions/x/properties/y" — JSON pointers into the root.
function resolveRef(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#")) throw new Error(`unsupported $ref ${ref} (only local refs)`);
  let node = root;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (node == null || typeof node !== "object" || !(key in node)) throw new Error(`unresolvable $ref ${ref}`);
    node = node[key];
  }
  return node;
}

const show = (v) => { const s = JSON.stringify(v); return s && s.length > 60 ? s.slice(0, 57) + "…" : s; };
const join = (path, key) => `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;

function check(schema, value, path, root, errors, depth) {
  if (depth > 64) { errors.push({ path, message: "schema nests too deeply (circular $ref?)" }); return; }
  if (schema === true || schema === undefined) return;
  if (schema === false) { errors.push({ path, message: "no value is allowed here" }); return; }
  if (!schema || typeof schema !== "object") return;
  const err = (message) => errors.push({ path: path || "/", message });

  if (schema.$ref !== undefined) {
    let target;
    try { target = resolveRef(root, schema.$ref); } catch (e) { err(e.message); return; }
    check(target, value, path, root, errors, depth + 1);
  }

  if (schema.nullable === true && value === null) return; // OpenAPI-style
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) { err(`expected ${types.join(" or ")}, got ${typeOf(value)}`); return; }
  }
  if (schema.enum !== undefined && !(Array.isArray(schema.enum) && schema.enum.some((e) => deepEqual(e, value)))) err(`must be one of ${show(schema.enum)}`);
  if (schema.const !== undefined && !deepEqual(schema.const, value)) err(`must equal ${show(schema.const)}`);

  if (typeof value === "string") {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) err(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && len > schema.maxLength) err(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined) {
      let re = null;
      try { re = new RegExp(schema.pattern, "u"); } catch { err(`schema pattern ${show(schema.pattern)} is not a valid regular expression`); }
      if (re && !re.test(value)) err(`must match ${show(schema.pattern)}`);
    }
  }

  if (typeof value === "number") {
    const exMin = schema.exclusiveMinimum, exMax = schema.exclusiveMaximum;
    if (schema.minimum !== undefined && (exMin === true ? value <= schema.minimum : value < schema.minimum)) err(`must be ${exMin === true ? ">" : ">="} ${schema.minimum}`);
    if (schema.maximum !== undefined && (exMax === true ? value >= schema.maximum : value > schema.maximum)) err(`must be ${exMax === true ? "<" : "<="} ${schema.maximum}`);
    if (typeof exMin === "number" && value <= exMin) err(`must be > ${exMin}`);
    if (typeof exMax === "number" && value >= exMax) err(`must be < ${exMax}`);
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const q = value / schema.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) err(`must be a multiple of ${schema.multipleOf}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) err(`must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) err(`must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems === true && value.some((v, i) => value.findIndex((w) => deepEqual(v, w)) !== i)) err("items must be unique");
    const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : null;
    const rest = tuple ? (Array.isArray(schema.items) ? schema.additionalItems : schema.items) : schema.items;
    value.forEach((item, i) => {
      if (tuple && i < tuple.length) check(tuple[i], item, join(path, i), root, errors, depth + 1);
      else if (rest !== undefined) check(rest, item, join(path, i), root, errors, depth + 1);
    });
    if (schema.contains !== undefined) {
      const hits = value.filter((item) => { const e = []; check(schema.contains, item, path, root, e, depth + 1); return !e.length; }).length;
      if (hits < (schema.minContains ?? 1)) err("must contain a matching item");
      if (schema.maxContains !== undefined && hits > schema.maxContains) err(`must contain at most ${schema.maxContains} matching items`);
    }
  }

  if (typeOf(value) === "object") {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) err(`must have at least ${schema.minProperties} properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) err(`must have at most ${schema.maxProperties} properties`);
    for (const r of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.prototype.hasOwnProperty.call(value, r)) errors.push({ path: join(path, r), message: "is required" });
    }
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const patterns = Object.entries(schema.patternProperties || {}).map(([p, s]) => { try { return [new RegExp(p, "u"), s]; } catch { return null; } }).filter(Boolean);
    for (const k of keys) {
      let matched = false;
      if (Object.prototype.hasOwnProperty.call(props, k)) { matched = true; check(props[k], value[k], join(path, k), root, errors, depth + 1); }
      for (const [re, s] of patterns) if (re.test(k)) { matched = true; check(s, value[k], join(path, k), root, errors, depth + 1); }
      if (!matched && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) errors.push({ path: join(path, k), message: "is not an allowed property" });
        else check(schema.additionalProperties, value[k], join(path, k), root, errors, depth + 1);
      }
    }
    for (const [k, deps] of Object.entries(schema.dependentRequired || {})) {
      if (Object.prototype.hasOwnProperty.call(value, k)) for (const d of deps) if (!Object.prototype.hasOwnProperty.call(value, d)) errors.push({ path: join(path, d), message: `is required when ${k} is present` });
    }
  }

  const passes = (s) => { const e = []; check(s, value, path, root, e, depth + 1); return e; };
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) check(s, value, path, root, errors, depth + 1);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => !passes(s).length)) err("must match at least one allowed shape (anyOf)");
  if (Array.isArray(schema.oneOf)) {
    const n = schema.oneOf.filter((s) => !passes(s).length).length;
    if (n !== 1) err(n ? "matches more than one shape (oneOf)" : "must match exactly one allowed shape (oneOf)");
  }
  if (schema.not !== undefined && !passes(schema.not).length) err("matches a shape that is not allowed (not)");
  if (schema.if !== undefined) {
    const branch = passes(schema.if).length ? schema.else : schema.then;
    if (branch !== undefined) check(branch, value, path, root, errors, depth + 1);
  }
}

function validate(schema, value) {
  const errors = [];
  check(schema, value, "", schema, errors, 0);
  return errors;
}

// Errors as short lines a model can act on in a retry.
function describe(errors, max = 20) {
  const lines = errors.slice(0, max).map((e) => `- ${e.path || "/"}: ${e.message}`);
  if (errors.length > max) lines.push(`- …and ${errors.length - max} more`);
  return lines.join("\n");
}

module.exports = { validate, describe };
