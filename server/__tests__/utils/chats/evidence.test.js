/* eslint-env jest, node */

const {
  EVIDENCE_ORIGINS,
  createEvidenceItem,
  collectPinnedDocIdentifiers,
  buildEvidenceItems,
  deriveContextTexts,
  deriveLegacySources,
  deriveVerifierEvidence,
  deriveEvidencePayloads,
  buildAndDeriveEvidence,
  trackContextEvidence,
  resolveVerifiableEvidence,
} = require("../../../utils/chats/evidence");
const { sourceIdentifier } = require("../../../utils/chats/index");
const { fillSourceWindow } = require("../../../utils/helpers/chat");

describe("Unified Evidence Data Layer", () => {
  describe("createEvidenceItem & origin invariants", () => {
    test("only allows retrieval, pinned, attachment, and history origins", () => {
      expect(EVIDENCE_ORIGINS).toEqual([
        "retrieval",
        "pinned",
        "attachment",
        "history",
      ]);

      expect(() =>
        createEvidenceItem({
          evidenceId: "ev-0",
          origin: "unknown_origin",
          text: "Some text",
        })
      ).toThrow(/Invalid evidence origin/);

      expect(() =>
        createEvidenceItem({
          evidenceId: "",
          origin: "retrieval",
          text: "Some text",
        })
      ).toThrow(/evidenceId must be a non-empty string/);

      expect(() =>
        createEvidenceItem({
          evidenceId: "ev-0",
          origin: "retrieval",
          text: "",
        })
      ).toThrow(/Evidence text must be a non-empty string/);
    });

    test("retrieval evidence preserves documentId, chunkId, full text, metadata, and displayInSources=true", () => {
      const item = createEvidenceItem({
        evidenceId: "ev-0",
        origin: "retrieval",
        documentId: "ws-doc-101",
        chunkId: "vec-chunk-1",
        text: "<document_metadata>\nsourceDocument: spec.pdf\n</document_metadata>\n\nFull chunk body.",
        title: "spec.pdf",
        sourceUri: "file:///tmp/spec.pdf",
      });

      expect(item).toEqual({
        evidenceId: "ev-0",
        origin: "retrieval",
        documentId: "ws-doc-101",
        chunkId: "vec-chunk-1",
        text: "<document_metadata>\nsourceDocument: spec.pdf\n</document_metadata>\n\nFull chunk body.",
        title: "spec.pdf",
        sourceUri: "file:///tmp/spec.pdf",
        displayInSources: true,
      });
      expect(Object.isFrozen(item)).toBe(true);
    });

    test("pinned evidence forces chunkId to null and defaults displayInSources to true", () => {
      const item = createEvidenceItem({
        evidenceId: "ev-1",
        origin: "pinned",
        documentId: "ws-doc-pinned-1",
        chunkId: "should-not-exist-on-pinned",
        text: "Full pinned document content",
        title: "handbook.md",
        sourceUri: "file:///tmp/handbook.md",
      });

      expect(item).toEqual({
        evidenceId: "ev-1",
        origin: "pinned",
        documentId: "ws-doc-pinned-1",
        chunkId: null,
        text: "Full pinned document content",
        title: "handbook.md",
        sourceUri: "file:///tmp/handbook.md",
        displayInSources: true,
      });
    });

    test("attachment evidence never pretends to be an embedded workspace document (documentId=null, chunkId=null)", () => {
      const item = createEvidenceItem({
        evidenceId: "ev-2",
        origin: "attachment",
        documentId: "fake-workspace-doc-id",
        chunkId: "fake-chunk-id",
        text: "Uploaded attachment text",
        title: "upload.pdf",
        sourceUri: null,
      });

      expect(item).toEqual({
        evidenceId: "ev-2",
        origin: "attachment",
        documentId: null,
        chunkId: null,
        text: "Uploaded attachment text",
        title: "upload.pdf",
        sourceUri: null,
        displayInSources: true,
      });
    });

    test("history evidence retains provenance but defaults displayInSources to false", () => {
      const item = createEvidenceItem({
        evidenceId: "ev-3",
        origin: "history",
        documentId: "ws-doc-hist-9",
        chunkId: "hist-chunk-9",
        text: "Historical backfilled chunk text",
        title: "q3-report.pdf",
        sourceUri: "file:///tmp/q3-report.pdf",
      });

      expect(item).toEqual({
        evidenceId: "ev-3",
        origin: "history",
        documentId: "ws-doc-hist-9",
        chunkId: "hist-chunk-9",
        text: "Historical backfilled chunk text",
        title: "q3-report.pdf",
        sourceUri: "file:///tmp/q3-report.pdf",
        displayInSources: false,
      });
    });

    test("missing documentId and chunkId normalize to null without fabricating IDs", () => {
      const item = createEvidenceItem({
        evidenceId: "ev-4",
        origin: "retrieval",
        documentId: "   ",
        chunkId: undefined,
        text: "Orphan vector chunk",
        title: "",
        sourceUri: null,
      });

      expect(item.documentId).toBeNull();
      expect(item.chunkId).toBeNull();
      expect(item.title).toBeNull();
      expect(item.sourceUri).toBeNull();
    });
  });

  describe("buildEvidenceItems & unified derivation", () => {
    const longPinnedBody = "P".repeat(1_500);
    const longAttachmentBody = "A".repeat(1_250);

    const pinnedDocs = [
      {
        id: "collector-json-uuid-1",
        docId: "ws-doc-pinned-1",
        docpath: "custom-documents/pinned.json",
        title: "pinned.pdf",
        url: "file:///docs/pinned.pdf",
        published: "2026-01-01",
        pageContent: longPinnedBody,
      },
    ];

    const parsedDocuments = [
      {
        id: "temp-collector-attachment-id",
        docId: "should-be-ignored-for-attachment",
        title: "attached.txt",
        chunkSource: "attachment://attached.txt",
        published: "2026-02-01",
        pageContent: longAttachmentBody,
      },
    ];

    const retrievalSources = [
      {
        id: "vec-101",
        title: "retrieved.pdf",
        chunkSource: "lancedb://retrieved.pdf",
        text: "Retrieved chunk text 101.",
        score: 0.91,
      },
    ];

    const historySources = [
      {
        id: "vec-hist-202",
        title: "history-doc.pdf",
        url: "file:///docs/history-doc.pdf",
        text: "Backfilled history chunk text 202.",
        score: 0.84,
      },
    ];

    test("builds all 4 origins in order with unique request-scoped evidenceIds independent of sourceIdentifier", () => {
      const items = buildEvidenceItems({
        pinnedDocs,
        parsedDocuments,
        retrievalSources,
        historySources,
        documentIdByVectorId: {
          "vec-101": "ws-doc-ret-101",
          "vec-hist-202": "ws-doc-hist-202",
        },
      });

      expect(items).toHaveLength(4);
      expect(items.map((i) => i.evidenceId)).toEqual([
        "ev-0",
        "ev-1",
        "ev-2",
        "ev-3",
      ]);
      expect(items.map((i) => i.origin)).toEqual([
        "pinned",
        "attachment",
        "retrieval",
        "history",
      ]);

      // Verify evidenceId never equals sourceIdentifier
      for (const item of items) {
        expect(item.evidenceId).not.toContain("title:");
        expect(item.evidenceId).not.toBe(
          sourceIdentifier({ title: item.title, published: "2026-01-01" })
        );
      }

      // 1. Pinned
      expect(items[0]).toEqual({
        evidenceId: "ev-0",
        origin: "pinned",
        documentId: "ws-doc-pinned-1",
        chunkId: null,
        text: longPinnedBody,
        title: "pinned.pdf",
        sourceUri: "file:///docs/pinned.pdf",
        displayInSources: true,
      });

      // 2. Attachment (must NOT carry documentId or chunkId even though id/docId existed on input)
      expect(items[1]).toEqual({
        evidenceId: "ev-1",
        origin: "attachment",
        documentId: null,
        chunkId: null,
        text: longAttachmentBody,
        title: "attached.txt",
        sourceUri: "attachment://attached.txt",
        displayInSources: true,
      });

      // 3. Retrieval
      expect(items[2]).toEqual({
        evidenceId: "ev-2",
        origin: "retrieval",
        documentId: "ws-doc-ret-101",
        chunkId: "vec-101",
        text: "Retrieved chunk text 101.",
        title: "retrieved.pdf",
        sourceUri: "lancedb://retrieved.pdf",
        displayInSources: true,
      });

      // 4. History
      expect(items[3]).toEqual({
        evidenceId: "ev-3",
        origin: "history",
        documentId: "ws-doc-hist-202",
        chunkId: "vec-hist-202",
        text: "Backfilled history chunk text 202.",
        title: "history-doc.pdf",
        sourceUri: "file:///docs/history-doc.pdf",
        displayInSources: false,
      });
    });

    test("derives contextTexts, legacy sources, and verifierEvidence consistently from evidenceItems", () => {
      const items = buildEvidenceItems({
        pinnedDocs,
        parsedDocuments,
        retrievalSources,
        historySources,
      });
      const { contextTexts, sources, verifierEvidence } =
        deriveEvidencePayloads(items);

      // contextTexts includes all 4 items with FULL untruncated text
      expect(contextTexts).toEqual([
        longPinnedBody,
        longAttachmentBody,
        "Retrieved chunk text 101.",
        "Backfilled history chunk text 202.",
      ]);

      // sources includes ONLY displayInSources=true (pinned, attachment, retrieval) and excludes history
      expect(sources).toHaveLength(3);
      expect(sources[0]).toEqual({
        text: `${longPinnedBody.slice(0, 1_000)}...continued on in source document...`,
        id: "collector-json-uuid-1",
        docId: "ws-doc-pinned-1",
        docpath: "custom-documents/pinned.json",
        title: "pinned.pdf",
        url: "file:///docs/pinned.pdf",
        published: "2026-01-01",
      });
      expect(sources[1]).toEqual({
        text: `${longAttachmentBody.slice(0, 1_000)}...continued on in source document...`,
        id: "temp-collector-attachment-id",
        docId: "should-be-ignored-for-attachment",
        title: "attached.txt",
        chunkSource: "attachment://attached.txt",
        published: "2026-02-01",
      });
      expect(sources[2]).toEqual(retrievalSources[0]);

      // verifierEvidence binds each item to its exact contextIndex (including history at index 3)
      expect(verifierEvidence).toHaveLength(4);
      expect(verifierEvidence.map((v) => v.contextIndex)).toEqual([0, 1, 2, 3]);
      expect(verifierEvidence.map((v) => v.evidenceId)).toEqual([
        "ev-0",
        "ev-1",
        "ev-2",
        "ev-3",
      ]);
      expect(verifierEvidence[3].origin).toBe("history");
      expect(verifierEvidence[3].displayInSources).toBe(false);
    });

    test("does not fabricate documentId or chunkId when missing on pinned, retrieval, or history records", () => {
      const items = buildEvidenceItems({
        pinnedDocs: [
          {
            id: "collector-only-id",
            title: "no-workspace-docid.pdf",
            pageContent: "Pinned text without workspace docId",
          },
        ],
        retrievalSources: [
          {
            title: "chunk-without-ids.pdf",
            text: "Retrieved text without id or docId",
          },
        ],
        historySources: [
          {
            title: "history-without-ids.pdf",
            text: "History text without id or docId",
          },
        ],
      });

      expect(items).toHaveLength(3);
      // Collector's `id` on pinned doc JSON is not a workspace docId and must not be fabricated
      expect(items[0].documentId).toBeNull();
      expect(items[0].chunkId).toBeNull();

      expect(items[1].documentId).toBeNull();
      expect(items[1].chunkId).toBeNull();

      expect(items[2].documentId).toBeNull();
      expect(items[2].chunkId).toBeNull();
    });

    test("assigns distinct evidenceIds when duplicate texts appear across or within origins", () => {
      const duplicateText = "Exact same boilerplate clause.";
      const items = buildEvidenceItems({
        pinnedDocs: [{ title: "docA.txt", pageContent: duplicateText }],
        parsedDocuments: [{ title: "docA-copy.txt", pageContent: duplicateText }],
        retrievalSources: [
          { id: "chunk-a", title: "docA.txt", text: duplicateText },
          { id: "chunk-b", title: "docB.txt", text: duplicateText },
        ],
        historySources: [
          { id: "chunk-c", title: "docC.txt", text: duplicateText },
        ],
      });

      expect(items).toHaveLength(5);
      const ids = items.map((item) => item.evidenceId);
      expect(new Set(ids).size).toBe(5);
      expect(ids).toEqual(["ev-0", "ev-1", "ev-2", "ev-3", "ev-4"]);
      expect(deriveContextTexts(items)).toEqual([
        duplicateText,
        duplicateText,
        duplicateText,
        duplicateText,
        duplicateText,
      ]);
    });

    test("buildAndDeriveEvidence integrates with fillSourceWindow to separate retrieval from history backfill", () => {
      const pinned = [
        {
          title: "Pinned Guide",
          published: "2026-01-01",
          pageContent: "Pinned guide text.",
        },
      ];
      const filterIdentifiers = collectPinnedDocIdentifiers(pinned);
      const currentRetrieval = [
        {
          id: "ret-1",
          title: "Current Doc",
          published: "2026-03-01",
          text: "Current turn search result.",
          score: 0.95,
        },
      ];
      const rawHistory = [
        {
          prompt: "Previous question",
          response: JSON.stringify({
            text: "Previous answer",
            sources: [
              {
                id: "hist-1",
                title: "Past Doc",
                published: "2026-02-01",
                text: "Backfilled chunk from history.",
                score: 0.88,
              },
            ],
          }),
        },
      ];

      const filledSources = fillSourceWindow({
        nDocs: 4,
        searchResults: currentRetrieval,
        history: rawHistory,
        filterIdentifiers,
      });

      const { evidenceItems, contextTexts, sources } = buildAndDeriveEvidence({
        pinnedDocs: pinned,
        parsedDocuments: [],
        retrievalSources: currentRetrieval,
        filledSources,
      });

      expect(evidenceItems).toHaveLength(3);
      expect(evidenceItems.map((e) => ({ id: e.evidenceId, origin: e.origin, display: e.displayInSources }))).toEqual([
        { id: "ev-0", origin: "pinned", display: true },
        { id: "ev-1", origin: "retrieval", display: true },
        { id: "ev-2", origin: "history", display: false },
      ]);

      expect(contextTexts).toEqual([
        "Pinned guide text.",
        "Current turn search result.",
        "Backfilled chunk from history.",
      ]);

      // History source is excluded from sources, while pinned + retrieval are preserved
      expect(sources).toEqual([
        {
          text: "Pinned guide text....continued on in source document...",
          title: "Pinned Guide",
          published: "2026-01-01",
        },
        currentRetrieval[0],
      ]);
    });
  });

  describe("Actual Context Tracking (trackContextEvidence & resolveVerifiableEvidence)", () => {
    function buildStandardSystemPrompt(systemPrompt, contextTexts) {
      if (!contextTexts.length) return systemPrompt;
      const contextBlock = contextTexts
        .map((text, i) => `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`)
        .join("");
      return `${systemPrompt}\nContext:\n${contextBlock}`;
    }

    const standardConnector = {
      constructPrompt: ({ systemPrompt, contextTexts = [] }) => [
        {
          role: "system",
          content: buildStandardSystemPrompt(systemPrompt, contextTexts),
        },
      ],
    };

    const sampleItems = buildEvidenceItems({
      pinnedDocs: [{ title: "pin.md", pageContent: "Pinned evidence 0." }],
      retrievalSources: [
        { id: "c1", title: "r1.md", text: "Retrieval evidence 1." },
        { id: "c2", title: "r2.md", text: "Retrieval evidence 2." },
        { id: "c3", title: "r3.md", text: "Retrieval evidence 3." },
      ],
    });

    test("confirms all evidence items when uncompressed system prompt matches connector output", () => {
      const systemPrompt = "You are a helpful assistant.";
      const contextTexts = deriveContextTexts(sampleItems);
      const generationMessages = [
        ...standardConnector.constructPrompt({ systemPrompt, contextTexts }),
        { role: "user", content: "What is the evidence?" },
      ];

      const tracking = trackContextEvidence({
        evidenceItems: sampleItems,
        systemPrompt,
        generationMessages,
        connector: standardConnector,
      });

      expect(tracking).toEqual({
        status: "complete",
        reason: null,
        exactPromptMatch: true,
        allEvidencePreserved: true,
        allPreserved: true,
        preservedEvidence: sampleItems,
        droppedOrTruncatedIds: [],
      });

      const verifiable = resolveVerifiableEvidence({
        evidenceItems: sampleItems,
        systemPrompt,
        generationMessages,
        connector: standardConnector,
      });
      expect(verifiable.ok).toBe(true);
      expect(verifiable.errorCode).toBeNull();
      expect(verifiable.evidenceItems).toEqual(sampleItems);
      expect(verifiable.contextTexts).toEqual(contextTexts);
    });

    test("identifies surviving vs truncated evidence when cannonball middle-truncates the context block", () => {
      const systemPrompt = "You are a helpful assistant.";
      // Simulate messageArrayCompressor + cannonball cutting through CONTEXT 1 and CONTEXT 2
      // while leaving CONTEXT 0 and CONTEXT 3 intact:
      const cannonballedContext =
        "\n[CONTEXT 0]:\nPinned evidence 0.\n[END CONTEXT 0]\n\n" +
        "[CONTEXT 1]:\nRetrieval evi" +
        "\n\n--prompt truncated for brevity--\n\n" +
        "ence 2.\n[END CONTEXT 2]\n\n" +
        "[CONTEXT 3]:\nRetrieval evidence 3.\n[END CONTEXT 3]\n\n";

      const generationMessages = [
        {
          role: "system",
          content: `${systemPrompt}\nContext: ${cannonballedContext}`,
        },
        { role: "user", content: "Question" },
      ];

      const tracking = trackContextEvidence({
        evidenceItems: sampleItems,
        systemPrompt,
        generationMessages,
        connector: standardConnector,
      });

      expect(tracking.status).toBe("partial");
      expect(tracking.reason).toBe("context_truncated");
      expect(tracking.exactPromptMatch).toBe(false);
      expect(tracking.allEvidencePreserved).toBe(false);
      expect(tracking.allPreserved).toBe(false);
      expect(tracking.preservedEvidence.map((e) => e.evidenceId)).toEqual([
        "ev-0",
        "ev-3",
      ]);
      expect(tracking.droppedOrTruncatedIds).toEqual(["ev-1", "ev-2"]);

      // Strict verification refuses partial/truncated context by default
      const strictVerifiable = resolveVerifiableEvidence({
        evidenceItems: sampleItems,
        systemPrompt,
        generationMessages,
        connector: standardConnector,
        requireComplete: true,
      });
      expect(strictVerifiable.ok).toBe(false);
      expect(strictVerifiable.errorCode).toBe(
        "evaluation_context_not_preserved"
      );
      expect(strictVerifiable.evidenceItems).toEqual([]);

      // Non-strict mode returns ONLY the confirmed surviving evidence items (ev-0, ev-3), never unconfirmed ones
      const partialVerifiable = resolveVerifiableEvidence({
        evidenceItems: sampleItems,
        systemPrompt,
        generationMessages,
        connector: standardConnector,
        requireComplete: false,
      });
      expect(partialVerifiable.ok).toBe(true);
      expect(partialVerifiable.evidenceItems.map((e) => e.evidenceId)).toEqual([
        "ev-0",
        "ev-3",
      ]);
      expect(partialVerifiable.contextTexts).toEqual([
        "Pinned evidence 0.",
        "Retrieval evidence 3.",
      ]);
    });

    test("tracks duplicate texts accurately by [CONTEXT i] position when one copy is truncated", () => {
      const dupItems = buildEvidenceItems({
        retrievalSources: [
          { id: "c-0", text: "Repeated fact." },
          { id: "c-1", text: "Repeated fact." },
        ],
      });
      const systemPrompt = "System prompt";
      // Suppose CONTEXT 0 is intact, but CONTEXT 1 was truncated in the middle
      const generationMessages = [
        {
          role: "system",
          content:
            `${systemPrompt}\nContext: \n` +
            `[CONTEXT 0]:\nRepeated fact.\n[END CONTEXT 0]\n\n` +
            `[CONTEXT 1]:\nRepeat\n\n--prompt truncated for brevity--\n\n[END CONTEXT 1]\n\n`,
        },
        { role: "user", content: "Ask" },
      ];

      const tracking = trackContextEvidence({
        evidenceItems: dupItems,
        systemPrompt,
        generationMessages,
        connector: standardConnector,
      });

      expect(tracking.status).toBe("partial");
      expect(tracking.preservedEvidence.map((e) => e.evidenceId)).toEqual([
        "ev-0",
      ]);
      expect(tracking.droppedOrTruncatedIds).toEqual(["ev-1"]);
    });

    test("rejects all evidence when user prompt hijacks the window and drops the system message", () => {
      const generationMessages = [
        {
          role: "user",
          content: "Oversized user prompt\n\n--prompt truncated for brevity--\n\ntail",
        },
      ];

      const tracking = trackContextEvidence({
        evidenceItems: sampleItems,
        systemPrompt: "System instructions",
        generationMessages,
        connector: standardConnector,
      });

      expect(tracking).toEqual({
        status: "unverified",
        reason: "system_context_dropped",
        exactPromptMatch: false,
        allEvidencePreserved: false,
        allPreserved: false,
        preservedEvidence: [],
        droppedOrTruncatedIds: ["ev-0", "ev-1", "ev-2", "ev-3"],
      });

      const verifiable = resolveVerifiableEvidence({
        evidenceItems: sampleItems,
        systemPrompt: "System instructions",
        generationMessages,
        connector: standardConnector,
        requireComplete: false,
      });
      expect(verifiable.ok).toBe(false);
      expect(verifiable.errorCode).toBe("evaluation_context_not_preserved");
    });

    test("rejects verification when provider does not use a system role message or returns a raw string", () => {
      const noSystemProviderConnector = {
        constructPrompt: ({ systemPrompt }) => [
          { role: "user", content: systemPrompt },
          { role: "assistant", content: "Okay." },
        ],
      };
      const generationMessages = [
        { role: "user", content: "Emulated system prompt in user turn" },
        { role: "assistant", content: "Okay." },
        { role: "user", content: "Question" },
      ];

      const tracking = trackContextEvidence({
        evidenceItems: sampleItems,
        systemPrompt: "Instructions",
        generationMessages,
        connector: noSystemProviderConnector,
      });

      expect(tracking.status).toBe("unverified");
      expect(tracking.reason).toBe("unsupported_provider_prompt_format");
      expect(tracking.allPreserved).toBe(false);
      expect(tracking.preservedEvidence).toEqual([]);

      const stringTracking = trackContextEvidence({
        evidenceItems: sampleItems,
        systemPrompt: "Instructions",
        generationMessages: "Raw string prompt from string compressor",
        connector: standardConnector,
      });
      expect(stringTracking.status).toBe("unverified");
      expect(stringTracking.reason).toBe("unsupported_message_format");
      expect(stringTracking.allPreserved).toBe(false);
    });
  });
});
