export function coerceToNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;

    if (typeof value === "string") {
        const cleaned = value
            .replace(/^[$€£¥]\s*/, "")
            .replace(/\s*[$€£¥]$/, "")
            .replace(/\./g, "")
            .replace(",", ".")
            .replace(/\s/g, "")
            .trim();

        const parsed = Number(cleaned);
        if (!isNaN(parsed)) return parsed;
    }

    return null;
}

export function coerceToString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value.trim();
    return String(value).trim();
}

export function coerceToBoolean(value: unknown): boolean | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean") return value;

    if (typeof value === "string") {
        const lower = value.toLowerCase().trim();
        if (["true", "1", "si", "sí", "yes", "activo", "active", "verdadero"].includes(lower)) {
            return true;
        }
        if (["false", "0", "no", "inactivo", "inactive", "falso"].includes(lower)) return false;
    }

    if (typeof value === "number") {
        return value !== 0;
    }

    return null;
}

export function coerceValue(
    value: unknown,
    targetType: "string" | "number" | "boolean",
): { value: unknown; coerced: boolean } {
    if (targetType === "number") {
        const result = coerceToNumber(value);
        if (result !== null) return { value: result, coerced: typeof value !== "number" };
        return { value: null, coerced: false };
    }

    if (targetType === "boolean") {
        const result = coerceToBoolean(value);
        if (result !== null) return { value: result, coerced: typeof value !== "boolean" };
        return { value: null, coerced: false };
    }

    const result = coerceToString(value);
    return { value: result, coerced: typeof value !== "string" };
}
