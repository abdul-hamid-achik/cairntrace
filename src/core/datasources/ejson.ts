/**
 * Extended JSON helpers. Filters are authored as (relaxed or canonical)
 * extended JSON — `{ $oid: … }`, `{ $date: … }`, `{ $numberLong: … }` —
 * and results come back as relaxed EJSON. Matchers, evidence and
 * `${captures.*}` see the PLAIN view: ObjectIds as hex strings, dates as ISO
 * strings, safe longs as numbers. Wrap a plain value back explicitly when it
 * feeds a later filter (`{ $oid: "${captures.company.docs.0._id}" }`).
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function ejsonToPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ejsonToPlain);
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const key = keys[0]!;
    const inner = value[key];
    switch (key) {
      case "$oid":
      case "$symbol":
      case "$numberDecimal":
      case "$uuid":
        if (typeof inner === "string") return inner;
        break;
      case "$date":
        return plainDate(inner) ?? value;
      case "$numberLong":
      case "$numberInt":
      case "$numberDouble":
        if (typeof inner === "string") {
          const n = Number(inner);
          return Number.isSafeInteger(n) ||
            (key === "$numberDouble" && Number.isFinite(n))
            ? n
            : inner;
        }
        break;
      case "$regularExpression":
        if (
          isPlainObject(inner) &&
          typeof inner["pattern"] === "string" &&
          typeof inner["options"] === "string"
        ) {
          return `/${inner["pattern"]}/${inner["options"]}`;
        }
        break;
      default:
        break;
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    out[key] = ejsonToPlain(item);
  return out;
}

function plainDate(inner: unknown): string | undefined {
  if (typeof inner === "string") return inner;
  if (typeof inner === "number" && Number.isFinite(inner)) {
    return new Date(inner).toISOString();
  }
  if (isPlainObject(inner) && typeof inner["$numberLong"] === "string") {
    const n = Number(inner["$numberLong"]);
    if (Number.isFinite(n)) return new Date(n).toISOString();
  }
  return undefined;
}

const BSON_TYPE_KEY = "_bsontype";

/**
 * Normalize a native driver value (Date, ObjectId-like objects with
 * toHexString, Long/Decimal128-like objects with toString) into relaxed
 * EJSON when the driver offers no EJSON serializer (test doubles).
 */
export function nativeToRelaxedEjson(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(nativeToRelaxedEjson);
  if (value !== null && typeof value === "object") {
    const candidate = value as {
      toHexString?: () => string;
      toString?: () => string;
    };
    if (typeof candidate.toHexString === "function") {
      return { $oid: candidate.toHexString() };
    }
    if (typeof Reflect.get(value, BSON_TYPE_KEY) === "string") {
      return candidate.toString?.() ?? String(value);
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = nativeToRelaxedEjson(item);
    }
    return out;
  }
  if (typeof value === "bigint") return Number(value);
  return value;
}
