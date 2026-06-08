import type { LLMConfig } from "../types.ts";
import type { LLMRequestConfig, LLMToolCallResponse } from "./types.ts";
import { DEFAULT_LLM_CONFIG } from "./types.ts";
import type { LLMColumnMappingResponse } from "../mapping/types.ts";

export class LLMClient {
    private config: LLMRequestConfig;

    constructor(config: LLMConfig) {
        this.config = {
            model: config.model ?? DEFAULT_LLM_CONFIG.model!,
            baseUrl: config.baseUrl ?? DEFAULT_LLM_CONFIG.baseUrl!,
            apiKey: config.apiKey,
            maxTokens: config.maxTokens ?? DEFAULT_LLM_CONFIG.maxTokens!,
            temperature: config.temperature ?? DEFAULT_LLM_CONFIG.temperature!,
            stream: config.stream ?? DEFAULT_LLM_CONFIG.stream!,
        };
    }

    extract(
        systemPrompt: string,
        content: string,
        toolParameters: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<{ result: LLMToolCallResponse; tokensUsed: number }> {
        return this.sendToolRequest("extract_items", systemPrompt, content, toolParameters, signal);
    }

    analyzeColumns(
        systemPrompt: string,
        content: string,
        toolParameters: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<{ result: LLMColumnMappingResponse; tokensUsed: number }> {
        return this.sendToolRequest(
            "analyze_columns",
            systemPrompt,
            content,
            toolParameters,
            signal,
        );
    }

    private async sendToolRequest<T>(
        toolName: string,
        systemPrompt: string,
        content: string,
        toolParameters: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<{ result: T; tokensUsed: number }> {
        const useStream = this.config.stream;

        const baseBody = {
            model: this.config.model,
            messages: [
                { role: "system" as const, content: systemPrompt },
                { role: "user" as const, content },
            ],
            tools: [
                {
                    type: "function" as const,
                    function: {
                        name: toolName,
                        description: toolName === "extract_items"
                            ? "Extrae los items de inventario del contenido del documento analizado"
                            : "Analiza las columnas del documento y devuelve el mapeo a campos del esquema",
                        parameters: toolParameters,
                    },
                },
            ],
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens,
        };

        const fetchBody = useStream
            ? { ...baseBody, stream: true, stream_options: { include_usage: true } }
            : { ...baseBody, thinking: { type: "disabled" as const } };

        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(fetchBody),
            signal,
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => "Unknown error");
            throw new LLMError(
                `LLM API request failed with status ${response.status}: ${errorBody}`,
                response.status,
            );
        }

        if (useStream && response.body) {
            try {
                return await this.parseStreamResponse<T>(toolName, response.body);
            } catch (streamError) {
                if (
                    streamError instanceof LLMError &&
                    streamError.message.includes("did not return any tool call")
                ) {
                    return await this.sendNonStreamRequest<T>(
                        toolName,
                        baseBody,
                        signal,
                    );
                }
                throw streamError;
            }
        }

        return await this.sendNonStreamRequest<T>(toolName, baseBody, signal);
    }

    private async sendNonStreamRequest<T>(
        toolName: string,
        baseBody: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<{ result: T; tokensUsed: number }> {
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify({ ...baseBody, thinking: { type: "disabled" as const } }),
            signal,
        });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => "Unknown error");
            throw new LLMError(
                `LLM API request failed with status ${response.status}: ${errorBody}`,
                response.status,
            );
        }

        const data = await response.json() as LLMApiResponse;

        const tokensUsed = data.usage?.total_tokens ?? 0;

        const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];

        if (!toolCall) {
            const finishReason = data.choices?.[0]?.finish_reason;
            const content = data.choices?.[0]?.message?.content;

            if (finishReason === "length") {
                throw new LLMError(
                    "LLM response truncated due to max_tokens limit. Increase max_tokens in LLMConfig.",
                    0,
                );
            }

            throw new LLMError(
                `LLM did not return a tool call. Raw response: ${content ?? "empty"}`,
                0,
            );
        }

        if (toolCall.function.name !== toolName) {
            throw new LLMError(
                `Unexpected tool call: ${toolCall.function.name}, expected: ${toolName}`,
                0,
            );
        }

        let parsed: T;
        try {
            parsed = JSON.parse(toolCall.function.arguments);
        } catch (_parseError) {
            const raw = toolCall.function.arguments;
            const preview = raw.slice(0, 500);
            const endsIncomplete = raw.length > 0 && !raw.endsWith("}") && !raw.endsWith("]");

            const message = endsIncomplete
                ? `LLM response truncated (${raw.length} chars). Increase max_tokens. Preview: ${preview}...`
                : `Failed to parse LLM tool call arguments: ${preview}`;

            throw new LLMError(message, 0);
        }

        return { result: parsed, tokensUsed };
    }

    private async parseStreamResponse<T>(
        toolName: string,
        body: ReadableStream<Uint8Array>,
    ): Promise<{ result: T; tokensUsed: number }> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (value) {
                    fullText += decoder.decode(value, { stream: !done });
                }
                if (done) break;
            }
        } finally {
            try {
                reader.releaseLock();
            } catch {
                // lock already released
            }
        }

        let toolCallName = "";
        let accumulatedArgs = "";
        let finishReason = "";
        let tokensUsed = 0;

        const lines = fullText.split("\n");

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;

            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;

            try {
                const parsed = JSON.parse(data);

                if (parsed.choices?.[0]?.finish_reason) {
                    finishReason = parsed.choices[0].finish_reason;
                }

                if (parsed.usage?.total_tokens) {
                    tokensUsed = parsed.usage.total_tokens;
                }

                const delta = parsed.choices?.[0]?.delta;
                const toolCalls = delta?.tool_calls;

                if (toolCalls?.length) {
                    const func = toolCalls[0]?.function;
                    if (func?.name) {
                        toolCallName = func.name;
                    }
                    if (func?.arguments) {
                        accumulatedArgs += func.arguments;
                    }
                }
            } catch {
                // skip malformed chunks
            }
        }

        if (finishReason === "length") {
            throw new LLMError(
                "LLM streaming response truncated due to max_tokens limit. Increase max_tokens in LLMConfig.",
                0,
            );
        }

        if (toolCallName && toolCallName !== toolName) {
            throw new LLMError(
                `Unexpected tool call: ${toolCallName}, expected: ${toolName}`,
                0,
            );
        }

        if (!accumulatedArgs) {
            throw new LLMError(
                "LLM did not return any tool call arguments in streaming response.",
                0,
            );
        }

        let parsed: T;
        try {
            parsed = JSON.parse(accumulatedArgs);
        } catch (_parseError) {
            const preview = accumulatedArgs.slice(0, 500);
            const endsIncomplete = accumulatedArgs.length > 0 &&
                !accumulatedArgs.endsWith("}") &&
                !accumulatedArgs.endsWith("]");

            const message = endsIncomplete
                ? `LLM streaming response truncated (${accumulatedArgs.length} chars). Increase max_tokens. Preview: ${preview}...`
                : `Failed to parse LLM streaming tool call arguments: ${preview}`;

            throw new LLMError(message, 0);
        }

        return { result: parsed, tokensUsed };
    }
}

export class LLMError extends Error {
    statusCode: number;

    constructor(message: string, statusCode: number) {
        super(message);
        this.name = "LLMError";
        this.statusCode = statusCode;
    }
}

interface LLMApiResponse {
    choices?: Array<{
        finish_reason?: string;
        message?: {
            content?: string;
            tool_calls?: Array<{
                function: {
                    name: string;
                    arguments: string;
                };
            }>;
        };
    }>;
    usage?: {
        total_tokens: number;
    };
}
