/* eslint-env jest, node */

/**
 * Persistence rules for API `@agent` chats (fixes #5060).
 *
 * Every read path scopes history by the exact triple
 * (user_id, thread_id, api_session_id) plus `include: true`:
 *   - recentChatHistory (LLM context for subsequent chats)
 *   - EphemeralAgentHandler.#chatHistory (agent memory)
 *   - GET /v1/workspace/:slug/thread/:threadSlug/chats
 *   - frontend thread/workspace history queries
 * So the agent save MUST persist the same triple it was invoked with,
 * exactly like the non-agent saves in the same file, or the turn is
 * invisible everywhere.
 *
 * The only parameter combinations the v1 endpoints can produce:
 *   POST /v1/workspace/:slug/chat & /stream-chat
 *     -> user: null, thread: null, sessionId: null | string
 *   POST /v1/workspace/:slug/thread/:threadSlug/chat & /stream-chat
 *     -> user: null | users, thread: workspace_threads, sessionId: never
 * Notably `user`/`thread` and `sessionId` are mutually exclusive — a
 * user-attributed row can never carry an api_session_id, which is what
 * keeps forWorkspaceByApiSessionId's `user_id: null` filter safe.
 */

jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    new: jest.fn(),
    markThreadHistoryInvalidV2: jest.fn(),
  },
}));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: {
    sendTelemetry: jest.fn(),
  },
}));
jest.mock("../../../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn((metrics) => metrics),
}));
jest.mock("../../../utils/chats/index", () => ({
  chatPrompt: jest.fn(),
  sourceIdentifier: jest.fn(),
  recentChatHistory: jest.fn(),
  grepAllSlashCommands: jest.fn(async (message) => message),
}));
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  resolveProviderConnector: jest.fn(),
}));
jest.mock("../../../utils/helpers/chat/responses", () => ({
  writeResponseChunk: jest.fn(),
}));
jest.mock("../../../utils/helpers/abortSignals", () => ({
  abortConnectorOnClientDisconnect: jest.fn(),
}));
jest.mock("../../../utils/DocumentManager", () => ({
  DocumentManager: jest.fn(),
}));
jest.mock("../../../utils/collectorApi", () => ({
  CollectorApi: jest.fn(),
}));
jest.mock("../../../utils/files", () => ({
  hotdirPath: "/tmp/anything-llm-test-hotdir",
  normalizePath: jest.fn((filePath) => filePath),
  isWithin: jest.fn(() => true),
  sanitizeFileName: jest.fn((filename) => filename),
}));
jest.mock("../../../utils/agents/ephemeral", () => {
  const waitForClose = jest.fn();
  const streamAgentEvents = jest.fn();
  const EphemeralAgentHandler = jest.fn().mockImplementation(function (args) {
    this.args = args;
    this.init = jest.fn().mockResolvedValue();
    this.createAIbitat = jest.fn().mockResolvedValue();
    this.startAgentCluster = jest.fn();
    this.getPendingOutputs = jest.fn().mockReturnValue([]);
  });
  EphemeralAgentHandler.isAgentInvocation = jest.fn();

  const EphemeralEventListener = jest.fn().mockImplementation(function () {
    this.waitForClose = waitForClose;
    this.streamAgentEvents = streamAgentEvents;
  });

  return {
    EphemeralAgentHandler,
    EphemeralEventListener,
    __mocks: {
      waitForClose,
      streamAgentEvents,
    },
  };
});

const { ApiChatHandler } = require("../../../utils/chats/apiChatHandler");
const { WorkspaceChats } = require("../../../models/workspaceChats");
const {
  getVectorDbClass,
  resolveProviderConnector,
} = require("../../../utils/helpers");
const { writeResponseChunk } = require("../../../utils/helpers/chat/responses");
const {
  EphemeralAgentHandler,
  __mocks: ephemeralMocks,
} = require("../../../utils/agents/ephemeral");

const workspace = { id: 1, slug: "workspace", chatMode: "chat" };
const attachments = [
  {
    name: "image.png",
    mime: "image/png",
    contentString: "data:image/png;base64,abc123",
  },
];
const agentResult = {
  thoughts: ["Look up the requested data"],
  textResponse: "Agent result",
  outputs: [],
  metrics: {},
  citations: [],
};

/**
 * Every (user, thread, sessionId) combination a v1 endpoint can actually
 * send into chatSync/streamChat. If an endpoint ever adds a new combination
 * it belongs in this table.
 */
