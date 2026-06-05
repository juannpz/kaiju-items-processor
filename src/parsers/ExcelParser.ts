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
        const sheetIndex = options?.sheetIndex ?? 0;
        const sheetName = workbook.SheetNames[sheetIndex];

        if (sheetName === undefined) {
            throw new ParseError("No sheets found in workbook");
        }

        const sheet = workbook.Sheets[sheetName];
        const headerRow = options?.headerRow ?? 0;
        const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
            header: 1,
            defval: null,
        });

        if (rawRows.length === 0) {
            return {
                type: "tabular",
                data: { headers: [], rows: [], totalRows: 0 },
            };
        }

        const headerStart = headerRow;
        const headers = (rawRows[headerStart] as unknown[] ?? [])
            .map((
                h,
            ) => (h != null ? String(h).trim() : `column_${rawRows[headerStart].indexOf(h)}`));

        const dataRowsStart = headerStart + 1;
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

        const tabularData: TabularData = {
            headers,
            rows: dataRows,
            totalRows: dataRows.length,
        };

        return { type: "tabular", data: tabularData };
    }
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
                data: { headers: [], rows: [], totalRows: 0 },
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
            data: { headers, rows: dataRows, totalRows: dataRows.length },
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
