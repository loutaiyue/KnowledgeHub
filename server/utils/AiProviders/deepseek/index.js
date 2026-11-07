const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");
const { MODEL_MAP } = require("../modelMap");
const {
  handleDefaultStreamResponseV2,
  formatChatHistory,
} = require("../../helpers/chat/responses");
const {
  temperatureParam,
  maxTokensParam,
} = require("../../agents/aibitat/providers/helpers/tooled");
const {
  modelsDevReasoningCapabilities,
  reasoningParams,
} = require("../../helpers/reasoningEffort");

class DeepSeekLLM {
  constructor(embedder = null, modelPreference = null) {
    if (!process.env.DEEPSEEK_API_KEY)
      throw new Error("No DeepSeek API key was set.");
    this.className = "DeepSeekLLM";
    const { OpenAI: OpenAIApi } = require("openai");

    this.openai = new OpenAIApi({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com/v1",
      fetch: globalThis.fetch,
      defaultHeaders: {
        Connection: "close",
      },
    });
    this.model =
      modelPreference || process.env.DEEPSEEK_MODEL_PREF || "deepseek-flash";
    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.log(
      `Initialized ${this.model} with context window ${this.promptWindowLimit()}`
    );
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.className}]\x1b[0m ${text}`, ...args);
  }

  #appendContext(contextTexts = []) {
    if (!contextTexts || !contextTexts.length) return "";
    return (
      "\nContext:\n" +
      contextTexts
        .map((text, i) => {
          return `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`;
        })
        .join("")
    );
  }

  /**
   * Generates appropriate content array for a message + attachments.
   * Models without image input (eg: deepseek-v4-pro) ignore the image blocks.
   * @param {{userPrompt:string, attachments: import("../../helpers").Attachment[]}}
   * @returns {string|object[]}
   */
  #generateContent({ userPrompt, attachments = [] }) {
    if (!attachments.length) return userPrompt;

    const content = [{ type: "text", text: userPrompt }];
    for (let attachment of attachments) {
      content.push({
        type: "image_url",
        image_url: {
          url: attachment.contentString,
        },
      });
    }
    return content.flat();
  }

  streamingEnabled() {
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit(modelName) {
    return MODEL_MAP.get("deepseek", modelName) ?? 8192;
  }

  promptWindowLimit() {
    return MODEL_MAP.get("deepseek", this.model) ?? 8192;
  }

  async isValidChatCompletionModel(_modelName = "") {
    return true;
  }

  constructPrompt({
    systemPrompt = "",
    contextTexts = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [],
  }) {
    const prompt = {
      role: "system",
      content: `${systemPrompt}${this.#appendContext(contextTexts)}`,
    };
    return [
      prompt,
      ...formatChatHistory(chatHistory, this.#generateContent),
      {
        role: "user",
        content: this.#generateContent({ userPrompt, attachments }),
      },
    ];
  }

  /**
   * Parses and prepends reasoning from the response and returns the full text response.
   * @param {Object} response
   * @returns {string}
   */
  #parseReasoningFromResponse({ message }) {
    let textResponse = message?.content;
    if (
      !!message?.reasoning_content &&
      message.reasoning_content.trim().length > 0
    )
      textResponse = `<think>${message.reasoning_content}</think>${textResponse}`;
    return textResponse;
  }

  /**
   * Returns the reasoning capabilities models.dev lists for the model and
   * vision support from the `input_modalities` DeepSeek's /models returns.
   * Vision is "unknown" when the model is not listed (eg: legacy aliases).
   * @returns {Promise<{reasoning: 'unknown' | boolean, reasoningOptions: string[], vision: 'unknown' | boolean}>}
   */
  async getModelCapabilities() {
    const [reasoning, models] = await Promise.all([
      modelsDevReasoningCapabilities("deepseek", this.model),
      this.openai.models.list().catch(() => ({ data: [] })),
    ]);
    const modalities = models.data.find(
      (model) => model.id === this.model
    )?.input_modalities;

    return {
      ...reasoning,
      vision: Array.isArray(modalities)
        ? modalities.includes("image")
        : "unknown",
    };
  }

  #hasBalancedJsonEnvelope(rawContent = "") {
    if (typeof rawContent !== "string") return false;
    let trimmed = rawContent.trim();
    if (!trimmed) return false;

    if (trimmed.startsWith("```")) {
      const openMatch = trimmed.match(/^```(?:json)?(?:[ \t]*\r?\n|[ \t]+)/i);
      if (
        !openMatch ||
        !trimmed.endsWith("```") ||
        trimmed.length <= openMatch[0].length + 3
      ) {
        return false;
      }
      trimmed = trimmed.slice(openMatch[0].length, -3).trim();
    }

    if (
      trimmed.length < 2 ||
      !trimmed.startsWith("{") ||
      !trimmed.endsWith("}")
    ) {
      return false;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth < 0) return false;
        if (depth === 0 && i !== trimmed.length - 1) return false;
      }
    }

    return !inString && !escaped && depth === 0;
  }

  async #collectStreamCompletion(stream) {
    let content = "";
    let reasoningContent = "";
    let finishReason = null;
    let hasChoices = false;
    const usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    try {
      for await (const chunk of stream) {
        if (
          chunk &&
          Object.prototype.hasOwnProperty.call(chunk, "usage") &&
          !!chunk.usage &&
          Object.values(chunk.usage).length > 0
        ) {
          if (
            Object.prototype.hasOwnProperty.call(chunk.usage, "prompt_tokens")
          ) {
            usage.prompt_tokens = Number(chunk.usage.prompt_tokens) || 0;
          }
          if (
            Object.prototype.hasOwnProperty.call(
              chunk.usage,
              "completion_tokens"
            )
          ) {
            usage.completion_tokens =
              Number(chunk.usage.completion_tokens) || 0;
          }
          if (
            Object.prototype.hasOwnProperty.call(chunk.usage, "total_tokens")
          ) {
            usage.total_tokens = Number(chunk.usage.total_tokens) || 0;
          } else {
            usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          }
        }

        const choice = chunk?.choices?.[0];
        if (!choice) continue;
        hasChoices = true;

        const delta = choice.delta;
        const reasoningToken =
          typeof delta?.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta?.reasoning === "string"
              ? delta.reasoning
              : "";
        if (reasoningToken) {
          reasoningContent += reasoningToken;
        }
        if (typeof delta?.content === "string" && delta.content.length > 0) {
          content += delta.content;
        }

        if (
          Object.prototype.hasOwnProperty.call(choice, "finish_reason") &&
          choice.finish_reason !== "" &&
          choice.finish_reason !== null
        ) {
          finishReason = choice.finish_reason;
        }
      }
    } catch (e) {
      const hasCompleteJsonEnvelope = this.#hasBalancedJsonEnvelope(content);
      if (finishReason === null && !hasCompleteJsonEnvelope) {
        if (e && typeof e === "object") {
          e.partialRawText = reasoningContent
            ? `<think>${reasoningContent}</think>${content}`
            : content;
        }
        throw e;
      }
    }

    if (!hasChoices) return {};

    return {
      choices: [
        {
          message: {
            content,
            ...(reasoningContent
              ? { reasoning_content: reasoningContent }
              : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage,
    };
  }

  async getChatCompletion(
    messages = null,
    {
      temperature = this.temperature,
      reasoningEffort = null,
      maxTokens = null,
    } = {}
  ) {
    const effectiveReasoningEffort =
      reasoningEffort ??
      (maxTokens !== null &&
      modelsDevReasoningCapabilities(
        "deepseek",
        this.model
      ).reasoningOptions.includes("off")
        ? "off"
        : null);
    const result = await LLMPerformanceMonitor.measureAsyncFunction(
      this.openai.chat.completions
        .create({
          model: this.model,
          stream: true,
          messages,
          ...temperatureParam(temperature),
          ...reasoningParams("deepseek", effectiveReasoningEffort, this.model),
          ...maxTokensParam(maxTokens),
        })
        .then(async (response) => {
          if (
            response &&
            typeof response[Symbol.asyncIterator] === "function"
          ) {
            return await this.#collectStreamCompletion(response);
          }
          return response;
        })
        .catch((e) => {
          if (e instanceof Error) {
            if (
              e.name === "Error" &&
              typeof e.constructor?.name === "string" &&
              e.constructor.name !== "Error"
            ) {
              e.name = e.constructor.name;
            }
            throw e;
          }
          const err = new Error(e?.message ?? String(e));
          if (typeof e?.name === "string" && e.name) err.name = e.name;
          if (e?.status !== undefined) err.status = e.status;
          if (e?.code !== undefined) err.code = e.code;
          if (e?.cause !== undefined) err.cause = e.cause;
          throw err;
        })
    );

    if (
      !result?.output?.hasOwnProperty("choices") ||
      result?.output?.choices?.length === 0
    )
      throw new Error(
        `Invalid response body returned from DeepSeek: ${JSON.stringify(result.output)}`
      );

    return {
      textResponse: this.#parseReasoningFromResponse(result.output.choices[0]),
      metrics: {
        prompt_tokens: result.output.usage?.prompt_tokens || 0,
        completion_tokens: result.output.usage?.completion_tokens || 0,
        total_tokens: result.output.usage?.total_tokens || 0,
        outputTps:
          (result.output.usage?.completion_tokens || 0) / result.duration,
        duration: result.duration,
        model: this.model,
        provider: this.className,
        timestamp: new Date(),
      },
    };
  }

  async streamGetChatCompletion(
    messages = null,
    { temperature = this.temperature, reasoningEffort = null } = {}
  ) {
    const measuredStreamRequest = await LLMPerformanceMonitor.measureStream({
      func: this.openai.chat.completions.create({
        model: this.model,
        stream: true,
        messages,
        ...temperatureParam(temperature),
        ...reasoningParams("deepseek", reasoningEffort, this.model),
      }),
      messages,
      runPromptTokenCalculation: false,
      modelTag: this.model,
      provider: this.className,
    });

    return measuredStreamRequest;
  }

  handleStream(response, stream, responseProps) {
    return handleDefaultStreamResponseV2(response, stream, responseProps);
  }

  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }
}

module.exports = {
  DeepSeekLLM,
};