describe("chatSync answer verification", () => {
  const verifier = require("../../../utils/chats/answerVerification");
  const { DocumentManager } = require("../../../utils/DocumentManager");
  const chats = require("../../../utils/chats/index");
  const savedEnv = process.env.RAG_ANSWER_VERIFICATION_ENABLED;
  let connector;
  let vectorDb;
  let verifySpy;
  const sources = [
    { id: "chunk1", title: "report", text: "Revenue rose 12%." },
  ];
  const metrics = { prompt_tokens: 23, completion_tokens: 8, total_tokens: 31 };
  const assessment = (verdict = "supported", mixed = false) =>
    JSON.stringify({
      summary: "Assessment",
      claims: [
        {
          claim: "Revenue rose 12%.",
          answerQuote: "Revenue rose 12%.",
          verdict,
          evidence:
            verdict === "supported"
              ? [{ evidenceId: "ev-0", quote: sources[0].text }]
              : [],
        },
        ...(mixed
          ? [
              {
                claim: "Profit doubled.",
                answerQuote: "Profit doubled.",
                verdict: "unsupported",
                evidence: [],
              },
            ]
          : []),
      ],
    });
  const invoke = () =>
    ApiChatHandler.chatSync({
      workspace,
      message: "Original question",
      mode: "chat",
    });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_ANSWER_VERIFICATION_ENABLED = "true";
    verifySpy = jest.spyOn(verifier, "verifyAnswer");
    EphemeralAgentHandler.isAgentInvocation.mockResolvedValue(false);
    WorkspaceChats.new.mockResolvedValue({ chat: { id: 123 } });
    chats.grepAllSlashCommands.mockImplementation(
      async () => "Expanded question"
    );
    chats.chatPrompt.mockResolvedValue("Workspace instructions");
    chats.recentChatHistory.mockResolvedValue({
      rawHistory: [],
      chatHistory: [],
    });
    DocumentManager.mockImplementation(() => ({ pinnedDocs: async () => [] }));
    connector = {
      className: "GenericOpenAiLLM",
      model: "gpt-4",
      maxTokens: 1024,
      promptWindowLimit: jest.fn(() => 8192),
      constructPrompt: jest.fn(({ systemPrompt, contextTexts }) => [
        {
          role: "system",
          content: systemPrompt + JSON.stringify(contextTexts),
        },
      ]),
      compressMessages: jest.fn(async (args) =>
        connector.constructPrompt(args)
      ),
      getChatCompletion: jest
        .fn()
        .mockResolvedValueOnce({ textResponse: "Revenue rose 12%.", metrics })
        .mockResolvedValue({
          textResponse: assessment(),
          metrics: { total_tokens: 999 },
        }),
    };
    resolveProviderConnector.mockResolvedValue({
      connector,
      routingMetadata: null,
    });
    vectorDb = {
      hasNamespace: jest.fn().mockResolvedValue(true),
      namespaceCount: jest.fn().mockResolvedValue(1),
      performSimilaritySearch: jest.fn().mockResolvedValue({
        contextTexts: [sources[0].text],
        sources,
        message: null,
      }),
    };
    getVectorDbClass.mockReturnValue(vectorDb);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    chats.grepAllSlashCommands.mockImplementation(async (message) => message);
    if (savedEnv === undefined)
      delete process.env.RAG_ANSWER_VERIFICATION_ENABLED;
    else process.env.RAG_ANSWER_VERIFICATION_ENABLED = savedEnv;
  });

  test.each([undefined, "false", "TRUE", "1"])(
    "flag %s preserves the original response exactly",
    async (flag) => {
      if (flag === undefined)
        delete process.env.RAG_ANSWER_VERIFICATION_ENABLED;
      else process.env.RAG_ANSWER_VERIFICATION_ENABLED = flag;
      expect(await invoke()).toEqual({
        id: expect.any(String),
        type: "textResponse",
        close: true,
        error: null,
        chatId: 123,
        textResponse: "Revenue rose 12%.",
        sources,
        metrics,
      });
      expect(verifySpy).not.toHaveBeenCalled();
      expect(connector.getChatCompletion).toHaveBeenCalledTimes(1);
    }
  );

  test.each([
    ["supported", "supported", false],
    ["partially_supported", "supported", true],
    ["unsupported", "unsupported", false],
  ])(
    "returns %s without altering answer, sources, metrics or persistence",
    async (status, verdict, mixed) => {
      connector.getChatCompletion.mockResolvedValue({
        textResponse: assessment(verdict, mixed),
      });
      const result = await invoke();
      expect(result).toMatchObject({
        textResponse: "Revenue rose 12%.",
        sources,
        metrics,
        verification: {
          status,
          verificationScope: "model_extracted_claims_only",
        },
      });
      const [messages, options] = connector.getChatCompletion.mock.calls[1];
      expect(messages).toHaveLength(2);
      expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(JSON.parse(messages[1].content)).toEqual({
        question: "Original question",
        answer: "Revenue rose 12%.",
        evidence: [{ evidenceId: "ev-0", text: sources[0].text }],
      });
      expect(options).toEqual({ temperature: 0 });
      expect(connector.compressMessages).toHaveBeenCalledTimes(1);
      expect(WorkspaceChats.new.mock.calls[0][0].response).toEqual({
        text: "Revenue rose 12%.",
        sources,
        attachments: [],
        type: "chat",
        metrics,
      });
    }
  );

  test("provider failure retains original answer and returns a safe error", async () => {
    connector.getChatCompletion.mockRejectedValue(
      new Error("secret provider response")
    );
    const result = await invoke();
    expect(result.textResponse).toBe("Revenue rose 12%.");
    expect(result.verification).toMatchObject({
      status: "verification_error",
      error: { code: "EVALUATION_FAILED" },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("no contexts skips the evaluator", async () => {
    vectorDb.namespaceCount.mockResolvedValue(0);
    const result = await invoke();
    expect(result.verification.status).toBe("skipped");
    expect(connector.getChatCompletion).toHaveBeenCalledTimes(1);
  });

  test("empty generation skips verification", async () => {
    connector.getChatCompletion
      .mockReset()
      .mockResolvedValue({ textResponse: "", metrics });
    expect((await invoke()).type).toBe("abort");
    expect(verifySpy).not.toHaveBeenCalled();
    expect(connector.getChatCompletion).toHaveBeenCalledTimes(1);
  });

  test("generation rejection skips verification", async () => {
    connector.getChatCompletion
      .mockReset()
      .mockRejectedValue(new Error("generation failed"));
    await expect(invoke()).rejects.toThrow("generation failed");
    expect(verifySpy).not.toHaveBeenCalled();
  });

  test("agent diversion never invokes verifier", async () => {
    EphemeralAgentHandler.isAgentInvocation.mockResolvedValue(true);
    ephemeralMocks.waitForClose.mockResolvedValue(agentResult);
    expect((await invoke()).verification).toBeUndefined();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(connector.getChatCompletion).not.toHaveBeenCalled();
  });

  test("supports DeepSeekLLM with explicit maxTokens: 4096 and reasoning output", async () => {
    connector.className = "DeepSeekLLM";
    connector.model = "deepseek-reasoner";
    delete connector.maxTokens;
    connector.getChatCompletion
      .mockReset()
      .mockResolvedValueOnce({
        textResponse: "<think>Analyzing revenue report...</think>Revenue rose 12%.",
        metrics,
      })
      .mockResolvedValueOnce({
        textResponse: `<think>Validating claim against ev-0...</think>${assessment()}`,
        metrics: { total_tokens: 999 },
      });

    const result = await invoke();
    expect(result).toMatchObject({
      textResponse: "<think>Analyzing revenue report...</think>Revenue rose 12%.",
      sources,
      metrics,
      verification: {
        status: "supported",
        verificationScope: "model_extracted_claims_only",
        claims: [
          expect.objectContaining({
            claim: "Revenue rose 12%.",
            answerQuote: "Revenue rose 12%.",
            answerLocation: {
              status: "located",
              ranges: [{ start: 0, end: 17 }],
            },
            verdict: "supported",
          }),
        ],
      },
    });
    const [, options] = connector.getChatCompletion.mock.calls[1];
    expect(options).toEqual({ temperature: 0, maxTokens: 4096 });
  });

  test.each([
    [
      "evaluation_output_budget_unavailable",
      (c) => {
        c.maxTokens = undefined;
      },
    ],
    [
      "evaluation_provider_unsupported",
      (c) => {
        c.className = "AnthropicLLM";
      },
    ],
  ])(
    "skips with skipReason %s without a second model call when provider capabilities are not satisfied",
    async (skipReason, setup) => {
      setup(connector);
      const result = await invoke();
      expect(result.textResponse).toBe("Revenue rose 12%.");
      expect(result.verification).toMatchObject({
        status: "skipped",
        verificationScope: "model_extracted_claims_only",
        reason: skipReason,
        skipReason,
      });
      expect(connector.getChatCompletion).toHaveBeenCalledTimes(1);
    }
  );

  test.each([
    [
      "evaluation_context_too_large",
      (c) => c.promptWindowLimit.mockReturnValue(1024),
    ],
    [
      "evaluation_context_not_preserved",
      (c) =>
        c.compressMessages.mockResolvedValue([
          { role: "system", content: "compressed" },
        ]),
    ],
  ])(
    "fails closed with %s without a second model call",
    async (code, setup) => {
      setup(connector);
      const result = await invoke();
      expect(result.textResponse).toBe("Revenue rose 12%.");
      expect(result.verification).toMatchObject({
        status: "verification_error",
        error: { code },
      });
      expect(connector.getChatCompletion).toHaveBeenCalledTimes(1);
    }
  );

  test("timeout preserves the answer even if the connector ignores cancellation", async () => {
    jest.useFakeTimers();
    let finish;
    connector.getChatCompletion.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = invoke();
    await jest.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.textResponse).toBe("Revenue rose 12%.");
    expect(result.verification.error.code).toBe("EVALUATION_TIMEOUT");
    finish({ textResponse: assessment() });
    await Promise.resolve();
    expect(result.verification.status).toBe("verification_error");
  });

  test("derives contextTexts and sources from unified evidence across pinned, attachment, retrieval, and history", async () => {
    const fs = require("fs");
    const { CollectorApi } = require("../../../utils/collectorApi");
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    jest.spyOn(fs, "writeFileSync").mockImplementation(() => {});

    const pinnedDoc = {
      id: "pin-1",
      title: "pinned.md",
      published: "2026-01-01",
      pageContent: "Pinned policy: operating margin was 18%.",
    };
    const attachedDoc = {
      id: "att-1",
      title: "attached.pdf",
      pageContent: "Attached memo: Q4 bookings grew 9%.",
    };
    const historySource = {
      id: "hist-chunk-1",
      title: "history.pdf",
      published: "2026-01-02",
      text: "Historical note: churn dropped to 2%.",
      score: 0.82,
    };

    DocumentManager.mockImplementation(() => ({
      pinnedDocs: async () => [pinnedDoc],
    }));
    chats.sourceIdentifier.mockImplementation(
      (doc) => `title:${doc.title}-timestamp:${doc.published || "none"}`
    );
    chats.recentChatHistory.mockResolvedValue({
      rawHistory: [
        {
          prompt: "Prior turn",
          response: JSON.stringify({
            text: "Prior answer",
            sources: [historySource],
          }),
        },
      ],
      chatHistory: [],
    });
    CollectorApi.mockImplementation(function () {
      this.online = jest.fn().mockResolvedValue(true);
      this.parseDocument = jest
        .fn()
        .mockResolvedValue({ success: true, documents: [attachedDoc] });
    });

    const result = await ApiChatHandler.chatSync({
      workspace,
      message: "Original question",
      mode: "chat",
      attachments: [
        {
          name: "attached.pdf",
          mime: "application/anythingllm-document",
          contentString: Buffer.from("pdf").toString("base64"),
        },
      ],
    });

    const expectedContextTexts = [
      pinnedDoc.pageContent,
      attachedDoc.pageContent,
      sources[0].text,
      historySource.text,
    ];
    const expectedSources = [
      {
        text: `${pinnedDoc.pageContent.slice(0, 1_000)}...continued on in source document...`,
        id: "pin-1",
        title: "pinned.md",
        published: "2026-01-01",
      },
      {
        text: `${attachedDoc.pageContent.slice(0, 1_000)}...continued on in source document...`,
        id: "att-1",
        title: "attached.pdf",
      },
      sources[0],
    ];

    expect(connector.compressMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTexts: expectedContextTexts,
      }),
      expect.any(Array)
    );
    expect(result.sources).toEqual(expectedSources);
    expect(WorkspaceChats.new.mock.calls[0][0].response.sources).toEqual(
      expectedSources
    );
  });
});

