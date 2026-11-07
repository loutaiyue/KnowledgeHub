const { sourceIdentifier } = require("./index");

const EVIDENCE_ORIGINS = Object.freeze([
  "retrieval",
  "pinned",
  "attachment",
  "history",
]);
const VALID_ORIGINS = new Set(EVIDENCE_ORIGINS);
const LEGACY_SOURCE_SYMBOL = Symbol.for("anythingllm.evidence.legacySource");
const CANNONBALL_MARKER = "--prompt truncated for brevity--";

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") return null;
  return value.trim().length > 0 ? value : null;
}

function buildTruncatedPreviewText(pageContent) {
  return `${pageContent.slice(0, 1_000)}...continued on in source document...`;
}

/**
 * Create a single normalized, immutable Evidence record.
 *
 * Invariants:
 * - `origin` must be one of: "retrieval", "pinned", "attachment", "history"
 * - `evidenceId` must be a non-empty request-scoped identifier (never `sourceIdentifier`)
 * - `documentId` and `chunkId` are never fabricated; missing values are `null`
 * - `attachment` items never carry `documentId` or `chunkId`
 * - `pinned` items never carry `chunkId`
 * - `history` items default to `displayInSources: false`
 *
 * @param {Object} params
 * @returns {Object} Frozen evidence item
 */
