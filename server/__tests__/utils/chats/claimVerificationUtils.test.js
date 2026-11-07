const fs = require("fs");
const path = require("path");
const Module = require("module");
const { JSDOM } = require("jsdom");

function loadFrontendEsmModule(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const exportedNames = [];
  const cjsSource = source.replace(
    /export\s+function\s+([A-Za-z0-9_$]+)/g,
    (_, fnName) => {
      exportedNames.push(fnName);
      return `function ${fnName}`;
    }
  );
  const mod = new Module(filePath, module);
  mod.filename = filePath;
  mod.paths = Module._nodeModulePaths(path.dirname(filePath));
  mod._compile(
    `${cjsSource}\nmodule.exports = { ${exportedNames.join(", ")} };`,
    filePath
  );
  return mod.exports;
}

const utilsPath = path.resolve(
  __dirname,
  "../../../../frontend/src/components/WorkspaceChat/ChatContainer/ChatHistory/ClaimVerification/utils.js"
);
const {
  normalizeVerification,
  buildEvidencePreviewSource,
  findUniqueDomTextRange,
  sanitizeHttpUrl,
} = loadFrontendEsmModule(utilsPath);

function deepFreeze(obj) {
  if (!obj || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return obj;
}

function createDomRoot(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="root">${html}</div></body></html>`);
  return dom.window.document.getElementById("root");
}

describe("Phase 5.1 ClaimVerification Pure Functions", () => {
  describe("1. normalizeVerification - 5 statuses & missing fields", () => {
    test("correctly normalizes a valid supported verification payload", () => {
      const input = {
        status: "supported",
        verificationScope: "model_extracted_claims_only",
        summary: "所有事实陈述均有检索证据支持。",
        claims: [
          {
            claim: "系统使用 LanceDB 作为默认向量库。",
            answerQuote: "系统使用 LanceDB 作为默认向量库。",
            answerLocation: {
              status: "located",
              ranges: [{ start: 0, end: 18 }],
            },
            verdict: "supported",
            evidence: [
              {
                evidenceId: "ev-0",
                quote: "默认向量数据库为 LanceDB",
                origin: "retrieval",
                documentId: "doc-100",
                chunkId: "chunk-1",
                title: "architecture.md",
                sourceUri: "https://docs.anythingllm.com/lancedb",
                displayInSources: true,
              },
            ],
          },
        ],
      };

      const result = normalizeVerification(input);
      expect(result.isValid).toBe(true);
      expect(result.status).toBe("supported");
      expect(result.verificationScope).toBe("model_extracted_claims_only");
      expect(result.summary).toBe("所有事实陈述均有检索证据支持。");
      expect(result.claims).toHaveLength(1);
      expect(result.claims[0]).toEqual({
        claim: "系统使用 LanceDB 作为默认向量库。",
        answerQuote: "系统使用 LanceDB 作为默认向量库。",
        answerLocation: {
          status: "located",
          ranges: [{ start: 0, end: 18 }],
        },
        verdict: "supported",
        evidence: [
          {
            evidenceId: "ev-0",
            quote: "默认向量数据库为 LanceDB",
            origin: "retrieval",
            documentId: "doc-100",
            chunkId: "chunk-1",
            title: "architecture.md",
            sourceUri: "https://docs.anythingllm.com/lancedb",
            displayInSources: true,
          },
        ],
      });
      expect(result.error).toBeNull();
    });

    test("correctly normalizes partially_supported, unsupported, skipped, and verification_error statuses", () => {
      const partial = normalizeVerification({
        status: "partially_supported",
        summary: "部分支持",
        claims: [
          {
            claim: "支持的陈述",
            answerQuote: "支持的陈述",
            answerLocation: { status: "located", ranges: [{ start: 0, end: 5 }] },
            verdict: "supported",
            evidence: [{ evidenceId: "ev-0", quote: "证据原文" }],
          },
          {
            claim: "未支持的陈述",
            answerQuote: "未支持的陈述",
            answerLocation: { status: "not_found", ranges: [] },
            verdict: "unsupported",
            evidence: [],
          },
        ],
      });
      expect(partial.status).toBe("partially_supported");
      expect(partial.claims).toHaveLength(2);
      expect(partial.claims[0].verdict).toBe("supported");
      expect(partial.claims[1].verdict).toBe("unsupported");

      const unsupported = normalizeVerification({
        status: "unsupported",
        summary: "无证据支持",
        claims: [
          {
            claim: "无依据陈述",
            answerQuote: "无依据陈述",
            answerLocation: { status: "ambiguous", ranges: [{ start: 0, end: 5 }, { start: 10, end: 15 }] },
            verdict: "uncertain",
            evidence: [],
          },
        ],
      });
      expect(unsupported.status).toBe("unsupported");
      expect(unsupported.claims[0].verdict).toBe("uncertain");
      expect(unsupported.claims[0].answerLocation.status).toBe("ambiguous");

      const skipped = normalizeVerification({
        status: "skipped",
        reason: "NO_VERIFIABLE_CONTEXT",
        skipReason: "NO_VERIFIABLE_CONTEXT",
        summary: "Skipped verification.",
        claims: [],
      });
      expect(skipped.isValid).toBe(true);
      expect(skipped.status).toBe("skipped");
      expect(skipped.skipReason).toBe("NO_VERIFIABLE_CONTEXT");
      expect(skipped.claims).toEqual([]);

      const verError = normalizeVerification({
        status: "verification_error",
        summary: "Failed",
        claims: [],
        error: { code: "EVALUATION_TIMEOUT" },
      });
      expect(verError.isValid).toBe(true);
      expect(verError.status).toBe("verification_error");
      expect(verError.error).toEqual({ code: "EVALUATION_TIMEOUT" });
      expect(verError.claims).toEqual([]);
    });

    test("never misclassifies as supported when claims or evidence fields are missing", () => {
      // Missing claims array on "supported" status
      const missingClaims = normalizeVerification({
        status: "supported",
        summary: "Missing claims",
      });
      expect(missingClaims.status).toBe("verification_error");
      expect(missingClaims.status).not.toBe("supported");

      // Empty claims array on "supported" status
      const emptyClaims = normalizeVerification({
        status: "supported",
        claims: [],
      });
      expect(emptyClaims.status).toBe("verification_error");
      expect(emptyClaims.status).not.toBe("supported");

      // Claim says "supported" but has empty evidence array -> downgraded to unsupported
      const claimWithoutEvidence = normalizeVerification({
        status: "supported",
        claims: [
          {
            claim: "声称支持但没有证据",
            answerQuote: "声称支持但没有证据",
            verdict: "supported",
            evidence: [],
          },
        ],
      });
      expect(claimWithoutEvidence.status).toBe("unsupported");
      expect(claimWithoutEvidence.claims[0].verdict).toBe("unsupported");

      // Claim says "supported" but evidence lacks quote or evidenceId -> downgraded
      const claimWithIncompleteEvidence = normalizeVerification({
        status: "supported",
        claims: [
          {
            claim: "证据缺少 quote",
            verdict: "supported",
            evidence: [{ evidenceId: "ev-0", quote: "   " }],
          },
        ],
      });
      expect(claimWithIncompleteEvidence.status).toBe("unsupported");
      expect(claimWithIncompleteEvidence.claims[0].verdict).toBe("unsupported");

      // Claim missing verdict defaults to uncertain, so overall status is unsupported
      const claimMissingVerdict = normalizeVerification({
        status: "supported",
        claims: [
          {
            claim: "缺失 verdict 字段",
            evidence: [{ evidenceId: "ev-0", quote: "有效证据" }],
          },
        ],
      });
      expect(claimMissingVerdict.claims[0].verdict).toBe("uncertain");
      expect(claimMissingVerdict.status).toBe("unsupported");
    });
  });

  describe("2. normalizeVerification - null, undefined, invalid structures & unknown statuses", () => {
    test("safely handles null, undefined, primitives, arrays, and unknown status values", () => {
      for (const badInput of [
        null,
        undefined,
        "",
        123,
        true,
        [],
        {},
        { status: "not_verified" },
        { status: "unknown_status", claims: [] },
        { status: 42 },
      ]) {
        const res = normalizeVerification(badInput);
        expect(res.isValid).toBe(false);
        expect(res.status).toBe("verification_error");
        expect(res.claims).toEqual([]);
        expect(res.error).toBeDefined();
      }
    });

    test("filters out malformed claim items while keeping valid ones", () => {
      const res = normalizeVerification({
        status: "supported",
        claims: [
          null,
          "invalid-claim",
          { claim: "   " },
          {
            claim: "合法陈述",
            answerQuote: "合法陈述",
            answerLocation: { status: "located", ranges: [{ start: 0, end: 4 }] },
            verdict: "supported",
            evidence: [
              null,
              { evidenceId: "", quote: "x" },
              { evidenceId: "ev-1", quote: "真实证据片段" },
            ],
          },
        ],
      });

      expect(res.isValid).toBe(true);
      expect(res.status).toBe("supported");
      expect(res.claims).toHaveLength(1);
      expect(res.claims[0].claim).toBe("合法陈述");
      expect(res.claims[0].evidence).toHaveLength(1);
      expect(res.claims[0].evidence[0].evidenceId).toBe("ev-1");
    });
  });

  describe("3. buildEvidencePreviewSource - reliable ID linking vs snapshot fallback", () => {
    test("links by matching evidenceId when present on messageSources", () => {
      const evidence = {
        evidenceId: "ev-2",
        quote: "关键证据句子",
        origin: "retrieval",
        documentId: "doc-1",
        chunkId: "chunk-9",
        title: "设计文档.pdf",
        sourceUri: "https://example.com/design",
        displayInSources: true,
      };
      const messageSources = [
        {
          evidenceId: "ev-2",
          id: "chunk-9",
          docId: "doc-1",
          title: "设计文档.pdf",
          text: "前文内容。关键证据句子。后文完整上下文内容。",
          chunkSource: "https://example.com/design",
          score: 0.92,
        },
      ];

      const preview = buildEvidencePreviewSource(evidence, messageSources);
      expect(preview.isSnapshot).toBe(false);
      expect(preview.title).toBe("设计文档.pdf");
      expect(preview.chunks).toHaveLength(1);
      expect(preview.chunks[0].text).toBe(
        "前文内容。关键证据句子。后文完整上下文内容。"
      );
      expect(preview.chunks[0].highlightQuote).toBe("关键证据句子");
      expect(preview.chunks[0].score).toBe(0.92);
      expect(preview.externalUrl).toBe("https://example.com/design");
    });

    test("links by documentId + chunkId when evidenceId is not on legacy messageSources", () => {
      const evidence = {
        evidenceId: "ev-0",
        quote: "LanceDB 存储 384 维向量",
        origin: "retrieval",
        documentId: "doc-abc",
        chunkId: "vec-123",
        title: "vector.md",
        sourceUri: null,
        displayInSources: true,
      };
      const messageSources = [
        {
          id: "vec-123",
          docId: "doc-abc",
          title: "vector.md",
          text: "章节一：LanceDB 存储 384 维向量，包含 id、vector 和 text 字段。",
          score: 0.85,
        },
      ];

      const preview = buildEvidencePreviewSource(evidence, messageSources);
      expect(preview.isSnapshot).toBe(false);
      expect(preview.documentId).toBe("doc-abc");
      expect(preview.chunkId).toBe("vec-123");
      expect(preview.chunks[0].text).toBe(
        "章节一：LanceDB 存储 384 维向量，包含 id、vector 和 text 字段。"
      );
      expect(preview.chunks[0].highlightQuote).toBe("LanceDB 存储 384 维向量");
    });

    test("never matches solely by title, filename, sourceUri, or chunkId without documentId; falls back to text snapshot", () => {
      const evidence = {
        evidenceId: "ev-5",
        quote: "只属于证据 B 的快照内容",
        origin: "retrieval",
        documentId: "doc-target",
        chunkId: "chunk-target",
        title: "同名报告.pdf",
        sourceUri: "https://example.com/same-url",
        displayInSources: true,
      };

      const messageSources = [
        {
          // Same title and same URL, but different docId/chunkId
          id: "chunk-other",
          docId: "doc-other",
          title: "同名报告.pdf",
          text: "完全不同的另一份同名文档全文内容",
          chunkSource: "https://example.com/same-url",
        },
        {
          // Same chunkId, but missing docId
          id: "chunk-target",
          title: "同名报告.pdf",
          text: "缺少 docId 的来源，不能盲目匹配",
        },
      ];

      const preview = buildEvidencePreviewSource(evidence, messageSources);
      expect(preview.isSnapshot).toBe(true);
      expect(preview.chunks[0].text).toBe("只属于证据 B 的快照内容");
      expect(preview.chunks[0].highlightQuote).toBe("只属于证据 B 的快照内容");
    });
  });

  describe("4. buildEvidencePreviewSource - documentId === null snapshot fallback", () => {
    test("falls back to text snapshot when documentId is null even if chunkId and title exist in messageSources", () => {
      const attachmentEvidence = {
        evidenceId: "ev-att-0",
        quote: "上传附件中的原始段落",
        origin: "attachment",
        documentId: null,
        chunkId: "att-1",
        title: "upload.txt",
        sourceUri: null,
        displayInSources: true,
      };
      const unmappedRetrievalEvidence = {
        evidenceId: "ev-unmapped-1",
        quote: "未关联文档 ID 的向量块摘录",
        origin: "retrieval",
        documentId: null,
        chunkId: "vec-orphan",
        title: "orphan.pdf",
        sourceUri: null,
        displayInSources: true,
      };

      const messageSources = [
        {
          evidenceId: "ev-att-0",
          id: "att-1",
          title: "upload.txt",
          text: "被截断的 1000 字符预览文本...",
        },
        {
          id: "vec-orphan",
          docId: "some-doc",
          title: "orphan.pdf",
          text: "不应被匹配的文档全文",
        },
      ];

      const attPreview = buildEvidencePreviewSource(
        attachmentEvidence,
        messageSources
      );
      expect(attPreview.isSnapshot).toBe(true);
      expect(attPreview.documentId).toBeNull();
      expect(attPreview.chunks[0].text).toBe("上传附件中的原始段落");

      const unmappedPreview = buildEvidencePreviewSource(
        unmappedRetrievalEvidence,
        messageSources
      );
      expect(unmappedPreview.isSnapshot).toBe(true);
      expect(unmappedPreview.documentId).toBeNull();
      expect(unmappedPreview.chunks[0].text).toBe("未关联文档 ID 的向量块摘录");
    });
  });

  describe("5. origin === 'history' & displayInSources === false historical markers", () => {
    test("preserves historical markers and never links history evidence as a current-turn source", () => {
      const historyEvidence = {
        evidenceId: "ev-hist-1",
        quote: "上一轮对话中引用的历史背景事实",
        origin: "history",
        documentId: "doc-1",
        chunkId: "chunk-1",
        title: "history-doc.md",
        sourceUri: "https://example.com/history-doc",
        displayInSources: false,
      };

      const hiddenEvidence = {
        evidenceId: "ev-hidden-2",
        quote: "displayInSources 为 false 的证据",
        origin: "retrieval",
        documentId: "doc-1",
        chunkId: "chunk-1",
        title: "history-doc.md",
        sourceUri: null,
        displayInSources: false,
      };

      const messageSources = [
        {
          evidenceId: "ev-hist-1",
          id: "chunk-1",
          docId: "doc-1",
          title: "history-doc.md",
          text: "本轮恰好也检索到了同一分块",
        },
      ];

      const histPreview = buildEvidencePreviewSource(
        historyEvidence,
        messageSources
      );
      expect(histPreview.isHistory).toBe(true);
      expect(histPreview.displayInSources).toBe(false);
      expect(histPreview.isSnapshot).toBe(true);
      expect(histPreview.chunks[0].text).toBe("上一轮对话中引用的历史背景事实");

      const hiddenPreview = buildEvidencePreviewSource(
        hiddenEvidence,
        messageSources
      );
      expect(hiddenPreview.isHistory).toBe(true);
      expect(hiddenPreview.displayInSources).toBe(false);
      expect(hiddenPreview.isSnapshot).toBe(true);

      // Also verify normalizeVerification forces displayInSources: false for origin === "history"
      const normalized = normalizeVerification({
        status: "supported",
        claims: [
          {
            claim: "历史陈述",
            answerQuote: "历史陈述",
            answerLocation: { status: "located", ranges: [{ start: 0, end: 4 }] },
            verdict: "supported",
            evidence: [
              {
                evidenceId: "ev-h",
                quote: "历史证据",
                origin: "history",
                displayInSources: true, // Should be forced to false
              },
            ],
          },
        ],
      });
      expect(normalized.claims[0].evidence[0].origin).toBe("history");
      expect(normalized.claims[0].evidence[0].displayInSources).toBe(false);
    });
  });

  describe("6. Filtering docpath and rejecting non-http/https URLs", () => {
    test("strips docpath and blocks file://, lancedb://, javascript:, data:, and internal paths", () => {
      const dangerousUrls = [
        "file:///C:/Users/admin/secret.txt",
        "lancedb://workspace/vectors",
        "javascript:alert(document.cookie)",
        "JAVASCRIPT:evil()",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "ftp://files.example.com/doc.pdf",
        "link://javascript:alert(1)",
        "custom-documents/internal-file-hash.json",
        "C:\\storage\\documents\\secret.json",
        "/var/lib/anythingllm/storage/doc.json",
      ];

      for (const badUrl of dangerousUrls) {
        expect(sanitizeHttpUrl(badUrl)).toBeNull();
      }

      expect(sanitizeHttpUrl("https://docs.anythingllm.com/guide")).toBe(
        "https://docs.anythingllm.com/guide"
      );
      expect(sanitizeHttpUrl("http://localhost:3001/api/docs")).toBe(
        "http://localhost:3001/api/docs"
      );

      const normalized = normalizeVerification({
        status: "supported",
        claims: [
          {
            claim: "安全过滤测试",
            answerQuote: "安全过滤测试",
            answerLocation: { status: "located", ranges: [{ start: 0, end: 6 }] },
            verdict: "supported",
            evidence: [
              {
                evidenceId: "ev-sec",
                quote: "安全测试引用",
                origin: "pinned",
                documentId: "doc-sec",
                chunkId: "chunk-sec",
                title: "sec.pdf",
                sourceUri: "file:///etc/passwd",
                docpath: "custom-documents/sec.pdf-1234.json",
                displayInSources: true,
              },
            ],
          },
        ],
      });

      const normEv = normalized.claims[0].evidence[0];
      expect(normEv.sourceUri).toBeNull();
      expect(normEv).not.toHaveProperty("docpath");
      expect(JSON.stringify(normalized)).not.toContain("custom-documents");
      expect(JSON.stringify(normalized)).not.toContain("file://");

      const preview = buildEvidencePreviewSource(
        {
          evidenceId: "ev-sec",
          quote: "安全测试引用",
          origin: "retrieval",
          documentId: "doc-sec",
          chunkId: "chunk-sec",
          title: "sec.pdf",
          sourceUri: "lancedb://internal/table",
          docpath: "custom-documents/sec.pdf-1234.json",
        },
        [
          {
            id: "chunk-sec",
            docId: "doc-sec",
            title: "sec.pdf",
            text: "完整安全测试内容",
            chunkSource: "javascript:alert(1)",
            docpath: "custom-documents/sec.pdf-1234.json",
          },
        ]
      );

      expect(preview.externalUrl).toBeNull();
      expect(preview.chunks[0].chunkSource).toBe("");
      expect(preview).not.toHaveProperty("docpath");
      expect(preview.chunks[0]).not.toHaveProperty("docpath");
      expect(JSON.stringify(preview)).not.toContain("custom-documents");
      expect(JSON.stringify(preview)).not.toContain("lancedb://");
      expect(JSON.stringify(preview)).not.toContain("javascript:");
    });
  });

  describe("7. findUniqueDomTextRange - Chinese, Emoji, Markdown bold, lists, and line breaks", () => {
    test("locates Chinese text and multi-byte Emoji accurately", () => {
      const root = createDomRoot(
        "<p>欢迎使用 KnowledgeHub 🎉！系统已完成 100% 证据核查 🚀，结果可靠 ✅。</p>"
      );
      const quote = "系统已完成 100% 证据核查 🚀，结果可靠 ✅";
      const range = findUniqueDomTextRange(root, quote, {
        status: "located",
        ranges: [{ start: 18, end: 44 }],
      });

      expect(range).not.toBeNull();
      expect(range.toString()).toBe(quote);
    });

    test("locates quote when raw answerQuote contains Markdown bold, italic, or code markers", () => {
      const root = createDomRoot(
        "<p>系统默认采用 <strong>LanceDB</strong> 引擎，配合 <em>DeepSeek</em> 实现 <code>evidenceId</code> 级校验。</p>"
      );
      const rawMarkdownQuote =
        "默认采用 **LanceDB** 引擎，配合 *DeepSeek* 实现 `evidenceId` 级校验";

      const range = findUniqueDomTextRange(root, rawMarkdownQuote, {
        status: "located",
        ranges: [{ start: 2, end: 57 }],
      });

      expect(range).not.toBeNull();
      expect(range.toString()).toBe(
        "默认采用 LanceDB 引擎，配合 DeepSeek 实现 evidenceId 级校验"
      );
    });

    test("locates quotes inside Markdown lists and across list items / line breaks", () => {
      const root = createDomRoot(`
        <ul>
          <li>第一阶段：统一 Evidence 数据层</li>
          <li>第二阶段：接入流式工作区聊天 🚀</li>
        </ul>
      `);

      // Single list item with raw Markdown bullet prefix
      const singleItemRange = findUniqueDomTextRange(
        root,
        "- 第一阶段：统一 Evidence 数据层",
        { status: "located", ranges: [{ start: 0, end: 24 }] }
      );
      expect(singleItemRange).not.toBeNull();
      expect(singleItemRange.toString()).toBe("第一阶段：统一 Evidence 数据层");

      // Multi-item list quote with newline
      const multiItemRange = findUniqueDomTextRange(
        root,
        "- 第一阶段：统一 Evidence 数据层\n- 第二阶段：接入流式工作区聊天 🚀",
        { status: "located", ranges: [{ start: 0, end: 44 }] }
      );
      expect(multiItemRange).not.toBeNull();
      expect(multiItemRange.toString()).toContain("第一阶段：统一 Evidence 数据层");
      expect(multiItemRange.toString()).toContain("第二阶段：接入流式工作区聊天 🚀");
    });

    test("locates quotes spanning <br> line breaks when newline is present in answerQuote", () => {
      const root = createDomRoot("<p>第一行核心结论<br>第二行补充说明</p>");

      const rangeWithNewline = findUniqueDomTextRange(
        root,
        "第一行核心结论\n第二行补充说明",
        { status: "located", ranges: [{ start: 0, end: 15 }] }
      );
      expect(rangeWithNewline).not.toBeNull();
      expect(rangeWithNewline.toString()).toBe("第一行核心结论第二行补充说明");

      // Without newline in quote, must NOT falsely concatenate across <br>
      const rangeWithoutNewline = findUniqueDomTextRange(
        root,
        "第一行核心结论第二行补充说明",
        { status: "located", ranges: [{ start: 0, end: 14 }] }
      );
      expect(rangeWithoutNewline).toBeNull();
    });
  });

  describe("8. findUniqueDomTextRange - quote spanning multiple inline DOM text nodes", () => {
    test("returns accurate Range spanning across strong, em, code, and anchor tags", () => {
      const root = createDomRoot(
        '<p>前置说明：<span>在 <strong>KnowledgeHub</strong> 中，</span>每条 <em>事实陈述</em> 都会绑定唯一 <code>evidenceId</code> 并支持<a href="https://example.com">溯源预览</a>。</p>'
      );
      const quote =
        "在 KnowledgeHub 中，每条 事实陈述 都会绑定唯一 evidenceId 并支持溯源预览";

      // Note: deliberately pass raw Markdown offsets that differ from DOM offsets
      const range = findUniqueDomTextRange(root, quote, {
        status: "located",
        ranges: [{ start: 99, end: 165 }],
      });

      expect(range).not.toBeNull();
      expect(range.toString()).toBe(quote);
    });
  });

  describe("9. findUniqueDomTextRange - duplicate sentences, not_found, non-located, and block boundary isolation", () => {
    test("returns null when answerLocation.status is ambiguous, not_found, or missing", () => {
      const root = createDomRoot("<p>唯一的一句测试文本。</p>");

      expect(
        findUniqueDomTextRange(root, "唯一的一句测试文本。", {
          status: "ambiguous",
          ranges: [
            { start: 0, end: 10 },
            { start: 20, end: 30 },
          ],
        })
      ).toBeNull();

      expect(
        findUniqueDomTextRange(root, "唯一的一句测试文本。", {
          status: "not_found",
          ranges: [],
        })
      ).toBeNull();

      expect(findUniqueDomTextRange(root, "唯一的一句测试文本。", null)).toBeNull();
      expect(findUniqueDomTextRange(root, "唯一的一句测试文本。", {})).toBeNull();
    });

    test("returns null when the quote appears multiple times in rendered DOM even if answerLocation is located", () => {
      const root = createDomRoot(
        "<div><p>该结论经过验证。</p><p>再次强调：该结论经过验证。</p></div>"
      );

      const range = findUniqueDomTextRange(root, "该结论经过验证。", {
        status: "located",
        ranges: [{ start: 0, end: 8 }],
      });
      expect(range).toBeNull();
    });

    test("does not falsely concatenate unrelated paragraphs or list items into a match", () => {
      const root = createDomRoot(
        "<div><p>第一段末尾文字</p><p>第二段开头文字</p></div>"
      );

      expect(
        findUniqueDomTextRange(root, "末尾文字第二段", {
          status: "located",
          ranges: [{ start: 3, end: 10 }],
        })
      ).toBeNull();

      expect(
        findUniqueDomTextRange(root, "第一段末尾文字 第二段开头文字", {
          status: "located",
          ranges: [{ start: 0, end: 15 }],
        })
      ).toBeNull();
    });
  });

  describe("10. Immutability of inputs, DOM preservation, and crash resistance on malformed inputs", () => {
    test("never mutates deeply frozen input objects or modifies the DOM tree", () => {
      const frozenVerification = deepFreeze({
        status: "partially_supported",
        summary: "不可变测试",
        claims: [
          {
            claim: "陈述一",
            answerQuote: "陈述一",
            answerLocation: { status: "located", ranges: [{ start: 0, end: 3 }] },
            verdict: "supported",
            evidence: [
              {
                evidenceId: "ev-0",
                quote: "证据一",
                origin: "retrieval",
                documentId: "doc-1",
                chunkId: "chunk-1",
                title: "doc.md",
                sourceUri: "https://example.com/doc",
                displayInSources: true,
              },
            ],
          },
        ],
      });

      expect(() => normalizeVerification(frozenVerification)).not.toThrow();

      const frozenEvidence = frozenVerification.claims[0].evidence[0];
      const frozenSources = deepFreeze([
        {
          id: "chunk-1",
          docId: "doc-1",
          title: "doc.md",
          text: "完整证据一文本",
          chunkSource: "https://example.com/doc",
        },
      ]);

      expect(() =>
        buildEvidencePreviewSource(frozenEvidence, frozenSources)
      ).not.toThrow();

      const root = createDomRoot(
        "<p>不可变 DOM 测试：<strong>加粗文本</strong>与普通文本。</p>"
      );
      const htmlBefore = root.innerHTML;
      const childCountBefore = root.childNodes.length;

      const range = findUniqueDomTextRange(
        root,
        "不可变 DOM 测试：加粗文本与普通文本。",
        deepFreeze({ status: "located", ranges: [{ start: 0, end: 21 }] })
      );

      expect(range).not.toBeNull();
      expect(root.innerHTML).toBe(htmlBefore);
      expect(root.childNodes.length).toBe(childCountBefore);
    });

    test("never throws on arbitrary malformed inputs across all three functions", () => {
      const weirdInputs = [
        null,
        undefined,
        false,
        true,
        0,
        NaN,
        "",
        "   ",
        [],
        [null],
        {},
        () => {},
        Symbol("sym"),
      ];

      for (const item of weirdInputs) {
        expect(() => normalizeVerification(item)).not.toThrow();
        expect(() => buildEvidencePreviewSource(item, item)).not.toThrow();
        expect(() => findUniqueDomTextRange(item, item, item)).not.toThrow();
      }
    });
  });
});
