const fs = require("fs");
const path = require("path");
const Module = require("module");
const { JSDOM } = require("jsdom");
const {
  convertToChatHistory,
} = require("../../../utils/helpers/chat/responses");

const frontendRoot = path.resolve(__dirname, "../../../../frontend");
const esbuild = require(path.join(frontendRoot, "node_modules/esbuild"));
const React = require(path.join(frontendRoot, "node_modules/react"));
const ReactDOMClient = require(
  path.join(frontendRoot, "node_modules/react-dom/client")
);
const { act } = React;
const he = require(path.join(frontendRoot, "node_modules/he"));
const truncate = require(path.join(frontendRoot, "node_modules/truncate"));

const dom = new JSDOM(
  '<!DOCTYPE html><html><body><div id="root"></div><div id="mount"></div></body></html>',
  { url: "http://localhost:3000/" }
);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.Node = dom.window.Node;
global.Range = dom.window.Range;
global.CustomEvent = dom.window.CustomEvent;
global.IS_REACT_ACT_ENVIRONMENT = true;

function createPhosphorStub() {
  return new Proxy(
    {},
    {
      get(_, iconName) {
        if (iconName === "__esModule") return true;
        return function IconStub(props) {
          return React.createElement("span", {
            "data-icon": String(iconName),
            className: props?.className,
          });
        };
      },
    }
  );
}

const sidebarState = {
  sidebarOpen: false,
  sources: [],
  openSidebarCalls: [],
  closeSidebarCalls: 0,
};

const ModalStub = {
  __esModule: true,
  default: function Modal({ isOpen, children }) {
    if (!isOpen) return null;
    return React.createElement(
      "div",
      { "data-testid": "citation-detail-modal", role: "dialog" },
      children
    );
  },
  ModalHeader: function ModalHeader({ title, subtitle, onClose, children }) {
    return React.createElement(
      "div",
      { "data-testid": "citation-modal-header" },
      React.createElement(
        "h3",
        { "data-testid": "citation-modal-title" },
        title
      ),
      subtitle
        ? React.createElement(
            "p",
            { "data-testid": "citation-modal-subtitle" },
            subtitle
          )
        : null,
      onClose
        ? React.createElement(
            "button",
            {
              type: "button",
              "data-testid": "citation-modal-close",
              onClick: onClose,
            },
            "Close"
          )
        : null,
      children
    );
  },
  ModalBody: function ModalBody({ children }) {
    return React.createElement(
      "div",
      { "data-testid": "citation-modal-body" },
      children
    );
  },
};

const moduleCache = new Map();

