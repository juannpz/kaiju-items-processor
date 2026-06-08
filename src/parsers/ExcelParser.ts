import type { Parser, ParserOptions, RawContent, TabularData } from "./types.ts";
import * as XLSX from "xlsx";

export class ExcelParser implements Parser {
    readonly format = "excel";

    canParse(data: Uint8Array, filename?: string): boolean {
        if (filename) {
            const ext = filename.split(".").pop()?.toLowerCase();
            if (ext === "xlsx" || ext === "xls" || ext === "csv") return true;
        }
        try {
            XLSX.read(data, { type: "array" });
            return true;
        } catch {
            return false;
        }
    }

    parse(data: Uint8Array, options?: ParserOptions): RawContent {
        const workbook = XLSX.read(data, { type: "array" });

        if (workbook.SheetNames.length === 0) {
            return {
                type: "tabular",
                data: { headers: [], rows: [], totalRows: 0, sheetName: "" },
            };
        }

        const allSheetsData: TabularData[] = [];

        for (let s = 0; s < workbook.SheetNames.length; s++) {
            const sheetName = workbook.SheetNames[s];
            const sheet = workbook.Sheets[sheetName];

            const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
                header: 1,
            });

            if (rawRows.length === 0) continue;

            const colCount = rawRows.reduce(
                (max, row) => Math.max(max, row?.length ?? 0),
                0,
            );

            if (colCount === 0) continue;

            const nonEmptyColIndices = findNonEmptyColumns(rawRows, colCount);

            if (nonEmptyColIndices.length === 0) continue;

            const filledRows = rawRows.filter((row) => {
                const nonEmpty = nonEmptyColIndices.filter((c) => {
                    const val = row?.[c];
                    return val != null && String(val).trim() !== "";
                }).length;
                return nonEmpty >= 2;
            });

            if (filledRows.length < 2) continue;

            const headerRow = options?.headerRow ?? detectHeaderRow(rawRows, nonEmptyColIndices);

            const headers = nonEmptyColIndices.map((colIdx) => {
                const h = (rawRows[headerRow] as unknown[])?.[colIdx];
                if (h != null && String(h).trim() !== "") return String(h).trim();
                return `col_${colIdx}`;
            });

            const dataRowsStart = headerRow + 1;
            const dataRows: Record<string, unknown>[] = [];

            for (let i = dataRowsStart; i < rawRows.length; i++) {
                const row = rawRows[i] as unknown[];
                if (
                    !row || nonEmptyColIndices.every((c) => {
                        const val = row[c];
                        return val == null || String(val).trim() === "";
                    })
                ) {
                    continue;
                }

                const rowObj: Record<string, unknown> = {};
                for (let j = 0; j < nonEmptyColIndices.length; j++) {
                    const colIdx = nonEmptyColIndices[j];
                    rowObj[headers[j]] = row[colIdx] ?? null;
                }
                dataRows.push(rowObj);
            }

            if (dataRows.length === 0) continue;

            allSheetsData.push({
                sheetName,
                headers,
                rows: dataRows,
                totalRows: dataRows.length,
            });
        }

        if (allSheetsData.length === 0) {
            return {
                type: "tabular",
                data: { headers: [], rows: [], totalRows: 0, sheetName: "" },
            };
        }

        if (allSheetsData.length === 1) {
            return { type: "tabular", data: allSheetsData[0] };
        }

        return { type: "tabular", data: allSheetsData };
    }
}

function findNonEmptyColumns(rawRows: unknown[][], colCount: number): number[] {
    const nonEmpty: number[] = [];

    for (let col = 0; col < colCount; col++) {
        const hasData = rawRows.some((row) => {
            const val = row[col];
            return val !== null && val !== undefined && String(val).trim() !== "";
        });

        if (hasData) {
            nonEmpty.push(col);
        }
    }

    return nonEmpty;
}

function detectHeaderRow(rawRows: unknown[][], nonEmptyColIndices: number[]): number {
    let bestIdx = 0;
    let bestScore = 0;

    const maxRows = Math.min(20, rawRows.length);

    for (let i = 0; i < maxRows; i++) {
        const row = rawRows[i];
        if (!row) continue;

        let nonEmpty = 0;
        let textCells = 0;

        for (const col of nonEmptyColIndices) {
            const c = row[col];
            if (c != null && String(c).trim() !== "") {
                nonEmpty++;
                if (typeof c === "string" && c.trim().length > 0) {
                    textCells++;
                }
            }
        }

        const score = nonEmpty * 2 + textCells;

        if (score > bestScore && nonEmpty >= 3) {
            bestScore = score;
            bestIdx = i;
        }
    }

    return bestIdx;
}

export class CsvParser implements Parser {
    readonly format = "csv";

    canParse(_data: Uint8Array, filename?: string): boolean {
        if (filename) {
            const ext = filename.split(".").pop()?.toLowerCase();
            return ext === "csv" || ext === "tsv";
        }
        return false;
    }

    parse(data: Uint8Array, options?: ParserOptions): RawContent {
        const text = new TextDecoder().decode(data);
        const delimiter = options?.delimiter ?? this.detectDelimiter(text);

        const lines = text
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

        if (lines.length === 0) {
            return {
                type: "tabular",
                data: { headers: [], rows: [], totalRows: 0, sheetName: "csv" },
            };
        }

        const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
        const dataRows: Record<string, unknown>[] = [];

        for (let i = 1; i < lines.length; i++) {
            const values = this.splitCSVLine(lines[i], delimiter);
            if (values.every((v) => v === "")) continue;

            const rowObj: Record<string, unknown> = {};
            for (let j = 0; j < headers.length; j++) {
                rowObj[headers[j]] = values[j]?.trim().replace(/^"|"$/g, "") ?? null;
            }
            dataRows.push(rowObj);
        }

        return {
            type: "tabular",
            data: { headers, rows: dataRows, totalRows: dataRows.length, sheetName: "csv" },
        };
    }

    private detectDelimiter(text: string): string {
        const firstLine = text.split(/\r?\n/)[0] ?? "";
        const tabCount = (firstLine.match(/\t/g) ?? []).length;
        const commaCount = (firstLine.match(/,/g) ?? []).length;
        const semicolonCount = (firstLine.match(/;/g) ?? []).length;

        if (tabCount > commaCount && tabCount > semicolonCount) return "\t";
        if (semicolonCount > commaCount) return ";";
        return ",";
    }

    private splitCSVLine(line: string, delimiter: string): string[] {
        const result: string[] = [];
        let current = "";
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === delimiter && !inQuotes) {
                result.push(current);
                current = "";
            } else {
                current += char;
            }
        }
        result.push(current);
        return result;
    }
}

export class ParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ParseError";
    }
}
