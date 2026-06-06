import type { RawContent, TabularData } from "../parsers/types.ts";

const SAMPLE_ROWS_FOR_MAPPING = 10;

export function formatForLLM(content: RawContent): string {
    if (content.type === "text") {
        return String(content.data);
    }

    const tabular = content.data as TabularData;
    return formatForColumnAnalysis(tabular);
}

function formatForColumnAnalysis(data: TabularData): string {
    if (data.totalRows === 0) {
        return "El documento no contiene datos.";
    }

    const sheetInfo = data.sheetName ? `\nHoja: ${data.sheetName}\n` : "";

    const headerStr = data.headers.join("\t");

    const sampleCount = Math.min(SAMPLE_ROWS_FOR_MAPPING, data.totalRows);
    const sampleRows = data.rows.slice(0, sampleCount);

    const rowsStr = sampleRows
        .map((row, idx) =>
            `Fila ${idx + 1}: ` +
            data.headers
                .map((h) => {
                    const val = row[h];
                    if (val === null || val === undefined) return "";
                    return String(val);
                })
                .join(" | ")
        )
        .join("\n");

    return `${sheetInfo}COLUMNAS:\n${headerStr}\n\nMUESTRA DE DATOS (${sampleCount} de ${data.totalRows} filas):\n${rowsStr}`;
}