function loadFrontendModule(absPath) {
  if (moduleCache.has(absPath)) {
    return moduleCache.get(absPath);
  }

  const rawCode = fs.readFileSync(absPath, "utf8");
  const loader = absPath.endsWith(".jsx") ? "jsx" : "js";
  const transformed = esbuild.transformSync(rawCode, {
    loader,
    format: "cjs",
    jsx: "automatic",
    sourcefile: absPath,
  });

  const mod = new Module(absPath, module);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));

  const customRequire = (id) => {
    if (id === "react") return React;
    if (id === "react/jsx-runtime") {
      return require(path.join(frontendRoot, "node_modules/react/jsx-runtime"));
    }
    if (id === "react-dom") {
      return require(path.join(frontendRoot, "node_modules/react-dom"));
    }
    if (id === "he") return he;
    if (id === "truncate") return truncate;
    if (id === "uuid") return require("uuid");
    if (id === "@phosphor-icons/react") return createPhosphorStub();
    if (id === "@/components/lib/Modal") return ModalStub;
    if (id === "@/utils/numbers") {
      return {
        toPercentString: (score) => `${Math.round(Number(score) * 100)}%`,
        formatDuration: (d) => `${d}s`,
      };
    }
    if (id === "react-i18next") {
      return {
        useTranslation: () => ({
          t: (key) => key,
        }),
      };
    }
    if (id === "react-router-dom") {
      return {
        Link: ({ children, to, ...rest }) =>
          React.createElement("a", { href: to, ...rest }, children),
      };
    }
    if (id === "@/utils/paths") {
      return { chatModes: () => "/chat-modes" };
    }
    if (id === "@/utils/chat/markdown") {
      return {
        __esModule: true,
        default: (text = "") =>
          `<p>${String(text)
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/\*([^*]+)\*/g, "<em>$1</em>")}</p>`,
      };
    }
    if (id === "@/utils/chat/purify") {
      return {
        __esModule: true,
        default: { sanitize: (html) => html },
      };
    }
    if (id === "@/utils/chat") {
      return loadFrontendModule(path.join(frontendRoot, "src/utils/chat/index.js"));
    }
    if (id === "@/components/Sidebar/ActiveWorkspaces/ThreadContainer") {
      return { THREAD_RENAME_EVENT: "renameThread" };
    }
    if (id === "@/components/contexts/TTSProvider") {
      return { emitAssistantMessageCompleteEvent: () => {} };
    }
    if (id === "@/utils/chat/agent") {
      return { getAgentSessionActive: () => false };
    }
    if (id === "@/components/ImageLightbox") {
      return { openImageLightbox: () => {} };
    }
    if (id === "./Actions") {
      return {
        __esModule: true,
        default: () =>
          React.createElement("div", { "data-testid": "message-actions" }),
      };
    }
    if (id === "./Actions/EditMessage") {
      return {
        EditMessageForm: () =>
          React.createElement("div", { "data-testid": "edit-message-form" }),
        useEditMessage: () => ({ isEditing: false }),
      };
    }
    if (id === "./Actions/DeleteMessage") {
      return {
        useWatchDeleteMessage: () => ({
          isDeleted: false,
          completeDelete: false,
          onEndAnimation: () => {},
        }),
      };
    }
    if (id === "./Actions/TTSButton") {
      return {
        __esModule: true,
        default: () => React.createElement("div", { "data-testid": "tts-btn" }),
      };
    }
    if (id === "./HistoricalOutputs") {
      return { __esModule: true, default: () => null };
    }
    if (id === "./HistoricalClarifyingQuestions") {
      return { __esModule: true, default: () => null };
    }
    if (id === "../../ChatSidebar") {
      return {
        useSourcesSidebar: () => ({
          sidebarOpen: sidebarState.sidebarOpen,
          sources: sidebarState.sources,
          openSidebar: (srcs) => {
            sidebarState.sidebarOpen = true;
            sidebarState.sources = srcs;
            sidebarState.openSidebarCalls.push(srcs);
          },
          closeSidebar: () => {
            sidebarState.sidebarOpen = false;
            sidebarState.closeSidebarCalls += 1;
          },
        }),
      };
    }
    if (id.endsWith(".png") || id.endsWith(".svg")) {
      return "stub-asset.png";
    }
    if (id.startsWith(".")) {
      const baseResolved = path.resolve(path.dirname(absPath), id);
      const candidates = [
        baseResolved,
        `${baseResolved}.js`,
        `${baseResolved}.jsx`,
        path.join(baseResolved, "index.js"),
        path.join(baseResolved, "index.jsx"),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return loadFrontendModule(candidate);
        }
      }
    }
    return require(id);
  };

  mod.require = customRequire;
  moduleCache.set(absPath, mod.exports);
  mod._compile(transformed.code, absPath);
  moduleCache.set(absPath, mod.exports);
  return mod.exports;
}

const { default: handleChat } = loadFrontendModule(
  path.join(frontendRoot, "src/utils/chat/index.js")
);
const { default: HistoricalMessage } = loadFrontendModule(
  path.join(
    frontendRoot,
    "src/components/WorkspaceChat/ChatContainer/ChatHistory/HistoricalMessage/index.jsx"
  )
);
const { default: PromptReply } = loadFrontendModule(
  path.join(
    frontendRoot,
    "src/components/WorkspaceChat/ChatContainer/ChatHistory/PromptReply/index.jsx"
  )
);

