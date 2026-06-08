import type { RawContent, TabularData } from "../parsers/types.ts";

const SAMPLE_ROWS_FROM_START = 5;
const SAMPLE_ROWS_FROM_MIDDLE = 5;
const SAMPLE_ROWS_FROM_END = 5;

export function formatForLLM(content: RawContent): string {
    if (content.type === "text") {
        return String(content.data);
    }

    if (Array.isArray(content.data)) {
        const formatted = content.data.map((sheet) => formatSheetForAnalysis(sheet));
        if (formatted.every((s) => s === null)) return "El documento no contiene datos.";
        return `PLANILLA CON ${content.data.length} HOJAS:\n\n${formatted.join("\n\n---\n\n")}`;
    }

    const data = content.data as TabularData;
    return formatSheetForAnalysis(data) ?? "El documento no contiene datos.";
}

function formatSheetForAnalysis(data: TabularData): string | null {
    if (data.totalRows === 0) return null;

    const nonEmptyHeaders = filterNonEmptyColumns(data);

    if (nonEmptyHeaders.length === 0) return null;

    const sheetInfo = data.sheetName ? `\nHoja: ${data.sheetName}\n` : "";

    const headerStr = nonEmptyHeaders.join("\t");

    const totalRows = data.totalRows;
    const sampleRows = pickDiverseSamples(data, nonEmptyHeaders);
    const sampleCount = sampleRows.length;

    const rowsStr = sampleRows
        .map(({ row, globalIdx }) =>
            `Fila ${globalIdx}: ` +
            nonEmptyHeaders
                .map((h) => {
                    const val = row[h];
                    if (val === null || val === undefined) return "";
                    return String(val);
                })
                .join(" | ")
        )
        .join("\n");

    const colFillRates = nonEmptyHeaders.map((h) => {
        const filled = data.rows.filter(
            (r) => r[h] !== null && r[h] !== undefined && String(r[h]).trim() !== "",
        ).length;
        const pct = totalRows > 0 ? Math.round((filled / totalRows) * 100) : 0;
        return `${h}: ${pct}%`;
    }).join(", ");

    return `${sheetInfo}COLUMNAS (${nonEmptyHeaders.length}):\n${headerStr}\n\n` +
        `MUESTRA DE DATOS (${sampleCount} de ${totalRows} filas):\n${rowsStr}\n\n` +
        `RELLENO POR COLUMNA: ${colFillRates}`;
}

function filterNonEmptyColumns(data: TabularData): string[] {
    const totalRows = data.totalRows;

    return data.headers.filter((header) => {
        const filled = data.rows.some(
            (r) => r[header] !== null && r[header] !== undefined && String(r[header]).trim() !== "",
        );
        if (!filled) return false;

        const emptyCount = data.rows.filter(
            (r) => r[header] === null || r[header] === undefined || String(r[header]).trim() === "",
        ).length;

        if (emptyCount === totalRows) return false;

        return true;
    });
}

function pickDiverseSamples(
    data: TabularData,
    headers: string[],
): Array<{ row: Record<string, unknown>; globalIdx: number }> {
    const totalRows = data.rows.length;
    if (totalRows === 0) return [];

    const selected: Array<{ row: Record<string, unknown>; globalIdx: number }> = [];
    const usedIndices = new Set<number>();

    const take = (
        startIdx: number,
        count: number,
    ): void => {
        for (let i = startIdx; i < Math.min(startIdx + count, totalRows); i++) {
            if (!usedIndices.has(i)) {
                const row = data.rows[i];
                const hasContent = headers.some(
                    (h) => row[h] !== null && row[h] !== undefined && String(row[h]).trim() !== "",
                );
                if (hasContent) {
                    selected.push({ row, globalIdx: i + 1 });
                    usedIndices.add(i);
                }
            }
        }
    };

    take(0, SAMPLE_ROWS_FROM_START);

    const midStart = Math.floor(totalRows / 2);
    take(midStart, SAMPLE_ROWS_FROM_MIDDLE);

    const endStart = Math.max(0, totalRows - SAMPLE_ROWS_FROM_END);
    take(endStart, SAMPLE_ROWS_FROM_END);

    return selected;
}
