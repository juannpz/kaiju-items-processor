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

        const allSheetsData: MultiSheetTabularData[] = [];

        for (let s = 0; s < workbook.SheetNames.length; s++) {
            const sheetName = workbook.SheetNames[s];
            const sheet = workbook.Sheets[sheetName];
            const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
                header: 1,
                defval: null,
            });

            if (rawRows.length === 0) continue;

            const filledRows = rawRows.filter((row) => {
                const nonEmpty = row.filter(
                    (c) => c != null && String(c).trim() !== "",
                ).length;
                return nonEmpty >= 2;
            });

            if (filledRows.length < 2) continue;

            const headerRow = options?.headerRow ?? detectHeaderRow(rawRows);

            const headers = (rawRows[headerRow] as unknown[] ?? [])
                .map((h, idx) => {
                    if (h != null && String(h).trim() !== "") return String(h).trim();
                    return `col_${idx}`;
                });

            const dataRowsStart = headerRow + 1;
            const dataRows: Record<string, unknown>[] = [];

            for (let i = dataRowsStart; i < rawRows.length; i++) {
                const row = rawRows[i] as unknown[];
                if (!row || row.every((cell) => cell == null || String(cell).trim() === "")) {
                    continue;
                }

                const rowObj: Record<string, unknown> = {};
                for (let j = 0; j < headers.length; j++) {
                    const value = row[j];
                    rowObj[headers[j]] = value ?? null;
                }
                dataRows.push(rowObj);
            }

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

        const firstSheet = allSheetsData[0];

        if (allSheetsData.length === 1) {
            return { type: "tabular", data: { ...firstSheet, sheetName: firstSheet.sheetName } };
        }

        return { type: "tabular", data: mergeSheets(allSheetsData, allSheetsData[0]) };
    }
}

function detectHeaderRow(rawRows: unknown[][]): number {
    let bestIdx = 0;
    let bestScore = 0;

    const maxRows = Math.min(20, rawRows.length);

    for (let i = 0; i < maxRows; i++) {
        const row = rawRows[i];
        if (!row) continue;
        const nonEmpty = row.filter((c) => c != null && String(c).trim() !== "").length;
        const textCells = row.filter(
            (c) => c != null && typeof c === "string" && c.trim().length > 0,
        ).length;

        const score = nonEmpty * 2 + textCells;

        if (score > bestScore && nonEmpty >= 3) {
            bestScore = score;
            bestIdx = i;
        }
    }

    return bestIdx;
}

function mergeSheets(
    sheets: MultiSheetTabularData[],
    primarySheet: MultiSheetTabularData,
): TabularData {
    const allRows: Record<string, unknown>[] = [];
    const headers = primarySheet.headers;

    for (const sheet of sheets) {
        for (const row of sheet.rows) {
            const merged: Record<string, unknown> = { _sheet: sheet.sheetName };
            for (const h of headers) {
                merged[h] = row[h] ?? null;
            }
            allRows.push(merged);
        }
    }

    return {
        headers,
        rows: allRows,
        totalRows: allRows.length,
        sheetName: sheets.map((s) => s.sheetName).join(", "),
    };
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

interface MultiSheetTabularData extends TabularData {
    sheetName: string;
}

export class ParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ParseError";
    }
}
