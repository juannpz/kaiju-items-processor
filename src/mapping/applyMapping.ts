import type { ApplyMappingResult, ColumnMapping } from "./types.ts";
import type { TabularData } from "../parsers/types.ts";
import type { SchemaField, TargetSchema } from "../types.ts";
import { coerceToBoolean, coerceToNumber, coerceToString } from "../utils/typeCoercion.ts";

export function applyColumnMapping(
    data: TabularData,
    mapping: ColumnMapping,
    schema: TargetSchema,
): ApplyMappingResult {
    const items: Record<string, unknown>[] = [];
    const warnings: ApplyMappingResult["warnings"] = [];
    const missingFieldCounts: Record<string, number> = {};

    const schemaFieldMap = new Map<string, SchemaField>();
    for (const f of schema.fields) {
        schemaFieldMap.set(f.name, f);
    }

    for (let rowIdx = 0; rowIdx < data.rows.length; rowIdx++) {
        const row = data.rows[rowIdx];

        if (isBannerRow(row, data.headers)) continue;

        const item: Record<string, unknown> = {};
        const priceEntries: Record<string, unknown>[] = [];
        const suffixes: Record<string, string[]> = {};
        const rowMissingFields: string[] = [];

        for (const [colName, target] of Object.entries(mapping.columns)) {
            if (target.type === "ignore") continue;

            const rawValue = row[colName];

            if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
                continue;
            }

            if (target.type === "field") {
                const schemaField = schemaFieldMap.get(target.field);
                if (!schemaField) continue;
                item[target.field] = coerceCell(rawValue, schemaField);
            }

            if (target.type === "field_suffix") {
                const val = coerceToString(rawValue);
                if (val) {
                    suffixes[target.field] = suffixes[target.field] ?? [];
                    suffixes[target.field].push(val);
                }
            }

            if (target.type === "price_channel") {
                const numValue = coerceToNumber(rawValue);
                if (numValue !== null) {
                    priceEntries.push({
                        price: Math.round(numValue * 100) / 100,
                        channel_id: target.channel_id ?? slugify(target.channel_name),
                        channel_name: target.channel_name,
                    });
                }
            }
        }

        for (const [field, suffixValues] of Object.entries(suffixes)) {
            const baseValue = item[field];
            if (baseValue && suffixValues.length > 0) {
                item[field] = String(baseValue) + " " + suffixValues.join(" ");
            }
        }

        if (priceEntries.length > 0) {
            item["prices"] = priceEntries;
        }

        const schemaFieldNames = schema.fields.map((f) => f.name);

        for (const key of Object.keys(item)) {
            if (!schemaFieldNames.includes(key)) {
                delete item[key];
            }
        }

        for (const field of schema.fields) {
            if (!field.required) continue;
            const val = item[field.name];
            if (val === undefined || val === null || val === "") {
                rowMissingFields.push(field.name);
                missingFieldCounts[field.name] = (missingFieldCounts[field.name] ?? 0) + 1;
            }
        }

        if (Object.keys(item).length === 0 && priceEntries.length === 0) continue;

        if (!hasIdentityFields(item) && priceEntries.length > 0) continue;

        items.push(item);
    }

    const missingFields: ApplyMappingResult["missingFields"] = [];
    for (const field of schema.fields) {
        if (!field.required) continue;
        const count = missingFieldCounts[field.name] ?? 0;
        if (count > 0) {
            missingFields.push({
                field: field.name,
                reason: `Missing from source data (${count} of ${items.length} items)`,
                affectedItems: count,
            });
        }
    }

    return { items, missingFields, warnings };
}

function coerceCell(value: unknown, field: SchemaField): unknown {
    if (field.type === "number") {
        const num = coerceToNumber(value);
        return num ?? String(value).trim();
    }
    if (field.type === "boolean") {
        const bool = coerceToBoolean(value);
        return bool ?? String(value).trim();
    }
    return coerceToString(value) ?? String(value).trim();
}

function isBannerRow(row: Record<string, unknown>, _headers: string[]): boolean {
    const values = Object.values(row).map((v) => {
        const s = String(v ?? "").trim();
        return s.length > 0 ? s : null;
    }).filter((v): v is string => v !== null);

    if (values.length <= 1) return true;

    const fullText = values.join(" ").toLowerCase();

    const sectionPatterns = [
        "marca:",
        "marca ",
        "rubro:",
        "rubro ",
        "familia:",
        "familia ",
        "categoria:",
        "categoría:",
        "categoria ",
        "seccion:",
        "sección:",
        "seccion ",
        "proveedor:",
        "proveedor ",
        "listado de",
        "lista de",
        "lista:",
    ];

    for (const pattern of sectionPatterns) {
        if (fullText.includes(pattern)) return true;
    }

    for (const v of values) {
        const lower = v.toLowerCase();
        if (/^(descuento|bonificaci[oó]n|margen|recargo|dto|bonif|bon)\b/.test(lower)) {
            return true;
        }
        if (/^[-=_]{3,}$/.test(v)) return true;
        if (/^(total|subtotal|sub total|suma)\b/.test(lower) && values.length <= 3) {
            return true;
        }
    }

    return false;
}

function hasIdentityFields(item: Record<string, unknown>): boolean {
    const identityFields = ["name", "barcode", "category_id", "supplier_id"];
    return identityFields.some(
        (f) => item[f] !== undefined && item[f] !== null && String(item[f]).trim() !== "",
    );
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .substring(0, 50);
}
