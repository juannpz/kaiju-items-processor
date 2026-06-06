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
    const nonEmptyCount = Object.values(row).filter(
        (v) => v !== null && v !== undefined && String(v).trim() !== "",
    ).length;

    if (nonEmptyCount <= 1) return true;

    const values = Object.values(row).map((v) => String(v ?? "").toLowerCase().trim());

    const bannerPatterns = [
        /^marca:/,
        /^rubro:/,
        /^familia:/,
        /^categoria:/,
        /^seccion:/,
        /^listado de/i,
        /^lista de/i,
    ];

    const fullText = values.filter((v) => v.length > 0).join(" ");

    for (const pattern of bannerPatterns) {
        if (pattern.test(fullText)) return true;
    }

    return false;
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .substring(0, 50);
}