const REAL_WORLD_CASES = [
  {
    name: "workspace chat, no sessionId (POST /v1/workspace/:slug/[stream-]chat)",
    user: null,
    thread: null,
    sessionId: null,
  },
  {
    name: "workspace chat with sessionId (POST /v1/workspace/:slug/[stream-]chat + sessionId)",
    user: null,
    thread: null,
    sessionId: "external-session",
  },
  {
    name: "thread chat, single-user (POST /v1/workspace/:slug/thread/:threadSlug/[stream-]chat)",
    user: null,
    thread: { id: 3 },
    sessionId: null,
  },
  {
    name: "thread chat, attributed user (POST /v1/workspace/:slug/thread/:threadSlug/[stream-]chat + userId)",
    user: { id: 2 },
    thread: { id: 3 },
    sessionId: null,
  },
];

/** The invocation args every case must hand to the ephemeral agent. */
function expectedAgentArgs({ user, thread, sessionId }) {
  return expect.objectContaining({
    workspace,
    prompt: "@agent summarize this",
    userId: user?.id || null,
    threadId: thread?.id || null,
    sessionId,
    attachments,
  });
}

/**
 * The persistence contract: identical scoping triple to the non-agent
 * saves, `include: true`, and the full agent response payload.
 */
function expectedSavePayload({ user, thread, sessionId }) {
  return expect.objectContaining({
    workspaceId: workspace.id,
    prompt: "@agent summarize this",
    include: true,
    threadId: thread?.id || null,
    apiSessionId: sessionId,
    user,
    response: expect.objectContaining({
      text: agentResult.textResponse,
      sources: agentResult.citations,
      attachments,
      type: "chat",
      thoughts: agentResult.thoughts,
    }),
  });
}

