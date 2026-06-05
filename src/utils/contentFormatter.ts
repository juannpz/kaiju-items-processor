import type { RawContent, TabularData } from "../parsers/types.ts";

const MAX_TABULAR_ROWS = 500;
const SAMPLE_HEAD_ROWS = 200;
const SAMPLE_TAIL_ROWS = 50;

export function formatForLLM(content: RawContent): string {
    if (content.type === "text") {
        return String(content.data);
    }

    const tabular = content.data as TabularData;
    return formatTabularContent(tabular);
}

function formatTabularContent(data: TabularData): string {
    if (data.totalRows === 0) {
        return "El documento no contiene datos.";
    }

    const sampleRows = sampleRowsFromTabular(data);
    const headerStr = data.headers.join("\t");

    const rowsStr = sampleRows
        .map((row) =>
            data.headers
                .map((h) => {
                    const val = row[h];
                    if (val === null || val === undefined) return "";
                    return String(val);
                })
                .join("\t")
        )
        .join("\n");

    let result = `COLUMNAS:\n${headerStr}\n\n`;

    if (sampleRows.length < data.totalRows) {
        result += `DATOS (${sampleRows.length} filas de muestra de ${data.totalRows} totales):\n`;
    } else {
        result += `DATOS (${data.totalRows} filas):\n`;
    }

    return result + rowsStr + "\n";
}

function sampleRowsFromTabular(data: TabularData): Record<string, unknown>[] {
    const rows = data.rows;

    if (rows.length <= MAX_TABULAR_ROWS) {
        return rows;
    }

    const sampled: Record<string, unknown>[] = [];

    for (let i = 0; i < Math.min(SAMPLE_HEAD_ROWS, rows.length); i++) {
        sampled.push(rows[i]);
    }

    if (rows.length > SAMPLE_HEAD_ROWS + SAMPLE_TAIL_ROWS) {
        const step = Math.max(
            1,
            Math.floor((rows.length - SAMPLE_HEAD_ROWS - SAMPLE_TAIL_ROWS) / 100),
        );
        for (
            let i = SAMPLE_HEAD_ROWS;
            i < rows.length - SAMPLE_TAIL_ROWS;
            i += step
        ) {
            if (sampled.length < MAX_TABULAR_ROWS - SAMPLE_TAIL_ROWS) {
                sampled.push(rows[i]);
            } else {
                break;
            }
        }
    }

    for (
        let i = Math.max(SAMPLE_HEAD_ROWS, rows.length - SAMPLE_TAIL_ROWS);
        i < rows.length;
        i++
    ) {
        sampled.push(rows[i]);
    }

    return sampled;
}
