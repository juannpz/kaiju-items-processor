import type { RawContent, TabularData } from "../parsers/types.ts";

const SAMPLE_ROWS_FROM_START = 5;
const SAMPLE_ROWS_FROM_MIDDLE = 5;
const SAMPLE_ROWS_FROM_END = 5;
const MAX_SAMPLES = 30;
const MIN_SECTION_SIZE = 10;

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

    const sectionInfo = getSectionInfo(data);

    return `${sheetInfo}${sectionInfo}COLUMNAS (${nonEmptyHeaders.length}):\n${headerStr}\n\n` +
        `MUESTRA DE DATOS (${sampleCount} de ${totalRows} filas):\n${rowsStr}\n\n` +
        `RELLENO POR COLUMNA: ${colFillRates}`;
}

function getSectionInfo(data: TabularData): string {
    const sections = detectSections(data);
    if (sections.length <= 1) return "";
    const names = sections.map((s) => s.label).filter(Boolean);
    if (names.length === 0) return "";
    return `SECCIONES DETECTADAS (${sections.length}): ${names.join(", ")}\n`;
}

interface Section {
    startIdx: number;
    endIdx: number;
    label: string;
}

function detectSections(data: TabularData): Section[] {
    const rows = data.rows;
    const totalRows = rows.length;
    if (totalRows < MIN_SECTION_SIZE * 2) {
        return [{ startIdx: 0, endIdx: totalRows - 1, label: "" }];
    }

    const sectionStarts: number[] = [0];
    const sectionLabels: string[] = [""];

    for (let i = 1; i < totalRows; i++) {
        const row = rows[i];
        if (isLikelySectionHeader(row)) {
            if (i - sectionStarts[sectionStarts.length - 1] >= MIN_SECTION_SIZE) {
                sectionStarts.push(i + 1);
                sectionLabels.push(extractSectionLabel(row));
            }
        }
    }

    const sections: Section[] = [];
    for (let i = 0; i < sectionStarts.length; i++) {
        const start = sectionStarts[i];
        const end = i < sectionStarts.length - 1 ? sectionStarts[i + 1] - 1 : totalRows - 1;
        if (end - start >= 0) {
            sections.push({ startIdx: start, endIdx: end, label: sectionLabels[i] });
        }
    }

    return sections.length <= 1 ? [{ startIdx: 0, endIdx: totalRows - 1, label: "" }] : sections;
}

function isLikelySectionHeader(row: Record<string, unknown>): boolean {
    const values = Object.values(row).map((v) => {
        const s = String(v ?? "").trim();
        return s.length > 0 ? s : null;
    }).filter((v): v is string => v !== null);

    if (values.length === 0 || values.length > 6) return false;

    const fullText = values.join(" ").toLowerCase();

    const patterns = [
        "marca:",
        "rubro:",
        "familia:",
        "categoria:",
        "categoría:",
        "seccion:",
        "sección:",
    ];

    return patterns.some((p) => fullText.includes(p));
}

function extractSectionLabel(row: Record<string, unknown>): string {
    const values = Object.values(row).map((v) => {
        const s = String(v ?? "").trim();
        return s.length > 0 ? s : null;
    }).filter((v): v is string => v !== null);

    return values.join(" ").substring(0, 60);
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

    const sections = detectSections(data);

    if (sections.length <= 2 || totalRows < 500) {
        return pickDefaultSamples(data, headers);
    }

    const selected: Array<{ row: Record<string, unknown>; globalIdx: number }> = [];
    const usedIndices = new Set<number>();

    const maxPerSection = Math.max(1, Math.floor(MAX_SAMPLES / sections.length));

    for (const section of sections) {
        const sectionSize = section.endIdx - section.startIdx + 1;
        if (sectionSize <= 0) continue;

        let taken = 0;
        const step = Math.max(1, Math.floor(sectionSize / (maxPerSection + 1)));

        for (let i = section.startIdx; i <= section.endIdx && taken < maxPerSection; i += step) {
            if (!usedIndices.has(i)) {
                const row = data.rows[i];
                const hasContent = headers.some(
                    (h) => row[h] !== null && row[h] !== undefined && String(row[h]).trim() !== "",
                );
                if (hasContent) {
                    selected.push({ row, globalIdx: i + 1 });
                    usedIndices.add(i);
                    taken++;
                }
            }
        }

        for (let i = section.startIdx; i <= section.endIdx && taken < maxPerSection; i++) {
            if (!usedIndices.has(i)) {
                const row = data.rows[i];
                const hasContent = headers.some(
                    (h) => row[h] !== null && row[h] !== undefined && String(row[h]).trim() !== "",
                );
                if (hasContent) {
                    selected.push({ row, globalIdx: i + 1 });
                    usedIndices.add(i);
                    taken++;
                }
            }
        }
    }

    if (selected.length < 10 && totalRows > 100) {
        const fallback = pickDefaultSamples(data, headers);
        for (const s of fallback) {
            if (!usedIndices.has(s.globalIdx - 1)) {
                selected.push(s);
                usedIndices.add(s.globalIdx - 1);
            }
        }
    }

    selected.sort((a, b) => a.globalIdx - b.globalIdx);

    return selected.slice(0, MAX_SAMPLES);
}

function pickDefaultSamples(
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
