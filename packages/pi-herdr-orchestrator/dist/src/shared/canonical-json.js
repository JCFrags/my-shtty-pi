import { createHash } from "node:crypto";
export function canonicalJson(value) {
    if (value === undefined ||
        (typeof value === "number" &&
            (!Number.isFinite(value) || Object.is(value, -0))))
        throw new TypeError("Value is not canonical JSON.");
    if (value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        typeof value === "number")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => a.localeCompare(b));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    throw new TypeError("Value is not canonical JSON.");
}
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
