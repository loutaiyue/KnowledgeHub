const fs = require("fs");
const path = require("path");
const Module = require("module");
const { JSDOM } = require("jsdom");

const frontendRoot = path.resolve(__dirname, "../../../../frontend");
const esbuild = require(path.join(frontendRoot, "node_modules/esbuild"));
const React = require(path.join(frontendRoot, "node_modules/react"));
const ReactDOMClient = require(
  path.join(frontendRoot, "node_modules/react-dom/client")
);
const { act } = React;
const he = require(path.join(frontendRoot, "node_modules/he"));
const truncate = require(path.join(frontendRoot, "node_modules/truncate"));

// Set up JSDOM global environment for React 18
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
    if (id === "@phosphor-icons/react") return createPhosphorStub();
    if (id === "@/components/lib/Modal") return ModalStub;
    if (id === "@/utils/numbers") {
      return {
        toPercentString: (score) => `${Math.round(Number(score) * 100)}%`,
      };
    }
    if (id === "react-i18next") {
      return {
        useTranslation: () => ({
          t: (key) => key,
        }),
      };
    }
    if (id === "../../ChatSidebar") {
      return {
        useSourcesSidebar: () => ({
          sidebarOpen: false,
          openSidebar: () => {},
          closeSidebar: () => {},
          sources: [],
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

const citationModulePath = path.join(
  frontendRoot,
  "src/components/WorkspaceChat/ChatContainer/ChatHistory/Citation/index.jsx"
);
const claimVerificationModulePath = path.join(
  frontendRoot,
  "src/components/WorkspaceChat/ChatContainer/ChatHistory/ClaimVerification/index.jsx"
);
const utilsModulePath = path.join(
  frontendRoot,
  "src/components/WorkspaceChat/ChatContainer/ChatHistory/ClaimVerification/utils.js"
);

const { CitationDetailModal } = loadFrontendModule(citationModulePath);
const { default: ClaimVerification } = loadFrontendModule(
  claimVerificationModulePath
);
const { sliceTextForHighlight } = loadFrontendModule(utilsModulePath);

describe("Phase 5.2 ClaimVerification Component & CitationDetailModal Highlighting", () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.getElementById("mount");
    container.innerHTML = "";
    root = ReactDOMClient.createRoot(container);
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

  test("1. correctly renders all 5 overall verification statuses with clear, restrained copy", () => {
    const statusExpectations = [
      {
        payload: {
          status: "supported",
          summary: "全部事实均有依据。",
          claims: [
            {
              claim: "陈述 A",
              answerQuote: "陈述 A",
              verdict: "supported",
              evidence: [{ evidenceId: "ev-0", quote: "证据 A" }],
            },
          ],
        },
        expectedStatus: "supported",
        expectedBadgeText: "已核查：证据支持",
      },
      {
        payload: {
          status: "partially_supported",
          summary: "部分事实有依据。",
          claims: [
            {
              claim: "陈述 A",
              verdict: "supported",
              evidence: [{ evidenceId: "ev-0", quote: "证据 A" }],
            },
            {
              claim: "陈述 B",
              verdict: "unsupported",
              evidence: [],
            },
          ],
        },
        expectedStatus: "partially_supported",
        expectedBadgeText: "部分证据支持",
      },
      {
        payload: {
          status: "unsupported",
          summary: "未找到支持证据。",
          claims: [
            {
              claim: "陈述 C",
              verdict: "unsupported",
              evidence: [],
            },
          ],
        },
        expectedStatus: "unsupported",
        expectedBadgeText: "缺乏证据支持",
      },
      {
        payload: {
          status: "skipped",
          skipReason: "NO_VERIFIABLE_CONTEXT",
          claims: [],
        },
        expectedStatus: "skipped",
        expectedBadgeText: "未执行事实核查",
      },
      {
        payload: {
          status: "verification_error",
          error: { code: "EVALUATION_TIMEOUT" },
          claims: [],
        },
        expectedStatus: "verification_error",
        expectedBadgeText: "核查未完成",
      },
    ];

    for (const item of statusExpectations) {
      render(
        React.createElement(ClaimVerification, {
          verification: item.payload,
          defaultExpanded: true,
        })
      );

      const panel = container.querySelector(
        '[data-testid="claim-verification-panel"]'
      );
      expect(panel).not.toBeNull();
      expect(panel.getAttribute("data-verification-status")).toBe(
        item.expectedStatus
      );

      const badge = container.querySelector(
        '[data-testid="claim-verification-status-badge"]'
      );
      expect(badge.textContent).toContain(item.expectedBadgeText);
    }
  });

  test("2. renders supported, unsupported, and uncertain Claim verdicts distinctly without replacing them with overall status", () => {
    const verification = {
      status: "partially_supported",
      claims: [
        {
          claim: "LanceDB 是内置默认向量数据库",
          verdict: "supported",
          evidence: [{ evidenceId: "ev-0", quote: "默认使用 LanceDB" }],
        },
        {
          claim: "支持量子纠缠加速索引",
          verdict: "unsupported",
          reason: "检索上下文中未提及量子计算相关特性",
          evidence: [],
        },
        {
          claim: "单次批处理延迟低于 5ms",
          verdict: "uncertain",
          reason: "文档仅给出平均值，未说明单次上限",
          evidence: [{ evidenceId: "ev-2", quote: "平均耗时约 5ms 至 15ms" }],
        },
      ],
    };

    render(
      React.createElement(ClaimVerification, {
        verification,
        defaultExpanded: true,
      })
    );

    expect(
      container.querySelector('[data-testid="claim-verdict-badge-0"]')
        .textContent
    ).toBe("证据支持");
    expect(
      container.querySelector('[data-testid="claim-verdict-badge-1"]')
        .textContent
    ).toBe("无证据支持");
    expect(
      container.querySelector('[data-testid="claim-verdict-badge-2"]')
        .textContent
    ).toBe("证据存疑");
  });

  test("3. renders multiple Claims and multiple Evidences with titles, quotes, origins, and reasons", () => {
    const verification = {
      status: "supported",
      summary: "共核查 2 条陈述。",
      claims: [
        {
          claim: "第一条陈述",
          answerQuote: "第一条陈述原文",
          verdict: "supported",
          evidence: [
            {
              evidenceId: "ev-0",
              quote: "证据片段一",
              origin: "retrieval",
              documentId: "doc-1",
              chunkId: "c-1",
              title: "存储说明.md",
            },
            {
              evidenceId: "ev-1",
              quote: "证据片段二",
              origin: "pinned",
              documentId: "doc-2",
              chunkId: "c-2",
              title: "架构规范.pdf",
            },
          ],
        },
        {
          claim: "第二条陈述",
          answerQuote: "第二条陈述原文",
          verdict: "supported",
          reason: "多文档交叉印证",
          evidence: [
            {
              evidenceId: "ev-2",
              quote: "证据片段三",
              origin: "attachment",
              documentId: null,
              chunkId: "att-1",
              title: "上传附件.txt",
            },
          ],
        },
      ],
    };

    render(
      React.createElement(ClaimVerification, {
        verification,
        defaultExpanded: true,
      })
    );

    expect(
      container.querySelector('[data-testid="evidence-title-0-0"]').textContent
    ).toBe("存储说明.md");
    expect(
      container.querySelector('[data-testid="evidence-title-0-1"]').textContent
    ).toBe("架构规范.pdf");
    expect(
      container.querySelector('[data-testid="evidence-title-1-0"]').textContent
    ).toBe("上传附件.txt");
    expect(
      container.querySelector('[data-testid="evidence-origin-badge-0-1"]')
        .textContent
    ).toBe("置顶文档");
    expect(
      container.querySelector('[data-testid="evidence-origin-badge-1-0"]')
        .textContent
    ).toBe("会话附件");
    expect(
      container.querySelector('[data-testid="claim-reason-1"]').textContent
    ).toContain("多文档交叉印证");
  });

  test("4. supports panel expand/collapse and individual claim card expand/collapse", () => {
    const verification = {
      status: "supported",
      claims: [
        {
          claim: "可折叠陈述",
          answerQuote: "可折叠陈述",
          verdict: "supported",
          evidence: [{ evidenceId: "ev-0", quote: "证据内容" }],
        },
      ],
    };

    render(React.createElement(ClaimVerification, { verification }));
    expect(
      container.querySelector('[data-testid="claim-verification-body"]')
    ).toBeNull();

    const panelToggle = container.querySelector(
      '[data-testid="claim-verification-toggle"]'
    );
    click(panelToggle);
    expect(
      container.querySelector('[data-testid="claim-verification-body"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="claim-card-details-0"]')
    ).not.toBeNull();

    const claimToggle = container.querySelector(
      '[data-testid="claim-card-toggle-0"]'
    );
    click(claimToggle);
    expect(
      container.querySelector('[data-testid="claim-card-details-0"]')
    ).toBeNull();

    click(claimToggle);
    expect(
      container.querySelector('[data-testid="claim-card-details-0"]')
    ).not.toBeNull();

    click(panelToggle);
    expect(
      container.querySelector('[data-testid="claim-verification-body"]')
    ).toBeNull();
  });

  test("5. displays explicit historical context badge for history evidence in both card and modal", () => {
    const verification = {
      status: "supported",
      claims: [
        {
          claim: "包含历史证据的陈述",
          verdict: "supported",
          evidence: [
            {
              evidenceId: "ev-hist",
              quote: "历史回填证据内容",
              origin: "history",
              documentId: "doc-1",
              chunkId: "chunk-1",
              title: "历史文档.md",
              displayInSources: false,
            },
          ],
        },
      ],
    };

    render(
      React.createElement(ClaimVerification, {
        verification,
        defaultExpanded: true,
      })
    );

    const histBadge = container.querySelector(
      '[data-testid="evidence-origin-badge-0-0"]'
    );
    expect(histBadge.textContent).toBe("历史上下文");

    click(container.querySelector('[data-testid="evidence-item-0-0"]'));
    expect(
      container.querySelector('[data-testid="citation-modal-history-badge"]')
        .textContent
    ).toBe("历史上下文");
  });

  test("6. displays text snapshot preview when documentId is null", () => {
    const verification = {
      status: "supported",
      claims: [
        {
          claim: "无文档 ID 的陈述",
          verdict: "supported",
          evidence: [
            {
              evidenceId: "ev-null-doc",
              quote: "无文档 ID 的证据快照原文",
              origin: "retrieval",
              documentId: null,
              chunkId: "chunk-orphan",
              title: "未关联分块.txt",
              displayInSources: true,
            },
          ],
        },
      ],
    };

    render(
      React.createElement(ClaimVerification, {
        verification,
        messageSources: [
          {
            id: "chunk-orphan",
            title: "未关联分块.txt",
            text: "不应被猜测关联的全文",
          },
        ],
        defaultExpanded: true,
      })
    );

    expect(
      container.querySelector('[data-testid="evidence-snapshot-badge-0-0"]')
        .textContent
    ).toBe("文本快照");

    click(container.querySelector('[data-testid="evidence-item-0-0"]'));
    expect(
      container.querySelector('[data-testid="citation-modal-snapshot-badge"]')
        .textContent
    ).toBe("文本快照");
    expect(
      container.querySelector('[data-testid="citation-modal-body"]').textContent
    ).toContain("无文档 ID 的证据快照原文");
    expect(
      container.querySelector('[data-testid="citation-modal-body"]').textContent
    ).not.toContain("不应被猜测关联的全文");
  });

  test("7. clicking Evidence opens CitationDetailModal displaying the linked original chunk", () => {
    const verification = {
      status: "supported",
      claims: [
        {
          claim: "向量检索通过 document_vectors 表关联文档",
          verdict: "supported",
          evidence: [
            {
              evidenceId: "ev-0",
              quote: "通过 document_vectors 表映射 docId",
              origin: "retrieval",
              documentId: "doc-99",
              chunkId: "vec-42",
              title: "数据库设计.md",
              displayInSources: true,
            },
          ],
        },
      ],
    };

    const messageSources = [
      {
        id: "vec-42",
        docId: "doc-99",
        title: "数据库设计.md",
        text: "前序段落说明。核心机制：通过 document_vectors 表映射 docId，从而补齐工作区文档元数据。",
        score: 0.91,
      },
    ];

    render(
      React.createElement(ClaimVerification, {
        verification,
        messageSources,
        defaultExpanded: true,
      })
    );

    click(container.querySelector('[data-testid="evidence-item-0-0"]'));

    const modal = container.querySelector(
      '[data-testid="citation-detail-modal"]'
    );
    expect(modal).not.toBeNull();
    expect(
      modal.querySelector('[data-testid="citation-modal-body"]').textContent
    ).toContain(
      "前序段落说明。核心机制：通过 document_vectors 表映射 docId，从而补齐工作区文档元数据。"
    );
  });

  test("8. highlightQuote highlights the exact evidence quote inside CitationDetailModal via <mark>", () => {
    render(
      React.createElement(CitationDetailModal, {
        source: {
          title: "数据库设计.md",
          references: 1,
          chunks: [
            {
              id: "vec-42",
              text: "<document_metadata>\nsource: db\n</document_metadata>\n前序说明。通过 document_vectors 表映射 docId。后续说明。",
              score: 0.95,
            },
          ],
        },
        highlightQuote: "通过 document_vectors 表映射 docId",
        onClose: () => {},
      })
    );

    const mark = container.querySelector(
      'mark[data-testid="citation-highlight-quote"]'
    );
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe("通过 document_vectors 表映射 docId");
    expect(
      container.querySelector('[data-testid="citation-modal-body"]').textContent
    ).toContain("前序说明。通过 document_vectors 表映射 docId。后续说明。");
  });

  test("9. safely degrades without <mark> when highlightQuote is not found or appears multiple times in chunk text", () => {
    const repeatedText = "重复片段。中间内容。重复片段。";
    expect(sliceTextForHighlight(repeatedText, "重复片段").matched).toBe(false);
    expect(sliceTextForHighlight(repeatedText, "不存在的片段").matched).toBe(
      false
    );

    render(
      React.createElement(CitationDetailModal, {
        source: {
          title: "重复测试文档.md",
          references: 1,
          chunks: [{ id: "c1", text: repeatedText, score: 0.8 }],
        },
        highlightQuote: "重复片段",
        onClose: () => {},
      })
    );

    const modalBody = container.querySelector(
      '[data-testid="citation-modal-body"]'
    );
    expect(modalBody.textContent).toContain(repeatedText);
    expect(
      modalBody.querySelector('mark[data-testid="citation-highlight-quote"]')
    ).toBeNull();
  });

  test("10. illegal sourceUri (file://, lancedb://, javascript:) never renders external links", () => {
    const verification = {
      status: "supported",
      claims: [
        {
          claim: "非法外链拦截测试",
          verdict: "supported",
          evidence: [
            {
              evidenceId: "ev-bad",
              quote: "内部证据原文",
              origin: "retrieval",
              documentId: "doc-1",
              chunkId: "chunk-1",
              title: "internal.pdf",
              sourceUri: "javascript:alert(1)",
            },
          ],
        },
      ],
    };

    const messageSources = [
      {
        id: "chunk-1",
        docId: "doc-1",
        title: "internal.pdf",
        text: "包含内部证据原文的完整块",
        chunkSource: "file:///etc/passwd",
        docpath: "custom-documents/internal.pdf-hash.json",
      },
    ];

    render(
      React.createElement(ClaimVerification, {
        verification,
        messageSources,
        defaultExpanded: true,
      })
    );

    click(container.querySelector('[data-testid="evidence-item-0-0"]'));

    const modalHeader = container.querySelector(
      '[data-testid="citation-modal-header"]'
    );
    expect(modalHeader.querySelector("a")).toBeNull();
    expect(modalHeader.textContent).toContain("internal.pdf");
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.innerHTML).not.toContain("file://");
    expect(container.innerHTML).not.toContain("custom-documents");
  });

  test("11. missing fields and malformed data do not crash the UI", () => {
    render(
      React.createElement(ClaimVerification, {
        verification: { status: "unknown_broken_state", claims: null },
        defaultExpanded: true,
      })
    );
    expect(
      container.querySelector(
        '[data-testid="claim-verification-error-message"]'
      )
    ).not.toBeNull();
  });

  test("12. ordinary chat messages without verification render nothing and legacy CitationDetailModal calls remain compatible", () => {
    render(React.createElement(ClaimVerification, { verification: null }));
    expect(container.innerHTML).toBe("");

    render(React.createElement(ClaimVerification, { verification: undefined }));
    expect(container.innerHTML).toBe("");

    render(
      React.createElement(CitationDetailModal, {
        source: {
          title: "普通引用文档.txt",
          references: 2,
          chunks: [
            {
              id: "legacy-1",
              text: "普通引用分块一内容",
              chunkSource: "link://https://anythingllm.com/docs",
              score: 0.88,
            },
          ],
        },
        onClose: () => {},
      })
    );

    const modalHeader = container.querySelector(
      '[data-testid="citation-modal-header"]'
    );
    expect(modalHeader.querySelector("a")?.getAttribute("href")).toBe(
      "https://anythingllm.com/docs"
    );
    expect(
      container.querySelector('[data-testid="citation-modal-subtitle"]')
        .textContent
    ).toBe("Referenced 2 times.");
    expect(
      container.querySelector('[data-testid="citation-modal-history-badge"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="citation-modal-snapshot-badge"]')
    ).toBeNull();
  });

  test("13. renders explicit Chinese error descriptions for all verification_error codes while keeping verification_error status", () => {
    const cases = [
      ["INVALID_JSON", "事实核查结果格式解析失败（JSON 格式无效）"],
      ["INVALID_SCHEMA", "事实核查结果结构校验未通过"],
      ["EVALUATION_FAILED", "事实核查服务调用失败"],
      ["evaluation_context_not_preserved", "当前会话上下文经过压缩或截断"],
      ["evaluation_context_too_large", "待核查的证据上下文超出模型评估窗口上限"],
      ["evaluator_unavailable", "当前模型提供方暂不支持自动事实核查"],
      ["EVALUATION_TIMEOUT", "事实核查请求超时"],
    ];

    for (const [code, expectedText] of cases) {
      render(
        React.createElement(ClaimVerification, {
          verification: {
            status: "verification_error",
            summary: "Answer verification could not be completed.",
            claims: [],
            error: { code },
          },
          defaultExpanded: true,
        })
      );

      const panel = container.querySelector(
        '[data-testid="claim-verification-panel"]'
      );
      expect(panel.getAttribute("data-verification-status")).toBe(
        "verification_error"
      );
      expect(
        container.querySelector(
          '[data-testid="claim-verification-status-badge"]'
        ).textContent
      ).toContain("核查未完成");

      const errorMessage = container.querySelector(
        '[data-testid="claim-verification-error-message"]'
      ).textContent;
      expect(errorMessage).toContain(expectedText);
      expect(errorMessage).not.toContain(
        "Answer verification could not be completed."
      );
    }
  });
});
