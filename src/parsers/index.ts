import type { Parser } from "./types.ts";
import type { DocumentFormat } from "../types.ts";
import { CsvParser, ExcelParser } from "./ExcelParser.ts";
import { PdfParser } from "./PdfParser.ts";

const parsers: Parser[] = [
    new ExcelParser(),
    new CsvParser(),
    new PdfParser(),
];

export { CsvParser, ExcelParser, ParseError } from "./ExcelParser.ts";
export { PdfParseError, PdfParser } from "./PdfParser.ts";
export type { Parser, ParserOptions, RawContent, TabularData } from "./types.ts";

export function detectFormat(data: Uint8Array, filename?: string): DocumentFormat {
    for (const parser of parsers) {
        if (parser.canParse(data, filename)) {
            return parser.format as DocumentFormat;
        }
    }
    throw new FormatDetectionError(
        filename
            ? `Could not detect format for file: ${filename}`
            : "Could not detect document format from provided data",
    );
}

export function getParser(
    format: DocumentFormat | "auto",
    data: Uint8Array,
    filename?: string,
): Parser {
    const resolvedFormat = format === "auto" ? detectFormat(data, filename) : format;

    for (const parser of parsers) {
        if (parser.format === resolvedFormat) return parser;
    }

    throw new FormatDetectionError(`No parser available for format: ${resolvedFormat}`);
}

export class FormatDetectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FormatDetectionError";
    }
}
