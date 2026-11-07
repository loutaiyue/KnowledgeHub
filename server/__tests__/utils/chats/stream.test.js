/* eslint-env jest, node */

jest.mock("../../../models/workspaceChats", () => ({
  WorkspaceChats: {
    new: jest.fn(),
    upsert: jest.fn(),
  },
}));
jest.mock("../../../models/workspaceParsedFiles", () => ({
  WorkspaceParsedFiles: {
    getContextFiles: jest.fn(),
  },
}));
jest.mock("../../../utils/DocumentManager", () => ({
  DocumentManager: jest.fn(),
}));
jest.mock("../../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  resolveProviderConnector: jest.fn(),
}));
jest.mock("../../../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn((metrics) => metrics),
}));
jest.mock("../../../utils/helpers/chat/responses", () => {
  const actual = jest.requireActual("../../../utils/helpers/chat/responses");
  return {
    ...actual,
    writeResponseChunk: jest.fn(),
  };
});
jest.mock("../../../utils/helpers/abortSignals", () => ({
  abortConnectorOnClientDisconnect: jest.fn(),
}));
jest.mock("../../../utils/chats/agents", () => ({
  grepAgents: jest.fn(),
}));
jest.mock("../../../utils/helpers/reasoningEffort", () => ({
  resolveReasoningEffort: jest.fn().mockResolvedValue(null),
  usesModelRouter: jest.fn().mockReturnValue(false),
}));
jest.mock("../../../utils/chats/index", () => {
  const actual = jest.requireActual("../../../utils/chats/index");
  return {
    ...actual,
    grepCommand: jest.fn(async (msg) => msg),
    VALID_COMMANDS: {
      "/reset": jest.fn(),
    },
    chatPrompt: jest.fn(),
    recentChatHistory: jest.fn(),
  };
});
jest.mock("../../../utils/chats/evidence", () => {
  const actual = jest.requireActual("../../../utils/chats/evidence");
  return {
    ...actual,
    collectPinnedDocIdentifiers: jest.fn(actual.collectPinnedDocIdentifiers),
    buildAndDeriveEvidence: jest.fn(actual.buildAndDeriveEvidence),
  };
});

const { streamChatWithWorkspace } = require("../../../utils/chats/stream");
const evidenceModule = require("../../../utils/chats/evidence");
const { WorkspaceChats } = require("../../../models/workspaceChats");
const {
  WorkspaceParsedFiles,
} = require("../../../models/workspaceParsedFiles");
const { DocumentManager } = require("../../../utils/DocumentManager");
const {
  getVectorDbClass,
  resolveProviderConnector,
} = require("../../../utils/helpers");
const {
  writeResponseChunk,
  convertToChatHistory,
} = require("../../../utils/helpers/chat/responses");
const answerVerification = require("../../../utils/chats/answerVerification");
const { grepAgents } = require("../../../utils/chats/agents");
const chatsIndex = require("../../../utils/chats/index");