function createEvidenceItem({
  evidenceId,
  origin,
  documentId = null,
  chunkId = null,
  text,
  title = null,
  sourceUri = null,
  displayInSources,
  legacySource = null,
} = {}) {
  const normalizedId = normalizeNonEmptyString(evidenceId);
  if (!normalizedId) {
    throw new Error("evidenceId must be a non-empty string");
  }
  if (!VALID_ORIGINS.has(origin)) {
    throw new Error(`Invalid evidence origin: ${String(origin)}`);
  }
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Evidence text must be a non-empty string");
  }

  const resolvedDocumentId =
    origin === "attachment" ? null : normalizeNonEmptyString(documentId);
  const resolvedChunkId =
    origin === "pinned" || origin === "attachment"
      ? null
      : normalizeNonEmptyString(chunkId);
  const resolvedTitle = normalizeNonEmptyString(title);
  const resolvedSourceUri = normalizeNonEmptyString(sourceUri);
  const resolvedDisplayInSources =
    typeof displayInSources === "boolean"
      ? displayInSources
      : origin !== "history";

  const item = {
    evidenceId: normalizedId,
    origin,
    documentId: resolvedDocumentId,
    chunkId: resolvedChunkId,
    text,
    title: resolvedTitle,
    sourceUri: resolvedSourceUri,
    displayInSources: resolvedDisplayInSources,
  };

  if (legacySource && typeof legacySource === "object") {
    Object.defineProperty(item, LEGACY_SOURCE_SYMBOL, {
      value: Object.freeze({ ...legacySource }),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  return Object.freeze(item);
}

function resolveDocumentIdFromRecord(
  record,
  lookupMap = null,
  lookupKey = null
) {
  const direct =
    normalizeNonEmptyString(record?.documentId) ??
    normalizeNonEmptyString(record?.docId);
  if (direct) return direct;
  if (lookupMap && lookupKey) {
    if (lookupMap instanceof Map) {
      return normalizeNonEmptyString(lookupMap.get(lookupKey));
    }
    if (typeof lookupMap === "object") {
      return normalizeNonEmptyString(lookupMap[lookupKey]);
    }
  }
  return null;
}

function resolveSourceUri(record) {
  return (
    normalizeNonEmptyString(record?.sourceUri) ??
    normalizeNonEmptyString(record?.chunkSource) ??
    normalizeNonEmptyString(record?.url) ??
    null
  );
}

/**
 * Collect pinned document identifiers for vector search and history backfill filtering.
 *
 * @param {Object[]} pinnedDocs
 * @returns {string[]}
 */
function collectPinnedDocIdentifiers(pinnedDocs = []) {
  if (!Array.isArray(pinnedDocs)) return [];
  const identifiers = [];
  for (const doc of pinnedDocs) {
    if (typeof doc?.pageContent !== "string" || doc.pageContent.length === 0) {
      continue;
    }
    identifiers.push(sourceIdentifier(doc));
  }
  return identifiers;
}

/**
 * Build unified Evidence items in exact RAG context assembly order:
 * 1. Pinned workspace documents ("pinned")
 * 2. Request document attachments ("attachment")
 * 3. Current turn vector retrieval chunks ("retrieval")
 * 4. Historical backfilled chunks ("history")
 *
 * @param {Object} options
 * @param {Object[]} [options.pinnedDocs=[]]
 * @param {Object[]} [options.parsedDocuments=[]]
 * @param {Object[]} [options.retrievalSources=[]]
 * @param {Object[]} [options.historySources=[]]
 * @param {Object|Map|null} [options.documentIdByVectorId=null]
 * @param {Object|Map|null} [options.documentIdByDocpath=null]
 * @returns {Object[]} Frozen array of frozen evidence items
 */
function buildEvidenceItems({
  pinnedDocs = [],
  parsedDocuments = [],
  retrievalSources = [],
  historySources = [],
  documentIdByVectorId = null,
  documentIdByDocpath = null,
} = {}) {
  const evidenceItems = [];
  let nextIndex = 0;
  const allocateId = () => `ev-${nextIndex++}`;

  if (Array.isArray(pinnedDocs)) {
    for (const doc of pinnedDocs) {
      if (typeof doc?.pageContent !== "string" || doc.pageContent.length === 0)
        continue;
      const { pageContent, ...metadata } = doc;
      const documentId = resolveDocumentIdFromRecord(
        doc,
        documentIdByDocpath,
        doc?.docpath
      );
      evidenceItems.push(
        createEvidenceItem({
          evidenceId: allocateId(),
          origin: "pinned",
          documentId,
          chunkId: null,
          text: pageContent,
          title: doc?.title,
          sourceUri: resolveSourceUri(doc),
          displayInSources: true,
          legacySource: {
            text: buildTruncatedPreviewText(pageContent),
            ...metadata,
          },
        })
      );
    }
  }

  if (Array.isArray(parsedDocuments)) {
    for (const doc of parsedDocuments) {
      if (typeof doc?.pageContent !== "string" || doc.pageContent.length === 0)
        continue;
      const { pageContent, ...metadata } = doc;
      evidenceItems.push(
        createEvidenceItem({
          evidenceId: allocateId(),
          origin: "attachment",
          documentId: null,
          chunkId: null,
          text: pageContent,
          title: doc?.title,
          sourceUri: resolveSourceUri(doc),
          displayInSources: true,
          legacySource: {
            text: buildTruncatedPreviewText(pageContent),
            ...metadata,
          },
        })
      );
    }
  }

  if (Array.isArray(retrievalSources)) {
    for (const source of retrievalSources) {
      if (typeof source?.text !== "string" || source.text.length === 0)
        continue;
      const chunkId =
        normalizeNonEmptyString(source?.chunkId) ??
        normalizeNonEmptyString(source?.id);
      const documentId = resolveDocumentIdFromRecord(
        source,
        documentIdByVectorId,
        chunkId
      );
      evidenceItems.push(
        createEvidenceItem({
          evidenceId: allocateId(),
          origin: "retrieval",
          documentId,
          chunkId,
          text: source.text,
          title: source?.title,
          sourceUri: resolveSourceUri(source),
          displayInSources: true,
          legacySource: { ...source },
        })
      );
    }
  }

  if (Array.isArray(historySources)) {
    for (const source of historySources) {
      if (typeof source?.text !== "string" || source.text.length === 0)
        continue;
      const chunkId =
        normalizeNonEmptyString(source?.chunkId) ??
        normalizeNonEmptyString(source?.id);
      const documentId = resolveDocumentIdFromRecord(
        source,
        documentIdByVectorId,
        chunkId
      );
      evidenceItems.push(
        createEvidenceItem({
          evidenceId: allocateId(),
          origin: "history",
          documentId,
          chunkId,
          text: source.text,
          title: source?.title,
          sourceUri: resolveSourceUri(source),
          displayInSources: false,
          legacySource: { ...source },
        })
      );
    }
  }

  return Object.freeze(evidenceItems);
}

/**
 * Derive `contextTexts` from unified `evidenceItems`.
 *
 * @param {Object[]} evidenceItems
 * @returns {string[]}
 */
function deriveContextTexts(evidenceItems = []) {
  if (!Array.isArray(evidenceItems)) return [];
  return evidenceItems.map((item) => item.text);
}

/**
 * Derive backward-compatible `sources` from unified `evidenceItems`.
 * Items with `displayInSources === false` (e.g., history backfill) are excluded.
 *
 * @param {Object[]} evidenceItems
 * @returns {Object[]}
 */
function deriveLegacySources(evidenceItems = []) {
  if (!Array.isArray(evidenceItems)) return [];
  const sources = [];
  for (const item of evidenceItems) {
    if (!item || item.displayInSources !== true) continue;
    const attachedLegacy = item[LEGACY_SOURCE_SYMBOL];
    if (attachedLegacy) {
      sources.push({ ...attachedLegacy });
      continue;
    }

    if (item.origin === "pinned" || item.origin === "attachment") {
      sources.push({
        text: buildTruncatedPreviewText(item.text),
        ...(item.title ? { title: item.title } : {}),
        ...(item.sourceUri ? { chunkSource: item.sourceUri } : {}),
      });
      continue;
    }

    sources.push({
      ...(item.chunkId ? { id: item.chunkId } : {}),
      text: item.text,
      ...(item.title ? { title: item.title } : {}),
      ...(item.sourceUri ? { chunkSource: item.sourceUri } : {}),
    });
  }
  return sources;
}

/**
 * Derive the structured evidence set for answer verification.
 * Each entry binds `evidenceId` to its 0-based `contextIndex` in `contextTexts`.
 *
 * @param {Object[]} evidenceItems
 * @returns {Object[]}
 */
function deriveVerifierEvidence(evidenceItems = []) {
  if (!Array.isArray(evidenceItems)) return [];
  return Object.freeze(
    evidenceItems.map((item, contextIndex) =>
      Object.freeze({
        evidenceId: item.evidenceId,
        contextIndex,
        origin: item.origin,
        documentId: item.documentId,
        chunkId: item.chunkId,
        text: item.text,
        title: item.title,
        sourceUri: item.sourceUri,
        displayInSources: item.displayInSources,
      })
    )
  );
}

/**
 * Derive `contextTexts`, backward-compatible `sources`, and `verifierEvidence`
 * from a single `evidenceItems` list so they never drift out of sync.
 *
 * @param {Object[]} evidenceItems
 * @returns {{
 *   evidenceItems: Object[],
 *   contextTexts: string[],
 *   sources: Object[],
 *   verifierEvidence: Object[]
 * }}
 */
function deriveEvidencePayloads(evidenceItems = []) {
  return {
    evidenceItems,
    contextTexts: deriveContextTexts(evidenceItems),
    sources: deriveLegacySources(evidenceItems),
    verifierEvidence: deriveVerifierEvidence(evidenceItems),
  };
}

/**
 * Split `filledSources.sources` (produced by `fillSourceWindow`) into current-turn
 * retrieval sources and historical backfilled sources, then build and derive all
 * evidence payloads in one unified step.
 *
 * @param {Object} options
 * @param {Object[]} [options.pinnedDocs=[]]
 * @param {Object[]} [options.parsedDocuments=[]]
 * @param {Object[]} [options.retrievalSources=[]]
 * @param {Object} [options.filledSources={ sources: [] }]
 * @param {Object|Map|null} [options.documentIdByVectorId=null]
 * @param {Object|Map|null} [options.documentIdByDocpath=null]
 * @returns {{
 *   evidenceItems: Object[],
 *   contextTexts: string[],
 *   sources: Object[],
 *   verifierEvidence: Object[]
 * }}
 */
function buildAndDeriveEvidence({
  pinnedDocs = [],
  parsedDocuments = [],
  retrievalSources = [],
  filledSources = { sources: [] },
  documentIdByVectorId = null,
  documentIdByDocpath = null,
} = {}) {
  const safeRetrieval = Array.isArray(retrievalSources) ? retrievalSources : [];
  const allWindowSources = Array.isArray(filledSources?.sources)
    ? filledSources.sources
    : safeRetrieval;
  const historySources = allWindowSources.slice(safeRetrieval.length);

  const evidenceItems = buildEvidenceItems({
    pinnedDocs,
    parsedDocuments,
    retrievalSources: safeRetrieval,
    historySources,
    documentIdByVectorId,
    documentIdByDocpath,
  });

  return deriveEvidencePayloads(evidenceItems);
}

function extractContextSection(systemContent) {
  if (typeof systemContent !== "string") return null;
  const exactHeader = "Context:\n[CONTEXT 0]:";
  const exactIdx = systemContent.indexOf(exactHeader);
  if (exactIdx !== -1) {
    return systemContent.slice(exactIdx + "Context:".length);
  }
  const compressedHeader = "\nContext: ";
  const compressedIdx = systemContent.indexOf(compressedHeader);
  if (compressedIdx !== -1) {
    return systemContent.slice(compressedIdx + compressedHeader.length);
  }
  return null;
}

/**
 * Track which `evidenceItems` actually survived `compressMessages` / prompt construction
 * and were sent to the model.
 *
 * Handles:
 * - Uncompressed exact system prompt match (`status: "complete"`, `allPreserved: true`)
 * - Middle-truncation (`cannonball`) of context or system prompt (`status: "partial"` or `"unverified"`)
 * - User-prompt hijacking where `userPromptSize > llm.limits.user` drops the system message (`reason: "system_context_dropped"`)
 * - Providers without a system message at index 0 or non-array prompt formats (`reason: "unsupported_provider_prompt_format"` / `"unsupported_message_format"`)
 *
 * @param {Object} options
 * @param {Object[]} options.evidenceItems
 * @param {string} [options.systemPrompt=""]
 * @param {Object[]} options.generationMessages
 * @param {Object|null} [options.connector=null]
 * @returns {{
 *   status: "complete" | "partial" | "unverified",
 *   reason: string | null,
 *   exactPromptMatch: boolean,
 *   allEvidencePreserved: boolean,
 *   allPreserved: boolean,
 *   preservedEvidence: Object[],
 *   droppedOrTruncatedIds: string[]
 * }}
 */
function trackContextEvidence({
  evidenceItems = [],
  systemPrompt = "",
  generationMessages = [],
  connector = null,
} = {}) {
  const items = Array.isArray(evidenceItems) ? evidenceItems : [];
  if (items.length === 0) {
    return {
      status: "complete",
      reason: null,
      exactPromptMatch: true,
      allEvidencePreserved: true,
      allPreserved: true,
      preservedEvidence: [],
      droppedOrTruncatedIds: [],
    };
  }

  const allIds = items.map((item) => item.evidenceId);
  if (!Array.isArray(generationMessages) || generationMessages.length === 0) {
    return {
      status: "unverified",
      reason: "unsupported_message_format",
      exactPromptMatch: false,
      allEvidencePreserved: false,
      allPreserved: false,
      preservedEvidence: [],
      droppedOrTruncatedIds: allIds,
    };
  }

  const hasConnectorConstruct =
    typeof connector?.constructPrompt === "function";
  let expectedMessages = null;
  if (hasConnectorConstruct && typeof systemPrompt === "string") {
    try {
      expectedMessages = connector.constructPrompt({
        systemPrompt,
        contextTexts: items.map((item) => item.text),
      });
    } catch {
      expectedMessages = null;
    }
  }

  const firstMessage = generationMessages[0];
  if (
    !firstMessage ||
    firstMessage.role !== "system" ||
    typeof firstMessage.content !== "string"
  ) {
    const hasAnySystemMessage = generationMessages.some(
      (msg) => msg?.role === "system"
    );
    const expectedHadSystem =
      Array.isArray(expectedMessages) && expectedMessages[0]?.role === "system";
    const reason =
      !hasAnySystemMessage &&
      (expectedHadSystem ||
        generationMessages.every((msg) => msg?.role === "user"))
        ? "system_context_dropped"
        : "unsupported_provider_prompt_format";

    return {
      status: "unverified",
      reason,
      exactPromptMatch: false,
      allEvidencePreserved: false,
      allPreserved: false,
      preservedEvidence: [],
      droppedOrTruncatedIds: allIds,
    };
  }

  const exactPromptMatch =
    Array.isArray(expectedMessages) &&
    expectedMessages[0]?.role === "system" &&
    typeof expectedMessages[0]?.content === "string" &&
    firstMessage.content === expectedMessages[0].content;

  if (exactPromptMatch) {
    return {
      status: "complete",
      reason: null,
      exactPromptMatch: true,
      allEvidencePreserved: true,
      allPreserved: true,
      preservedEvidence: [...items],
      droppedOrTruncatedIds: [],
    };
  }

  const contextSection = extractContextSection(firstMessage.content);
  if (contextSection === null) {
    return {
      status: "unverified",
      reason: "unrecognized_context_format",
      exactPromptMatch: false,
      allEvidencePreserved: false,
      allPreserved: false,
      preservedEvidence: [],
      droppedOrTruncatedIds: allIds,
    };
  }

  const preservedEvidence = [];
  const droppedOrTruncatedIds = [];
  let searchOffset = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const startMarker = `[CONTEXT ${i}]:\n`;
    const endMarker = `\n[END CONTEXT ${i}]`;
    const startIdx = contextSection.indexOf(startMarker, searchOffset);
    if (startIdx === -1) {
      droppedOrTruncatedIds.push(item.evidenceId);
      continue;
    }

    const contentStart = startIdx + startMarker.length;
    const endIdx = contextSection.indexOf(endMarker, contentStart);
    if (endIdx === -1) {
      droppedOrTruncatedIds.push(item.evidenceId);
      continue;
    }

    const extractedText = contextSection.slice(contentStart, endIdx);
    const hasInjectedTruncation =
      extractedText.includes(CANNONBALL_MARKER) &&
      !item.text.includes(CANNONBALL_MARKER);

    if (extractedText === item.text && !hasInjectedTruncation) {
      preservedEvidence.push(item);
      searchOffset = endIdx + endMarker.length;
    } else {
      droppedOrTruncatedIds.push(item.evidenceId);
    }
  }

  const allEvidencePreserved =
    preservedEvidence.length === items.length &&
    droppedOrTruncatedIds.length === 0;
  const allPreserved = hasConnectorConstruct
    ? exactPromptMatch && allEvidencePreserved
    : allEvidencePreserved;

  if (allPreserved) {
    return {
      status: "complete",
      reason: null,
      exactPromptMatch,
      allEvidencePreserved: true,
      allPreserved: true,
      preservedEvidence,
      droppedOrTruncatedIds: [],
    };
  }

  if (preservedEvidence.length > 0) {
    return {
      status: "partial",
      reason: allEvidencePreserved
        ? "system_prompt_compressed"
        : "context_truncated",
      exactPromptMatch: false,
      allEvidencePreserved,
      allPreserved: false,
      preservedEvidence,
      droppedOrTruncatedIds,
    };
  }

  return {
    status: "unverified",
    reason: "context_truncated",
    exactPromptMatch: false,
    allEvidencePreserved: false,
    allPreserved: false,
    preservedEvidence: [],
    droppedOrTruncatedIds: allIds,
  };
}

/**
 * Guard helper that explicitly rejects unconfirmed evidence for answer verification.
 * By default (`requireComplete = true`), any compression or loss of context fails closed
 * with `"evaluation_context_not_preserved"`.
 *
 * @param {Object} options
 * @param {Object[]} options.evidenceItems
 * @param {string} [options.systemPrompt=""]
 * @param {Object[]} options.generationMessages
 * @param {Object|null} [options.connector=null]
 * @param {boolean} [options.requireComplete=true]
 * @returns {{
 *   ok: boolean,
 *   errorCode: string | null,
 *   evidenceItems: Object[],
 *   contextTexts: string[],
 *   verifierEvidence: Object[],
 *   tracking: Object
 * }}
 */
function resolveVerifiableEvidence({
  evidenceItems = [],
  systemPrompt = "",
  generationMessages = [],
  connector = null,
  requireComplete = true,
} = {}) {
  const tracking = trackContextEvidence({
    evidenceItems,
    systemPrompt,
    generationMessages,
    connector,
  });

  const canProceed = requireComplete
    ? tracking.allPreserved
    : tracking.preservedEvidence.length > 0 || evidenceItems.length === 0;

  if (!canProceed) {
    return {
      ok: false,
      errorCode: "evaluation_context_not_preserved",
      evidenceItems: [],
      contextTexts: [],
      verifierEvidence: [],
      tracking,
    };
  }

  const confirmedItems = tracking.preservedEvidence;
  return {
    ok: true,
    errorCode: null,
    evidenceItems: confirmedItems,
    contextTexts: deriveContextTexts(confirmedItems),
    verifierEvidence: deriveVerifierEvidence(confirmedItems),
    tracking,
  };
}

module.exports = {
  EVIDENCE_ORIGINS,
  LEGACY_SOURCE_SYMBOL,
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
};
