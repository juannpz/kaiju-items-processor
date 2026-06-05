import type { LLMConfig } from "../types.ts";
import type { LLMRequestConfig, LLMToolCallResponse } from "./types.ts";
import { DEFAULT_LLM_CONFIG } from "./types.ts";

export class LLMClient {
    private config: LLMRequestConfig;

    constructor(config: LLMConfig) {
        this.config = {
            model: config.model ?? DEFAULT_LLM_CONFIG.model!,
            baseUrl: config.baseUrl ?? DEFAULT_LLM_CONFIG.baseUrl!,
            apiKey: config.apiKey,
            maxTokens: config.maxTokens ?? DEFAULT_LLM_CONFIG.maxTokens!,
            temperature: config.temperature ?? DEFAULT_LLM_CONFIG.temperature!,
        };
    }

    async extract(
        systemPrompt: string,
        content: string,
        toolParameters: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<{ result: LLMToolCallResponse; tokensUsed: number }> {
        const requestBody = {
            model: this.config.model,
            messages: [
                { role: "system" as const, content: systemPrompt },
                { role: "user" as const, content },
            ],
            tools: [
                {
                    type: "function" as const,
                    function: {
                        name: "extract_items",
                        description:
                            "Extrae los items de inventario del contenido del documento analizado",
                        parameters: toolParameters,
                    },
                },
            ],
            temperature: this.config.temperature,
            max_tokens: this.config.maxTokens,
        };

        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(requestBody),
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

        if (toolCall.function.name !== "extract_items") {
            throw new LLMError(
                `Unexpected tool call: ${toolCall.function.name}`,
                0,
            );
        }

        let parsed: LLMToolCallResponse;
        try {
            parsed = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
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