describe("streamChatWithWorkspace unified Evidence integration", () => {
  const workspace = {
    id: 10,
    slug: "test-workspace",
    chatMode: "chat",
    topN: 4,
    similarityThreshold: 0.25,
  };
  const user = { id: 7 };
  const thread = { id: 99 };
  const metrics = {
    prompt_tokens: 40,
    completion_tokens: 15,
    total_tokens: 55,
  };

  let response;
  let connector;
  let vectorDb;
  let pinnedDocsMock;
  let buildSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    response = {};
    buildSpy = evidenceModule.buildAndDeriveEvidence;

    grepAgents.mockResolvedValue(false);
    chatsIndex.grepCommand.mockImplementation(async (msg) => msg);
    chatsIndex.chatPrompt.mockResolvedValue("System instructions");
    chatsIndex.recentChatHistory.mockResolvedValue({
      rawHistory: [],
      chatHistory: [],
    });

    pinnedDocsMock = jest.fn().mockResolvedValue([]);
    DocumentManager.mockImplementation(() => ({
      pinnedDocs: pinnedDocsMock,
    }));
    WorkspaceParsedFiles.getContextFiles.mockResolvedValue([]);

    WorkspaceChats.new.mockResolvedValue({ chat: { id: 501 } });
    WorkspaceChats.upsert.mockResolvedValue({ chat: { id: 501 } });

    connector = {
      className: "GenericOpenAiLLM",
      model: "gpt-4o",
      promptWindowLimit: jest.fn(() => 16_000),
      streamingEnabled: jest.fn(() => true),
      compressMessages: jest.fn(async ({ systemPrompt, contextTexts }) => [
        {
          role: "system",
          content: `${systemPrompt}:${JSON.stringify(contextTexts)}`,
        },
      ]),
      streamGetChatCompletion: jest.fn().mockResolvedValue({ metrics }),
      handleStream: jest.fn().mockResolvedValue("Streamed AI answer."),
      getChatCompletion: jest.fn().mockResolvedValue({
        textResponse: "Non-streamed AI answer.",
        metrics,
      }),
    };

    resolveProviderConnector.mockResolvedValue({
      connector,
      routingMetadata: null,
      prefetchedContext: null,
    });

    vectorDb = {
      hasNamespace: jest.fn().mockResolvedValue(true),
      namespaceCount: jest.fn().mockResolvedValue(3),
      performSimilaritySearch: jest.fn().mockResolvedValue({
        contextTexts: ["Retrieved chunk 1 text."],
        sources: [
          {
            id: "vec-1",
            title: "kb-doc.pdf",
            chunkSource: "lancedb://kb-doc.pdf",
            text: "Retrieved chunk 1 text.",
            score: 0.91,
          },
        ],
        message: null,
      }),
    };
    getVectorDbClass.mockReturnValue(vectorDb);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("1. Four evidence origins ordering & contextTexts/sources derivation", () => {
    test("derives contextTexts and sources in exact order across pinned, attachment(parsedFiles), retrieval, and history", async () => {
      const longPinnedText = "P".repeat(1_200);
      const longAttachmentText = "A".repeat(1_100);
      const pinnedDoc = {
        id: "collector-pin-1",
        docId: "ws-doc-pin-1",
        title: "pinned-guide.md",
        published: "2026-01-01",
        pageContent: longPinnedText,
      };
      const parsedFile = {
        id: "parsed-file-1",
        title: "uploaded-notes.txt",
        location: "direct-uploads/uploaded-notes.json",
        token_count_estimate: 320,
        pageContent: longAttachmentText,
      };
      const retrievalSource = {
        id: "ret-chunk-1",
        title: "search-hit.pdf",
        published: "2026-02-01",
        text: "Vector search chunk body.",
        score: 0.93,
      };
      const historySource = {
        id: "hist-chunk-1",
        title: "previous-turn.pdf",
        published: "2026-01-15",
        text: "Historical backfilled chunk body.",
        score: 0.85,
      };

      pinnedDocsMock.mockResolvedValue([pinnedDoc]);
      WorkspaceParsedFiles.getContextFiles.mockResolvedValue([parsedFile]);
      vectorDb.performSimilaritySearch.mockResolvedValue({
        contextTexts: [retrievalSource.text],
        sources: [retrievalSource],
        message: null,
      });
      chatsIndex.recentChatHistory.mockResolvedValue({
        rawHistory: [
          {
            prompt: "Earlier question",
            response: JSON.stringify({
              text: "Earlier answer",
              sources: [historySource],
            }),
          },
        ],
        chatHistory: [],
      });

      await streamChatWithWorkspace(
        response,
        workspace,
        "Explain the policy",
        "chat",
        user,
        thread,
        []
      );

      expect(buildSpy).toHaveBeenCalledTimes(1);
      const derivedResult = buildSpy.mock.results[0].value;
      expect(
        derivedResult.evidenceItems.map((item) => ({
          evidenceId: item.evidenceId,
          origin: item.origin,
          documentId: item.documentId,
          chunkId: item.chunkId,
          displayInSources: item.displayInSources,
        }))
      ).toEqual([
        {
          evidenceId: "ev-0",
          origin: "pinned",
          documentId: "ws-doc-pin-1",
          chunkId: null,
          displayInSources: true,
        },
        {
          evidenceId: "ev-1",
          origin: "attachment",
          documentId: null,
          chunkId: null,
          displayInSources: true,
        },
        {
          evidenceId: "ev-2",
          origin: "retrieval",
          documentId: null,
          chunkId: "ret-chunk-1",
          displayInSources: true,
        },
        {
          evidenceId: "ev-3",
          origin: "history",
          documentId: null,
          chunkId: "hist-chunk-1",
          displayInSources: false,
        },
      ]);

      // Model prompt receives all 4 origins in full text
      const expectedContextTexts = [
        longPinnedText,
        longAttachmentText,
        retrievalSource.text,
        historySource.text,
      ];
      expect(connector.compressMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          contextTexts: expectedContextTexts,
        }),
        expect.any(Array)
      );

      // Sources exclude history and keep 1000-char preview for pinned & attachment
      const expectedSources = [
        {
          text: `${longPinnedText.slice(0, 1_000)}...continued on in source document...`,
          id: "collector-pin-1",
          docId: "ws-doc-pin-1",
          title: "pinned-guide.md",
          published: "2026-01-01",
        },
        {
          text: `${longAttachmentText.slice(0, 1_000)}...continued on in source document...`,
          id: "parsed-file-1",
          title: "uploaded-notes.txt",
          location: "direct-uploads/uploaded-notes.json",
          token_count_estimate: 320,
        },
        retrievalSource,
      ];

      expect(connector.handleStream).toHaveBeenCalledWith(
        response,
        expect.anything(),
        expect.objectContaining({
          sources: expectedSources,
        })
      );
      expect(WorkspaceChats.upsert).toHaveBeenCalledWith(
        501,
        expect.objectContaining({
          response: expect.objectContaining({
            text: "Streamed AI answer.",
            sources: expectedSources,
          }),
        })
      );
    });

    test("handles empty knowledge base in chat mode vs query mode refusal", async () => {
      vectorDb.hasNamespace.mockResolvedValue(false);
      vectorDb.namespaceCount.mockResolvedValue(0);

      // In "chat" mode with empty knowledge base, proceeds with empty contextTexts and sources
      await streamChatWithWorkspace(
        response,
        workspace,
        "General question",
        "chat",
        user,
        thread,
        []
      );
      expect(vectorDb.performSimilaritySearch).not.toHaveBeenCalled();
      expect(connector.compressMessages).toHaveBeenCalledWith(
        expect.objectContaining({ contextTexts: [] }),
        []
      );
      expect(connector.handleStream).toHaveBeenCalledWith(
        response,
        expect.anything(),
        expect.objectContaining({ sources: [] })
      );

      // In "query" mode with empty knowledge base, exits early before building evidence
      jest.clearAllMocks();
      vectorDb.hasNamespace.mockResolvedValue(false);
      vectorDb.namespaceCount.mockResolvedValue(0);
      await streamChatWithWorkspace(
        response,
        workspace,
        "Strict query",
        "query",
        user,
        thread,
        []
      );
      expect(buildSpy).not.toHaveBeenCalled();
      expect(writeResponseChunk).toHaveBeenCalledWith(
        response,
        expect.objectContaining({
          type: "textResponse",
          sources: [],
          close: true,
        })
      );
      expect(WorkspaceChats.new).toHaveBeenCalledWith(
        expect.objectContaining({ include: false })
      );
    });

    test("handles only history backfill when pinnedDocs, attachments, and current retrieval are empty", async () => {
      const historyChunk = {
        id: "hist-only-1",
        title: "archive.pdf",
        published: "2026-01-10",
        text: "Carried over context from previous turn.",
        score: 0.89,
      };
      vectorDb.performSimilaritySearch.mockResolvedValue({
        contextTexts: [],
        sources: [],
        message: null,
      });
      chatsIndex.recentChatHistory.mockResolvedValue({
        rawHistory: [
          {
            prompt: "Turn 1",
            response: JSON.stringify({
              text: "Turn 1 reply",
              sources: [historyChunk],
            }),
          },
        ],
        chatHistory: [],
      });

      await streamChatWithWorkspace(
        response,
        workspace,
        "Follow-up question",
        "query",
        user,
        thread,
        []
      );

      // History backfill satisfies query mode context requirement (contextTexts.length === 1)
      expect(connector.compressMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          contextTexts: ["Carried over context from previous turn."],
        }),
        expect.any(Array)
      );
      // But sources for current turn remains empty because history has displayInSources=false
      expect(connector.handleStream).toHaveBeenCalledWith(
        response,
        expect.anything(),
        expect.objectContaining({
          sources: [],
        })
      );
    });

    test("preserves duplicate texts across different origins and keeps missing documentId/chunkId as null", async () => {
      const sharedText = "Identical paragraph across multiple sources.";
      pinnedDocsMock.mockResolvedValue([
        { title: "pin-without-id.md", pageContent: sharedText },
      ]);
      WorkspaceParsedFiles.getContextFiles.mockResolvedValue([
        { title: "attach-without-id.md", pageContent: sharedText },
      ]);
      vectorDb.performSimilaritySearch.mockResolvedValue({
        contextTexts: [sharedText],
        sources: [{ title: "retrieval-without-chunk-id.md", text: sharedText }],
        message: null,
      });

      await streamChatWithWorkspace(
        response,
        workspace,
        "Check duplicate text",
        "chat",
        user,
        thread,
        []
      );

      const { evidenceItems, contextTexts, sources } =
        buildSpy.mock.results[0].value;
      expect(evidenceItems).toHaveLength(3);
      expect(evidenceItems.map((e) => e.evidenceId)).toEqual([
        "ev-0",
        "ev-1",
        "ev-2",
      ]);
      for (const item of evidenceItems) {
        expect(item.documentId).toBeNull();
        expect(item.chunkId).toBeNull();
      }
      expect(contextTexts).toEqual([sharedText, sharedText, sharedText]);
      expect(sources).toHaveLength(3);
    });
  });

  describe("2. prefetchedContext reuse without duplication", () => {
    test("reuses prefetched pinnedDocs, parsedFiles, history, and systemPrompt without re-querying or duplicating", async () => {
      const prefetchedPinned = [
        {
          id: "pre-pin-1",
          title: "prefetched-pin.md",
          published: "2026-03-01",
          pageContent: "Prefetched pinned text.",
        },
      ];
      const prefetchedParsed = [
        {
          id: "pre-file-1",
          title: "prefetched-upload.txt",
          pageContent: "Prefetched uploaded file text.",
        },
      ];

      resolveProviderConnector.mockResolvedValue({
        connector,
        routingMetadata: {
          routedTo: {
            shouldNotify: true,
            provider: "openai",
            model: "gpt-4o",
          },
        },
        prefetchedContext: {
          rawHistory: [],
          chatHistory: [],
          systemPrompt: "Prefetched router system prompt",
          pinnedDocs: prefetchedPinned,
          parsedFiles: prefetchedParsed,
        },
      });

      await streamChatWithWorkspace(
        response,
        workspace,
        "Routed question",
        "chat",
        user,
        thread,
        []
      );

      // Should not re-fetch history, pinnedDocs, parsedFiles, or systemPrompt
      expect(chatsIndex.recentChatHistory).not.toHaveBeenCalled();
      expect(pinnedDocsMock).not.toHaveBeenCalled();
      expect(WorkspaceParsedFiles.getContextFiles).not.toHaveBeenCalled();
      expect(chatsIndex.chatPrompt).not.toHaveBeenCalled();

      // Context texts contain each prefetched item exactly once plus retrieval
      expect(connector.compressMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "Prefetched router system prompt",
          contextTexts: [
            "Prefetched pinned text.",
            "Prefetched uploaded file text.",
            "Retrieved chunk 1 text.",
          ],
        }),
        []
      );
      expect(
        buildSpy.mock.results[0].value.sources.map((s) => s.title)
      ).toEqual(["prefetched-pin.md", "prefetched-upload.txt", "kb-doc.pdf"]);
    });
  });

  describe("3. Slash commands and Agent invocations bypass RAG Evidence pipeline", () => {
    test("built-in command (/reset) exits early without invoking RAG or buildAndDeriveEvidence", async () => {
      const resetPayload = {
        uuid: "cmd-uuid",
        type: "textResponse",
        textResponse: "Chat memory was reset!",
        sources: [],
        close: true,
        error: false,
        action: "reset_chat",
      };
      chatsIndex.grepCommand.mockResolvedValue("/reset");
      chatsIndex.VALID_COMMANDS["/reset"].mockResolvedValue(resetPayload);

      await streamChatWithWorkspace(
        response,
        workspace,
        "/reset",
        "chat",
        user,
        thread,
        []
      );

      expect(chatsIndex.VALID_COMMANDS["/reset"]).toHaveBeenCalledTimes(1);
      expect(writeResponseChunk).toHaveBeenCalledWith(response, resetPayload);
      expect(grepAgents).not.toHaveBeenCalled();
      expect(resolveProviderConnector).not.toHaveBeenCalled();
      expect(vectorDb.performSimilaritySearch).not.toHaveBeenCalled();
      expect(buildSpy).not.toHaveBeenCalled();
    });

    test("agent chat invocation exits early without invoking RAG or buildAndDeriveEvidence", async () => {
      grepAgents.mockResolvedValue(true);

      await streamChatWithWorkspace(
        response,
        workspace,
        "@agent search the web",
        "automatic",
        user,
        thread,
        []
      );

      expect(grepAgents).toHaveBeenCalledTimes(1);
      expect(resolveProviderConnector).not.toHaveBeenCalled();
      expect(pinnedDocsMock).not.toHaveBeenCalled();
      expect(WorkspaceParsedFiles.getContextFiles).not.toHaveBeenCalled();
      expect(vectorDb.performSimilaritySearch).not.toHaveBeenCalled();
      expect(buildSpy).not.toHaveBeenCalled();
    });
  });

  describe("4. SSE protocol, non-streaming fallback, and database persistence compatibility", () => {
    test("streaming mode preserves pre-save, handleStream, upsert, and finalizeResponseStream SSE event", async () => {
      const imageAttachments = [
        {
          name: "chart.png",
          mime: "image/png",
          contentString: "data:image/png;base64,xyz",
        },
      ];

      await streamChatWithWorkspace(
        response,
        workspace,
        "Analyze chart",
        "chat",
        user,
        thread,
        imageAttachments
      );

      // 1. Pre-saves empty response row before calling LLM
      expect(WorkspaceChats.new).toHaveBeenCalledWith({
        workspaceId: workspace.id,
        prompt: "Analyze chart",
        response: {
          text: "",
          sources: [],
          type: "chat",
          attachments: imageAttachments,
        },
        threadId: thread.id,
        user,
      });

      // 2. Streams via handleStream with derived sources
      const expectedSources = [
        {
          id: "vec-1",
          title: "kb-doc.pdf",
          chunkSource: "lancedb://kb-doc.pdf",
          text: "Retrieved chunk 1 text.",
          score: 0.91,
        },
      ];
      expect(connector.handleStream).toHaveBeenCalledWith(
        response,
        expect.anything(),
        {
          uuid: expect.any(String),
          sources: expectedSources,
        }
      );

      // 3. Upserts final chat record with textResponse, sources, attachments, and metrics
      expect(WorkspaceChats.upsert).toHaveBeenCalledWith(501, {
        workspaceId: workspace.id,
        prompt: "Analyze chart",
        response: {
          text: "Streamed AI answer.",
          sources: expectedSources,
          type: "chat",
          attachments: imageAttachments,
          metrics,
        },
        threadId: thread.id,
        user,
        include: true,
      });

      // 4. Emits finalizeResponseStream SSE event
      expect(writeResponseChunk).toHaveBeenLastCalledWith(response, {
        uuid: expect.any(String),
        type: "finalizeResponseStream",
        close: true,
        error: false,
        chatId: 501,
        metrics,
      });
    });

    test("non-streaming connector emits single textResponseChunk with sources followed by finalizeResponseStream", async () => {
      connector.streamingEnabled.mockReturnValue(false);

      await streamChatWithWorkspace(
        response,
        workspace,
        "Question for non-streaming model",
        "chat",
        user,
        thread,
        []
      );

      expect(connector.getChatCompletion).toHaveBeenCalledTimes(1);
      expect(connector.streamGetChatCompletion).not.toHaveBeenCalled();

      expect(writeResponseChunk).toHaveBeenNthCalledWith(1, response, {
        uuid: expect.any(String),
        sources: [
          {
            id: "vec-1",
            title: "kb-doc.pdf",
            chunkSource: "lancedb://kb-doc.pdf",
            text: "Retrieved chunk 1 text.",
            score: 0.91,
          },
        ],
        type: "textResponseChunk",
        textResponse: "Non-streamed AI answer.",
        close: true,
        error: false,
        metrics,
      });

      expect(writeResponseChunk).toHaveBeenNthCalledWith(2, response, {
        uuid: expect.any(String),
        type: "finalizeResponseStream",
        close: true,
        error: false,
        chatId: 501,
        metrics,
      });
    });
  });

  describe("5. Claim -> Evidence Answer Verification in Streaming Chat (Phase 4)", () => {
    const savedEnv = process.env.RAG_ANSWER_VERIFICATION_ENABLED;
    const chunkText = "Retrieved chunk 1 text.";
    const streamedAnswer = "Retrieved chunk 1 text. Unverified extra statement.";

    const buildEvaluatorJson = (
      claims = [
        {
          claim: "Retrieved chunk 1 text.",
          answerQuote: "Retrieved chunk 1 text.",
          verdict: "supported",
          evidence: [{ evidenceId: "ev-0", quote: chunkText }],
        },
      ],
      summary = "Verified against workspace evidence."
    ) => JSON.stringify({ summary, claims });

    beforeEach(() => {
      process.env.RAG_ANSWER_VERIFICATION_ENABLED = "true";
      connector.maxTokens = 1024;
      connector.constructPrompt = jest.fn(({ systemPrompt, contextTexts }) => [
        {
          role: "system",
          content: `${systemPrompt}:${JSON.stringify(contextTexts)}`,
        },
      ]);
      connector.compressMessages = jest.fn(async (args) =>
        connector.constructPrompt(args)
      );
      connector.handleStream.mockResolvedValue(streamedAnswer);
      connector.getChatCompletion.mockResolvedValue({
        textResponse: buildEvaluatorJson(),
        metrics: { total_tokens: 80 },
      });
    });

    afterEach(() => {
      jest.useRealTimers();
      if (savedEnv === undefined) {
        delete process.env.RAG_ANSWER_VERIFICATION_ENABLED;
      } else {
        process.env.RAG_ANSWER_VERIFICATION_ENABLED = savedEnv;
      }
    });

    test("1 & 7 & 8 & 9 & 14: GenericOpenAiLLM runs verification only after stream completes, preserves original answer, persists verification without docpath, and attaches it to finalizeResponseStream", async () => {
      const callOrder = [];
      pinnedDocsMock.mockResolvedValue([
        {
          id: "pin-doc-1",
          docId: "ws-doc-pinned",
          docpath: "custom-documents/secret-internal-path.json",
          title: "policy.md",
          url: "file:///policy.md",
          pageContent: "Company policy requires two-factor authentication.",
        },
      ]);
      connector.handleStream.mockImplementation(async () => {
        callOrder.push("handleStream");
        return "Company policy requires two-factor authentication.";
      });
      connector.getChatCompletion.mockImplementation(async () => {
        callOrder.push("evaluatorGetChatCompletion");
        return {
          textResponse: buildEvaluatorJson([
            {
              claim: "Company policy requires two-factor authentication.",
              answerQuote:
                "Company policy requires two-factor authentication.",
              verdict: "supported",
              evidence: [
                {
                  evidenceId: "ev-0",
                  quote: "Company policy requires two-factor authentication.",
                },
              ],
            },
          ]),
        };
      });
      WorkspaceChats.upsert.mockImplementation(async () => {
        callOrder.push("upsert");
        return { chat: { id: 501 } };
      });
      writeResponseChunk.mockImplementation((_res, payload) => {
        callOrder.push(`sse:${payload.type}`);
      });

      await streamChatWithWorkspace(
        response,
        workspace,
        "What is the 2FA policy?",
        "chat",
        user,
        thread,
        []
      );

      // Verification runs strictly after handleStream and before upsert & finalizeResponseStream
      expect(callOrder).toEqual([
        "handleStream",
        "evaluatorGetChatCompletion",
        "upsert",
        "sse:finalizeResponseStream",
      ]);

      // Only 1 evaluator call (batch evaluation, no extra generation call)
      expect(connector.streamGetChatCompletion).toHaveBeenCalledTimes(1);
      expect(connector.getChatCompletion).toHaveBeenCalledTimes(1);
      const [, evalOptions] = connector.getChatCompletion.mock.calls[0];
      expect(evalOptions).toEqual({ temperature: 0 });

      const expectedVerification = {
        status: "supported",
        verificationScope: "model_extracted_claims_only",
        summary: "Verified against workspace evidence.",
        claims: [
          {
            claim: "Company policy requires two-factor authentication.",
            answerQuote: "Company policy requires two-factor authentication.",
            answerLocation: {
              status: "located",
              ranges: [{ start: 0, end: 50 }],
            },
            verdict: "supported",
            evidence: [
              {
                evidenceId: "ev-0",
                quote: "Company policy requires two-factor authentication.",
                origin: "pinned",
                documentId: "ws-doc-pinned",
                chunkId: null,
                title: "policy.md",
                sourceUri: "file:///policy.md",
                displayInSources: true,
              },
            ],
          },
        ],
      };

      // Persisted in WorkspaceChats.upsert without altering text or exposing docpath
      const upsertPayload = WorkspaceChats.upsert.mock.calls[0][1];
      expect(upsertPayload.response.text).toBe(
        "Company policy requires two-factor authentication."
      );
      expect(upsertPayload.response.verification).toEqual(expectedVerification);
      expect(
        JSON.stringify(upsertPayload.response.verification)
      ).not.toContain("secret-internal-path");
      expect(
        JSON.stringify(upsertPayload.response.verification)
      ).not.toContain("docpath");

      // Attached to finalizeResponseStream SSE event
      expect(writeResponseChunk).toHaveBeenLastCalledWith(response, {
        uuid: expect.any(String),
        type: "finalizeResponseStream",
        close: true,
        error: false,
        chatId: 501,
        metrics,
        verification: expectedVerification,
      });
    });

    test("2 & 3 & 4 & 5 & 6: Dedicated DeepSeekLLM (deepseek-flash & deepseek-reasoner) passes maxTokens: 4096, strips leading <think> on evaluator JSON without corrupting inline <think>, and aligns answerLocation with UI display", async () => {
      connector.className = "DeepSeekLLM";
      connector.model = "deepseek-reasoner";
      delete connector.maxTokens;

      // Streamed response includes a leading <think> block (as produced by handleDefaultStreamResponseV2)
      const streamedWithThink =
        "<think>Retrieved chunk 1 text. Let me formulate the reply.</think>Retrieved chunk 1 text. Also see <think>inline</think> docs.";
      connector.handleStream.mockResolvedValue(streamedWithThink);

      // Evaluator response also includes a leading <think> block from deepseek-reasoner
      connector.getChatCompletion.mockResolvedValue({
        textResponse:
          "<think>Evaluating claim 1 against ev-0...</think>" +
          buildEvaluatorJson(
            [
              {
                claim: "Retrieved chunk 1 text.",
                answerQuote: "Retrieved chunk 1 text.",
                verdict: "supported",
                evidence: [{ evidenceId: "ev-0", quote: chunkText }],
              },
              {
                claim: "Mentions <think>inline</think> docs.",
                answerQuote: "Also see <think>inline</think> docs.",
                verdict: "unsupported",
                evidence: [],
              },
            ],
            "Summary with <think>preserved</think> text."
          ),
      });

      await streamChatWithWorkspace(
        response,
        workspace,
        "Ask DeepSeek",
        "chat",
        user,
        thread,
        []
      );

      expect(connector.getChatCompletion).toHaveBeenCalledTimes(1);
      const [evalMessages, evalOptions] =
        connector.getChatCompletion.mock.calls[0];
      expect(evalOptions).toEqual({
        temperature: 0,
        maxTokens: 4096,
      });

      // Evaluator received the UI-displayed answer (without the leading <think> block)
      const uiDisplayedAnswer =
        "Retrieved chunk 1 text. Also see <think>inline</think> docs.";
      expect(JSON.parse(evalMessages[1].content).answer).toBe(
        uiDisplayedAnswer
      );

      // Original completeText in DB is NOT mutated (still has <think>...</think> for ThoughtChain UI)
      const savedResponse = WorkspaceChats.upsert.mock.calls[0][1].response;
      expect(savedResponse.text).toBe(streamedWithThink);

      // Verification parsed cleanly and answerLocation offsets match UI-displayed text
      const verification = savedResponse.verification;
      expect(verification.status).toBe("partially_supported");
      expect(verification.summary).toBe(
        "Summary with <think>preserved</think> text."
      );
      expect(verification.claims[0].answerLocation).toEqual({
        status: "located",
        ranges: [{ start: 0, end: 23 }],
      });
      expect(uiDisplayedAnswer.slice(0, 23)).toBe("Retrieved chunk 1 text.");
      expect(verification.claims[1].answerLocation).toEqual({
        status: "located",
        ranges: [{ start: 24, end: 60 }],
      });
      expect(uiDisplayedAnswer.slice(24, 60)).toBe(
        "Also see <think>inline</think> docs."
      );
    });

    test("10: convertToChatHistory restores persisted verification for historical assistant messages", async () => {
      await streamChatWithWorkspace(
        response,
        workspace,
        "Question for history restore",
        "chat",
        user,
        thread,
        []
      );

      const upsertData = WorkspaceChats.upsert.mock.calls[0][1];
      const dbRecords = [
        {
          id: 501,
          prompt: upsertData.prompt,
          response: JSON.stringify(upsertData.response),
          createdAt: new Date("2026-04-01T10:00:00Z"),
          feedbackScore: null,
        },
      ];

      const restoredHistory = convertToChatHistory(dbRecords);
      expect(restoredHistory).toHaveLength(2);
      expect(restoredHistory[0]).toMatchObject({
        role: "user",
        content: "Question for history restore",
        chatId: 501,
      });
      expect(restoredHistory[1]).toMatchObject({
        role: "assistant",
        content: streamedAnswer,
        chatId: 501,
        verification: expect.objectContaining({
          status: "supported",
          verificationScope: "model_extracted_claims_only",
        }),
      });
    });

    test("11: evaluation failure or timeout never alters or blocks the original streamed answer", async () => {
      // Case A: Evaluator rejects
      connector.getChatCompletion.mockRejectedValueOnce(
        new Error("DeepSeek API 503 error")
      );

      await streamChatWithWorkspace(
        response,
        workspace,
        "Question when evaluator fails",
        "chat",
        user,
        thread,
        []
      );

      expect(WorkspaceChats.upsert).toHaveBeenCalledWith(
        501,
        expect.objectContaining({
          response: expect.objectContaining({
            text: streamedAnswer,
            verification: expect.objectContaining({
              status: "verification_error",
              verificationScope: "model_extracted_claims_only",
              error: { code: "EVALUATION_FAILED" },
            }),
          }),
        })
      );
      expect(writeResponseChunk).toHaveBeenLastCalledWith(
        response,
        expect.objectContaining({
          type: "finalizeResponseStream",
          close: true,
          error: false,
          chatId: 501,
          verification: expect.objectContaining({
            status: "verification_error",
            error: { code: "EVALUATION_FAILED" },
          }),
        })
      );

      // Case B: Evaluator times out
      jest.clearAllMocks();
      jest.useFakeTimers();
      connector.getChatCompletion.mockImplementation(
        () => new Promise(() => {})
      );

      const pendingStream = streamChatWithWorkspace(
        response,
        workspace,
        "Question when evaluator times out",
        "chat",
        user,
        thread,
        []
      );
      await jest.advanceTimersByTimeAsync(30_000);
      await pendingStream;

      expect(WorkspaceChats.upsert).toHaveBeenCalledWith(
        501,
        expect.objectContaining({
          response: expect.objectContaining({
            text: streamedAnswer,
            verification: expect.objectContaining({
              status: "verification_error",
              error: { code: "EVALUATION_TIMEOUT" },
            }),
          }),
        })
      );
    });

    test("12 & 13: Agent and slash command branches never trigger verification, and flag disabled preserves exact legacy behavior", async () => {
      const verifySpy = jest.spyOn(
        answerVerification,
        "runChatAnswerVerification"
      );

      // 1. Slash command branch
      chatsIndex.grepCommand.mockResolvedValueOnce("/reset");
      chatsIndex.VALID_COMMANDS["/reset"].mockResolvedValueOnce({
        uuid: "reset-uuid",
        type: "textResponse",
        textResponse: "Reset!",
        sources: [],
        close: true,
        error: false,
        action: "reset_chat",
      });
      await streamChatWithWorkspace(
        response,
        workspace,
        "/reset",
        "chat",
        user,
        thread,
        []
      );
      expect(verifySpy).not.toHaveBeenCalled();

      // 2. Agent branch
      grepAgents.mockResolvedValueOnce(true);
      await streamChatWithWorkspace(
        response,
        workspace,
        "@agent do task",
        "chat",
        user,
        thread,
        []
      );
      expect(verifySpy).not.toHaveBeenCalled();

      // 3. Flag disabled
      delete process.env.RAG_ANSWER_VERIFICATION_ENABLED;
      await streamChatWithWorkspace(
        response,
        workspace,
        "Normal question with flag off",
        "chat",
        user,
        thread,
        []
      );
      expect(verifySpy).not.toHaveBeenCalled();
      expect(connector.getChatCompletion).not.toHaveBeenCalled();
      expect(
        WorkspaceChats.upsert.mock.calls[0][1].response
      ).not.toHaveProperty("verification");
      expect(writeResponseChunk.mock.calls.at(-1)[1]).not.toHaveProperty(
        "verification"
      );
    });
  });
});