describe("Phase 5.3 Integration: handleChat, HistoricalMessage, PromptReply & ClaimVerification", () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.getElementById("mount");
    container.innerHTML = "";
    root = ReactDOMClient.createRoot(container);
    sidebarState.sidebarOpen = false;
    sidebarState.sources = [];
    sidebarState.openSidebarCalls = [];
    sidebarState.closeSidebarCalls = 0;
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.innerHTML = "";
  });

  function render(element) {
    act(() => {
      root.render(element);
    });
  }

  function click(element) {
    act(() => {
      element.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })
      );
    });
  }

  test("1 & 3. streaming reply does not show incomplete verification during PromptReply streaming, then saves and renders ClaimVerification after finalizeResponseStream", () => {
    const _chatHistory = [{ role: "user", content: "系统默认使用什么向量数据库？" }];
    let latestChatHistory = [..._chatHistory];
    let loadingState = true;

    const setLoadingResponse = (v) => {
      loadingState = v;
    };
    const setChatHistory = (next) => {
      latestChatHistory = next;
    };

    // Step 1: Streaming chunk arrives (close: false)
    handleChat(
      {
        uuid: "msg-stream-1",
        type: "textResponseChunk",
        textResponse: "系统默认使用 **LanceDB** 作为向量数据库。",
        sources: [
          {
            id: "chunk-1",
            docId: "doc-1",
            title: "arch.md",
            text: "架构说明：系统默认使用 LanceDB 作为向量数据库。",
            score: 0.94,
          },
        ],
        close: false,
        error: false,
      },
      setLoadingResponse,
      setChatHistory,
      _chatHistory.slice(),
      _chatHistory,
      () => {}
    );

    const streamingMsg = latestChatHistory[latestChatHistory.length - 1];
    expect(streamingMsg.animate).toBe(true);
    expect(streamingMsg.closed).toBe(false);
    expect(streamingMsg.verification).toBeUndefined();

    // Render PromptReply during streaming -> must NOT show ClaimVerification
    render(
      React.createElement(PromptReply, {
        uuid: streamingMsg.uuid,
        reply: streamingMsg.content,
        pending: streamingMsg.pending,
        sources: streamingMsg.sources,
        error: streamingMsg.error,
        closed: streamingMsg.closed,
        verification: streamingMsg.verification,
      })
    );
    expect(
      container.querySelector('[data-testid="claim-verification-panel"]')
    ).toBeNull();

    // Step 2: finalizeResponseStream arrives with verification
    const verificationPayload = {
      status: "supported",
      verificationScope: "model_extracted_claims_only",
      summary: "回答与架构文档一致。",
      claims: [
        {
          claim: "系统默认使用 LanceDB 作为向量数据库",
          answerQuote: "系统默认使用 **LanceDB** 作为向量数据库。",
          answerLocation: {
            status: "located",
            ranges: [{ start: 0, end: 27 }],
          },
          verdict: "supported",
          evidence: [
            {
              evidenceId: "ev-0",
              quote: "系统默认使用 LanceDB 作为向量数据库",
              origin: "retrieval",
              documentId: "doc-1",
              chunkId: "chunk-1",
              title: "arch.md",
              sourceUri: null,
              displayInSources: true,
            },
          ],
        },
      ],
    };

    handleChat(
      {
        uuid: "msg-stream-1",
        type: "finalizeResponseStream",
        close: true,
        error: false,
        chatId: 101,
        metrics: { duration: 1.2 },
        verification: verificationPayload,
      },
      setLoadingResponse,
      setChatHistory,
      _chatHistory.slice(0, -1),
      _chatHistory,
      () => {}
    );

    expect(loadingState).toBe(false);
    const finalizedMsg = latestChatHistory[latestChatHistory.length - 1];
    expect(finalizedMsg.closed).toBe(true);
    expect(finalizedMsg.animate).toBe(false);
    expect(finalizedMsg.verification).toEqual(verificationPayload);

    // Finalized message renders via HistoricalMessage with ClaimVerification visible
    render(
      React.createElement(HistoricalMessage, {
        uuid: finalizedMsg.uuid,
        message: finalizedMsg.content,
        role: finalizedMsg.role,
        workspace: { slug: "test-ws" },
        sources: finalizedMsg.sources,
        chatId: finalizedMsg.chatId,
        isLastMessage: true,
        metrics: finalizedMsg.metrics,
        verification: finalizedMsg.verification,
      })
    );

    const panel = container.querySelector(
      '[data-testid="claim-verification-panel"]'
    );
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("data-verification-status")).toBe("supported");
  });

  test("2 & 5. ordinary messages and legacy historical records without verification do not render ClaimVerification panel", () => {
    const legacyDbRecords = [
      {
        id: 50,
        prompt: "你好",
        response: JSON.stringify({
          text: "你好！有什么我可以帮您的？",
          sources: [],
          type: "chat",
          metrics: {},
        }),
        createdAt: new Date().toISOString(),
        feedbackScore: null,
      },
    ];

    const restoredHistory = convertToChatHistory(legacyDbRecords);
    const assistantMsg = restoredHistory.find((m) => m.role === "assistant");
    expect(assistantMsg).not.toHaveProperty("verification");

    render(
      React.createElement(HistoricalMessage, {
        uuid: "legacy-uuid",
        message: assistantMsg.content,
        role: assistantMsg.role,
        workspace: { slug: "test-ws" },
        sources: assistantMsg.sources,
        chatId: assistantMsg.chatId,
        verification: assistantMsg.verification,
      })
    );

    expect(
      container.querySelector('[data-testid="assistant-answer-content"]')
        .textContent
    ).toContain("你好！有什么我可以帮您的？");
    expect(
      container.querySelector('[data-testid="claim-verification-panel"]')
    ).toBeNull();
  });

  test("4. historical messages reload and restore verification from convertToChatHistory", () => {
    const storedVerification = {
      status: "partially_supported",
      verificationScope: "model_extracted_claims_only",
      summary: "历史校验结果恢复测试。",
      claims: [
        {
          claim: "支持历史消息恢复",
          answerQuote: "支持历史消息恢复",
          answerLocation: { status: "located", ranges: [{ start: 0, end: 8 }] },
          verdict: "supported",
          evidence: [
            {
              evidenceId: "ev-hist-0",
              quote: "历史持久化校验数据",
              origin: "retrieval",
              documentId: "doc-hist",
              chunkId: "chunk-hist",
              title: "history-spec.md",
              displayInSources: true,
            },
          ],
        },
      ],
    };

    const dbRecords = [
      {
        id: 88,
        prompt: "历史问题",
        response: JSON.stringify({
          text: "支持历史消息恢复。",
          sources: [
            {
              id: "chunk-hist",
              docId: "doc-hist",
              title: "history-spec.md",
              text: "完整分块内容：历史持久化校验数据。",
            },
          ],
          type: "query",
          metrics: {},
          verification: storedVerification,
        }),
        createdAt: new Date().toISOString(),
        feedbackScore: null,
      },
    ];

    const restored = convertToChatHistory(dbRecords);
    const assistantMsg = restored.find((m) => m.role === "assistant");
    expect(assistantMsg.verification).toEqual(storedVerification);

    render(
      React.createElement(HistoricalMessage, {
        uuid: "restored-88",
        message: assistantMsg.content,
        role: assistantMsg.role,
        workspace: { slug: "ws" },
        sources: assistantMsg.sources,
        chatId: assistantMsg.chatId,
        verification: assistantMsg.verification,
      })
    );

    const panel = container.querySelector(
      '[data-testid="claim-verification-panel"]'
    );
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("data-verification-status")).toBe(
      "partially_supported"
    );
  });

  test("6. HistoricalMessage React.memo comparator re-renders when verification prop changes", () => {
    const baseProps = {
      uuid: "memo-test-uuid",
      message: "回答内容保持不变。",
      role: "assistant",
      workspace: { slug: "ws" },
      sources: [],
      chatId: 200,
      isLastMessage: true,
      metrics: { duration: 1 },
    };

    // Initial render without verification
    render(
      React.createElement(HistoricalMessage, {
        ...baseProps,
        verification: null,
      })
    );
    expect(
      container.querySelector('[data-testid="claim-verification-panel"]')
    ).toBeNull();

    // Re-render same HistoricalMessage with new verification prop
    render(
      React.createElement(HistoricalMessage, {
        ...baseProps,
        verification: {
          status: "supported",
          claims: [
            {
              claim: "回答内容保持不变",
              answerQuote: "回答内容保持不变。",
              answerLocation: {
                status: "located",
                ranges: [{ start: 0, end: 9 }],
              },
              verdict: "supported",
              evidence: [{ evidenceId: "ev-0", quote: "证据原文" }],
            },
          ],
        },
      })
    );

    const panel = container.querySelector(
      '[data-testid="claim-verification-panel"]'
    );
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("data-verification-status")).toBe("supported");
  });

  test("7, 8 & 9. passes sources to ClaimVerification, isolates answerRootRef to assistant answer content only, and handles both successful and failed Claim quote location without mutating DOM", () => {
    const verification = {
      status: "partially_supported",
      claims: [
        {
          // Notice that claim text and answerQuote also appear inside ClaimVerification itself!
          // If answerRootRef wrongly included ClaimVerification, findUniqueDomTextRange would see 2 occurrences ("ambiguous") and fail!
          claim: "唯一回答事实句子",
          answerQuote: "唯一回答事实句子",
          answerLocation: {
            status: "located",
            ranges: [{ start: 0, end: 8 }],
          },
          verdict: "supported",
          evidence: [
            {
              evidenceId: "ev-0",
              quote: "来自源文档的精确证据句",
              origin: "retrieval",
              documentId: "doc-src",
              chunkId: "chunk-src",
              title: "source-doc.md",
              displayInSources: true,
            },
          ],
        },
        {
          // Claim 2: answerLocation says "located", but in the answer text it is duplicated -> DOM location must safely fail!
          claim: "重复出现的句子",
          answerQuote: "重复出现的句子",
          answerLocation: {
            status: "located",
            ranges: [{ start: 10, end: 17 }],
          },
          verdict: "uncertain",
          evidence: [],
        },
      ],
    };

    const sources = [
      {
        id: "chunk-src",
        docId: "doc-src",
        title: "source-doc.md",
        text: "完整源文档块：来自源文档的精确证据句，用于测试关联与高亮。",
        score: 0.93,
      },
    ];

    render(
      React.createElement(HistoricalMessage, {
        uuid: "loc-test",
        message: "唯一回答事实句子。重复出现的句子。重复出现的句子。",
        role: "assistant",
        workspace: { slug: "ws" },
        sources,
        chatId: 301,
        verification,
      })
    );

    // Expand ClaimVerification panel
    click(
      container.querySelector('[data-testid="claim-verification-toggle"]')
    );

    // Verify answerRootRef container ONLY contains the assistant answer, NOT ClaimVerification or Citations
    const answerContainer = container.querySelector(
      '[data-testid="assistant-answer-content"]'
    );
    expect(answerContainer).not.toBeNull();
    expect(
      answerContainer.querySelector('[data-testid="claim-verification-panel"]')
    ).toBeNull();

    const answerHtmlBefore = answerContainer.innerHTML;

    // Test 9a: Click Claim 0's answerQuote -> succeeds uniquely because answerRootRef excludes ClaimVerification!
    const quoteBtn0 = container.querySelector(
      '[data-testid="claim-answer-quote-0"]'
    );
    expect(quoteBtn0.getAttribute("data-locate-status")).toBe("idle");
    click(quoteBtn0);
    expect(quoteBtn0.getAttribute("data-locate-status")).toBe("located");
    expect(answerContainer.innerHTML).toBe(answerHtmlBefore);

    // Test 9b: Click Claim 1's answerQuote (duplicated in answer text) -> safely fails without mutating DOM
    const quoteBtn1 = container.querySelector(
      '[data-testid="claim-answer-quote-1"]'
    );
    click(quoteBtn1);
    expect(quoteBtn1.getAttribute("data-locate-status")).toBe("unlocated");
    expect(
      container.querySelector('[data-testid="claim-locate-feedback-1"]')
    ).not.toBeNull();
    expect(answerContainer.innerHTML).toBe(answerHtmlBefore);

    // Test 7: Click Evidence on Claim 0 -> opens CitationDetailModal with full chunk from `sources` and <mark> highlight
    click(container.querySelector('[data-testid="evidence-item-0-0"]'));
    const modal = container.querySelector(
      '[data-testid="citation-detail-modal"]'
    );
    expect(modal).not.toBeNull();
    const mark = modal.querySelector(
      'mark[data-testid="citation-highlight-quote"]'
    );
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe("来自源文档的精确证据句");
    expect(
      modal.querySelector('[data-testid="citation-modal-body"]').textContent
    ).toContain("完整源文档块：来自源文档的精确证据句，用于测试关联与高亮。");
  });

  test("10 & 11. verification_error and skipped do not alter original answer or regress existing Citations button behavior", () => {
    const sources = [
      {
        id: "c-1",
        title: "手册.pdf",
        text: "手册正文内容",
        score: 0.89,
      },
    ];

    render(
      React.createElement(HistoricalMessage, {
        uuid: "err-skip-test",
        message: "这是模型生成的原始回答正文。",
        role: "assistant",
        workspace: { slug: "ws" },
        sources,
        chatId: 401,
        verification: {
          status: "verification_error",
          error: { code: "EVALUATION_TIMEOUT" },
          claims: [],
        },
      })
    );

    // Original answer is rendered intact
    expect(
      container.querySelector('[data-testid="assistant-answer-content"]')
        .textContent
    ).toContain("这是模型生成的原始回答正文。");

    // Existing Citations button works and opens SourcesSidebar with sources
    const buttons = Array.from(container.querySelectorAll("button"));
    const citationsBtn = buttons.find((b) =>
      b.textContent.includes("chat_window.sources")
    );
    expect(citationsBtn).toBeDefined();
    click(citationsBtn);
    expect(sidebarState.openSidebarCalls).toHaveLength(1);
    expect(sidebarState.openSidebarCalls[0]).toEqual(sources);

    // Re-render with skipped status -> original answer still intact
    render(
      React.createElement(HistoricalMessage, {
        uuid: "err-skip-test",
        message: "这是模型生成的原始回答正文。",
        role: "assistant",
        workspace: { slug: "ws" },
        sources,
        chatId: 401,
        verification: {
          status: "skipped",
          skipReason: "CONTEXT_COMPRESSED",
          claims: [],
        },
      })
    );

    expect(
      container.querySelector('[data-testid="assistant-answer-content"]')
        .textContent
    ).toContain("这是模型生成的原始回答正文。");
    click(
      container.querySelector('[data-testid="claim-verification-toggle"]')
    );
    expect(
      container.querySelector(
        '[data-testid="claim-verification-skipped-message"]'
      ).textContent
    ).toContain("压缩");
  });
});