describe("ApiChatHandler @agent persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    EphemeralAgentHandler.isAgentInvocation.mockResolvedValue(true);
    WorkspaceChats.new.mockResolvedValue({ chat: { id: 123 } });
    ephemeralMocks.waitForClose.mockResolvedValue(agentResult);
    ephemeralMocks.streamAgentEvents.mockResolvedValue(agentResult);
  });

  describe.each(REAL_WORLD_CASES)("$name", ({ user, thread, sessionId }) => {
    test("chatSync persists the agent turn with the invocation's scoping triple", async () => {
      const result = await ApiChatHandler.chatSync({
        workspace,
        message: "@agent summarize this",
        mode: "chat",
        user,
        thread,
        sessionId,
        attachments,
      });

      expect(EphemeralAgentHandler).toHaveBeenCalledWith(
        expectedAgentArgs({ user, thread, sessionId })
      );
      expect(WorkspaceChats.new).toHaveBeenCalledTimes(1);
      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expectedSavePayload({ user, thread, sessionId })
      );
      expect(result).toEqual(
        expect.objectContaining({
          type: "textResponse",
          textResponse: agentResult.textResponse,
          thoughts: agentResult.thoughts,
          close: true,
          error: null,
        })
      );
    });

    test("streamChat persists the agent turn with the invocation's scoping triple", async () => {
      const response = {}; // express response — writeResponseChunk is mocked
      await ApiChatHandler.streamChat({
        response,
        workspace,
        message: "@agent summarize this",
        mode: "chat",
        user,
        thread,
        sessionId,
        attachments,
      });

      expect(EphemeralAgentHandler).toHaveBeenCalledWith(
        expectedAgentArgs({ user, thread, sessionId })
      );
      expect(WorkspaceChats.new).toHaveBeenCalledTimes(1);
      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expectedSavePayload({ user, thread, sessionId })
      );
      expect(writeResponseChunk).toHaveBeenCalledWith(
        response,
        expect.objectContaining({
          type: "finalizeResponseStream",
          textResponse: agentResult.textResponse,
          thoughts: agentResult.thoughts,
          close: true,
          error: false,
        })
      );
    });
  });

  describe("query-mode refusal, no embeddings", () => {
    // Same contract as the agent saves above: a refusal row is still a turn,
    // and must carry the scoping triple it was invoked with or it is orphaned.
    test.each(REAL_WORLD_CASES)(
      "chatSync keeps the scoping triple on the refusal row ($name)",
      async ({ user, thread, sessionId }) => {
        EphemeralAgentHandler.isAgentInvocation.mockResolvedValue(false);
        resolveProviderConnector.mockResolvedValue({
          connector: { promptWindowLimit: () => 8000 },
          routingMetadata: null,
        });
        getVectorDbClass.mockReturnValue({
          hasNamespace: jest.fn().mockResolvedValue(false),
          namespaceCount: jest.fn().mockResolvedValue(0),
        });

        await ApiChatHandler.chatSync({
          workspace,
          message: "anything",
          mode: "query",
          user,
          thread,
          sessionId,
        });

        expect(WorkspaceChats.new).toHaveBeenCalledWith(
          expect.objectContaining({
            workspaceId: workspace.id,
            include: false,
            threadId: thread?.id || null,
            apiSessionId: sessionId,
            user,
          })
        );
      }
    );
  });

  describe("cross-cutting rules", () => {
    test("agent chats are never saved with include: false", async () => {
      for (const c of REAL_WORLD_CASES) {
        await ApiChatHandler.chatSync({
          workspace,
          message: "@agent summarize this",
          mode: "chat",
          user: c.user,
          thread: c.thread,
          sessionId: c.sessionId,
          attachments,
        });
      }
      expect(WorkspaceChats.new).toHaveBeenCalledTimes(REAL_WORLD_CASES.length);
      for (const call of WorkspaceChats.new.mock.calls) {
        expect(call[0].include).toBe(true);
      }
    });

    test("a user-attributed save never carries an apiSessionId (multi-user vs session scoping)", async () => {
      for (const c of REAL_WORLD_CASES) {
        await ApiChatHandler.chatSync({
          workspace,
          message: "@agent summarize this",
          mode: "chat",
          user: c.user,
          thread: c.thread,
          sessionId: c.sessionId,
          attachments,
        });
      }
      for (const call of WorkspaceChats.new.mock.calls) {
        const { user, apiSessionId } = call[0];
        expect(Boolean(user && apiSessionId)).toBe(false);
      }
    });

    test("agent outputs from pending outputs are merged into the saved response", async () => {
      const pendingOutput = { type: "file", payload: { name: "report.csv" } };
      ephemeralMocks.waitForClose.mockResolvedValue({
        ...agentResult,
        outputs: [{ type: "text", payload: "inline" }],
      });
      EphemeralAgentHandler.mockImplementationOnce(function (args) {
        this.args = args;
        this.init = jest.fn().mockResolvedValue();
        this.createAIbitat = jest.fn().mockResolvedValue();
        this.startAgentCluster = jest.fn();
        this.getPendingOutputs = jest.fn().mockReturnValue([pendingOutput]);
      });

      await ApiChatHandler.chatSync({
        workspace,
        message: "@agent summarize this",
        mode: "chat",
        user: null,
        thread: null,
        sessionId: null,
        attachments,
      });

      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.objectContaining({
            outputs: [{ type: "text", payload: "inline" }, pendingOutput],
          }),
        })
      );
    });
  });

  describe("document attachments", () => {
    const fs = require("fs");
    const { CollectorApi } = require("../../../utils/collectorApi");
    const documentAttachment = {
      name: "report.pdf",
      mime: "application/anythingllm-document",
      contentString: Buffer.from("pdf-bytes").toString("base64"),
    };
    const parsedDocument = {
      id: "doc-1",
      title: "report.pdf",
      pageContent: "Quarterly revenue was up 12%.",
    };

    beforeEach(() => {
      jest.spyOn(fs, "existsSync").mockReturnValue(true);
      jest.spyOn(fs, "writeFileSync").mockImplementation(() => {});
      CollectorApi.mockImplementation(function () {
        this.online = jest.fn().mockResolvedValue(true);
        this.parseDocument = jest
          .fn()
          .mockResolvedValue({ success: true, documents: [parsedDocument] });
      });
    });

    afterEach(() => jest.restoreAllMocks());

    test.each(["chatSync", "streamChat"])(
      "%s hands the agent parsed document text and saves only the images",
      async (handler) => {
        await ApiChatHandler[handler]({
          response: {},
          workspace,
          message: "@agent summarize this",
          mode: "chat",
          attachments: [...attachments, documentAttachment],
        });

        expect(EphemeralAgentHandler).toHaveBeenCalledWith(
          expect.objectContaining({
            attachments,
            parsedDocuments: [parsedDocument],
          })
        );
        expect(WorkspaceChats.new).toHaveBeenCalledWith(
          expect.objectContaining({
            response: expect.objectContaining({ attachments }),
          })
        );
      }
    );

    test("the query-mode refusal saves only the images", async () => {
      EphemeralAgentHandler.isAgentInvocation.mockResolvedValue(false);
      resolveProviderConnector.mockResolvedValue({
        connector: { promptWindowLimit: () => 8000 },
        routingMetadata: null,
      });
      getVectorDbClass.mockReturnValue({
        hasNamespace: jest.fn().mockResolvedValue(false),
        namespaceCount: jest.fn().mockResolvedValue(0),
      });

      await ApiChatHandler.chatSync({
        workspace,
        message: "anything",
        mode: "query",
        attachments: [...attachments, documentAttachment],
      });

      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expect.objectContaining({
          response: expect.objectContaining({ attachments }),
        })
      );
    });
  });
});
