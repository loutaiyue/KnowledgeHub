const VALID_VERIFICATION_STATUSES = new Set([
  "supported",
  "partially_supported",
  "unsupported",
  "skipped",
  "verification_error",
]);

const VALID_CLAIM_VERDICTS = new Set(["supported", "unsupported", "uncertain"]);

const VALID_EVIDENCE_ORIGINS = new Set([
  "retrieval",
  "pinned",
  "attachment",
  "history",
]);

const VALID_LOCATION_STATUSES = new Set(["located", "ambiguous", "not_found"]);

const DEFAULT_VERIFICATION_SCOPE = "model_extracted_claims_only";

const BLOCK_ELEMENT_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

const IGNORED_ELEMENT_TAGS = new Set([
  "BUTTON",
  "NOSCRIPT",
  "SCRIPT",
  "STYLE",
  "SVG",
  "TEMPLATE",
]);

const INTER_ELEMENT_WHITESPACE_CONTAINERS = new Set([
  "OL",
  "TABLE",
  "TBODY",
  "TFOOT",
  "THEAD",
  "TR",
  "UL",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validate and return only safe external HTTP/HTTPS URLs.
 * Rejects file://, lancedb://, javascript:, data:, relative paths, etc.
 *
 * @param {unknown} rawUri
 * @returns {string|null}
 */
export function sanitizeHttpUrl(rawUri) {
  const candidate = normalizeNonEmptyString(rawUri);
  if (!candidate) return null;
  if (!/^https?:\/\//i.test(candidate)) return null;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (!parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeAnswerLocation(rawLocation, answerQuote) {
  const hasQuote =
    typeof answerQuote === "string" && answerQuote.trim().length > 0;

  if (!isPlainObject(rawLocation)) {
    return { status: "not_found", ranges: [] };
  }

  const rawStatus = rawLocation.status;
  if (!VALID_LOCATION_STATUSES.has(rawStatus) || !hasQuote) {
    return { status: "not_found", ranges: [] };
  }

  const validRanges = Array.isArray(rawLocation.ranges)
    ? rawLocation.ranges
        .filter(
          (range) =>
            isPlainObject(range) &&
            Number.isInteger(range.start) &&
            Number.isInteger(range.end) &&
            range.start >= 0 &&
            range.end > range.start
        )
        .map((range) => ({ start: range.start, end: range.end }))
    : [];

  if (rawStatus === "not_found") {
    return { status: "not_found", ranges: [] };
  }

  if (rawStatus === "located") {
    if (validRanges.length === 1) {
      return { status: "located", ranges: validRanges };
    }
    if (validRanges.length > 1) {
      return { status: "ambiguous", ranges: validRanges };
    }
    return { status: "not_found", ranges: [] };
  }

  // rawStatus === "ambiguous"
  if (validRanges.length === 0) {
    return { status: "not_found", ranges: [] };
  }
  return { status: "ambiguous", ranges: validRanges };
}

function normalizeEvidenceItem(rawEvidence) {
  if (!isPlainObject(rawEvidence)) return null;

  const evidenceId = normalizeNonEmptyString(rawEvidence.evidenceId);
  const quote =
    typeof rawEvidence.quote === "string" && rawEvidence.quote.trim().length > 0
      ? rawEvidence.quote
      : null;

  if (!evidenceId || !quote) return null;

  const rawOrigin = normalizeNonEmptyString(rawEvidence.origin);
  const origin = VALID_EVIDENCE_ORIGINS.has(rawOrigin)
    ? rawOrigin
    : rawEvidence.displayInSources === false
      ? "history"
      : "retrieval";

  const isHistory =
    origin === "history" || rawEvidence.displayInSources === false;
  const displayInSources = isHistory
    ? false
    : typeof rawEvidence.displayInSources === "boolean"
      ? rawEvidence.displayInSources
      : true;

  const documentId =
    origin === "attachment"
      ? null
      : normalizeNonEmptyString(rawEvidence.documentId);
  const chunkId = normalizeNonEmptyString(rawEvidence.chunkId);
  const title = normalizeNonEmptyString(rawEvidence.title);
  const sourceUri = sanitizeHttpUrl(rawEvidence.sourceUri);

  return {
    evidenceId,
    quote,
    origin,
    documentId,
    chunkId,
    title,
    sourceUri,
    displayInSources,
  };
}

function normalizeClaimItem(rawClaim) {
  if (!isPlainObject(rawClaim)) return null;

  const claimText = normalizeNonEmptyString(rawClaim.claim);
  if (!claimText) return null;

  const answerQuote =
    typeof rawClaim.answerQuote === "string" ? rawClaim.answerQuote : "";
  const answerLocation = normalizeAnswerLocation(
    rawClaim.answerLocation,
    answerQuote
  );

  const rawVerdict = normalizeNonEmptyString(rawClaim.verdict);
  let verdict = VALID_CLAIM_VERDICTS.has(rawVerdict) ? rawVerdict : "uncertain";

  const normalizedEvidence = Array.isArray(rawClaim.evidence)
    ? rawClaim.evidence.map(normalizeEvidenceItem).filter(Boolean)
    : [];

  // Never allow a claim to remain "supported" without at least one valid evidence quote
  if (verdict === "supported" && normalizedEvidence.length === 0) {
    verdict = "unsupported";
  }

  const evidence = verdict === "unsupported" ? [] : normalizedEvidence;
  const reason = normalizeNonEmptyString(rawClaim.reason);

  return {
    claim: claimText,
    answerQuote,
    answerLocation,
    verdict,
    evidence,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Defensively normalize a verification payload from SSE or chat history.
 * Never mutates the input object and never throws.
 *
 * @param {unknown} verification
 * @returns {{
 *   isValid: boolean,
 *   status: "supported" | "partially_supported" | "unsupported" | "skipped" | "verification_error",
 *   verificationScope: string,
 *   summary: string,
 *   claims: Array<{
 *     claim: string,
 *     answerQuote: string,
 *     answerLocation: { status: "located" | "ambiguous" | "not_found", ranges: Array<{ start: number, end: number }> },
 *     verdict: "supported" | "unsupported" | "uncertain",
 *     evidence: Array<{
 *       evidenceId: string,
 *       quote: string,
 *       origin: "retrieval" | "pinned" | "attachment" | "history",
 *       documentId: string | null,
 *       chunkId: string | null,
 *       title: string | null,
 *       sourceUri: string | null,
 *       displayInSources: boolean
 *     }>,
 *     reason?: string
 *   }>,
 *   reason: string | null,
 *   skipReason: string | null,
 *   error: { code: string } | null
 * }}
 */
export function normalizeVerification(verification) {
  if (!isPlainObject(verification)) {
    return {
      isValid: false,
      status: "verification_error",
      verificationScope: DEFAULT_VERIFICATION_SCOPE,
      summary: "",
      claims: [],
      reason: null,
      skipReason: null,
      error: { code: "INVALID_VERIFICATION" },
    };
  }

  const rawStatus = normalizeNonEmptyString(verification.status);
  const verificationScope =
    normalizeNonEmptyString(verification.verificationScope) ||
    DEFAULT_VERIFICATION_SCOPE;
  const summary =
    typeof verification.summary === "string" ? verification.summary.trim() : "";

  if (!rawStatus || !VALID_VERIFICATION_STATUSES.has(rawStatus)) {
    return {
      isValid: false,
      status: "verification_error",
      verificationScope,
      summary,
      claims: [],
      reason: null,
      skipReason: null,
      error: { code: "UNKNOWN_STATUS" },
    };
  }

  if (rawStatus === "skipped") {
    const resolvedSkipReason =
      normalizeNonEmptyString(verification.skipReason) ||
      normalizeNonEmptyString(verification.reason) ||
      "SKIPPED";
    return {
      isValid: true,
      status: "skipped",
      verificationScope,
      summary,
      claims: [],
      reason: resolvedSkipReason,
      skipReason: resolvedSkipReason,
      error: null,
    };
  }

  if (rawStatus === "verification_error") {
    const errorCode =
      (isPlainObject(verification.error) &&
        normalizeNonEmptyString(verification.error.code)) ||
      "EVALUATION_FAILED";
    return {
      isValid: true,
      status: "verification_error",
      verificationScope,
      summary,
      claims: [],
      reason: null,
      skipReason: null,
      error: { code: errorCode },
    };
  }

  // Status is one of: supported, partially_supported, unsupported
  if (!Array.isArray(verification.claims)) {
    return {
      isValid: false,
      status: "verification_error",
      verificationScope,
      summary,
      claims: [],
      reason: null,
      skipReason: null,
      error: { code: "MISSING_CLAIMS" },
    };
  }

  const normalizedClaims = verification.claims
    .map(normalizeClaimItem)
    .filter(Boolean);

  if (normalizedClaims.length === 0) {
    return {
      isValid: false,
      status: "verification_error",
      verificationScope,
      summary,
      claims: [],
      reason: null,
      skipReason: null,
      error: { code: "EMPTY_CLAIMS" },
    };
  }

  const supportedCount = normalizedClaims.filter(
    (item) => item.verdict === "supported" && item.evidence.length > 0
  ).length;

  let derivedStatus;
  if (supportedCount === normalizedClaims.length) {
    derivedStatus = "supported";
  } else if (supportedCount > 0) {
    derivedStatus = "partially_supported";
  } else {
    derivedStatus = "unsupported";
  }

  // Never upgrade a status beyond what either the payload or the validated claims support
  let finalStatus = derivedStatus;
  if (rawStatus === "unsupported") {
    finalStatus = "unsupported";
  } else if (
    rawStatus === "partially_supported" &&
    derivedStatus === "supported"
  ) {
    finalStatus = "partially_supported";
  }

  return {
    isValid: true,
    status: finalStatus,
    verificationScope,
    summary,
    claims: normalizedClaims,
    reason: null,
    skipReason: null,
    error: null,
  };
}

function collectCandidateSourceChunks(messageSources) {
  if (!Array.isArray(messageSources)) return [];

  const candidates = [];
  for (const item of messageSources) {
    if (!isPlainObject(item)) continue;

    if (Array.isArray(item.chunks)) {
      const parentDocId =
        normalizeNonEmptyString(item.documentId) ||
        normalizeNonEmptyString(item.docId);
      const parentTitle = normalizeNonEmptyString(item.title);
      for (const chunk of item.chunks) {
        if (!isPlainObject(chunk)) continue;
        candidates.push({
          evidenceId:
            normalizeNonEmptyString(chunk.evidenceId) ||
            normalizeNonEmptyString(item.evidenceId),
          documentId:
            normalizeNonEmptyString(chunk.documentId) ||
            normalizeNonEmptyString(chunk.docId) ||
            parentDocId,
          chunkId:
            normalizeNonEmptyString(chunk.chunkId) ||
            normalizeNonEmptyString(chunk.id),
          title: normalizeNonEmptyString(chunk.title) || parentTitle,
          text: typeof chunk.text === "string" ? chunk.text : "",
          sourceUri:
            sanitizeHttpUrl(chunk.sourceUri) ||
            sanitizeHttpUrl(chunk.chunkSource) ||
            sanitizeHttpUrl(item.sourceUri) ||
            sanitizeHttpUrl(item.chunkSource),
          score:
            typeof chunk.score === "number" && Number.isFinite(chunk.score)
              ? chunk.score
              : null,
        });
      }
      continue;
    }

    candidates.push({
      evidenceId: normalizeNonEmptyString(item.evidenceId),
      documentId:
        normalizeNonEmptyString(item.documentId) ||
        normalizeNonEmptyString(item.docId),
      chunkId:
        normalizeNonEmptyString(item.chunkId) ||
        normalizeNonEmptyString(item.id),
      title: normalizeNonEmptyString(item.title),
      text: typeof item.text === "string" ? item.text : "",
      sourceUri:
        sanitizeHttpUrl(item.sourceUri) || sanitizeHttpUrl(item.chunkSource),
      score:
        typeof item.score === "number" && Number.isFinite(item.score)
          ? item.score
          : null,
    });
  }

  return candidates;
}

/**
 * Safely link a Claim's Evidence entry to the current message's `sources`
 * and build a clean preview object compatible with `CitationDetailModal`.
 *
 * Rules:
 * - Only links via unique `evidenceId` or unique `documentId + chunkId`.
 * - Never matches solely by filename, `title`, or `sourceUri`.
 * - Falls back to a text snapshot (`isSnapshot: true`) when `documentId === null`
 *   or when no reliable unique match exists in `messageSources`.
 * - Preserves historical markers (`isHistory: true`, `displayInSources: false`)
 *   when `origin === "history"` or `displayInSources === false`.
 * - Strips internal paths (`docpath`) and rejects non-HTTP(S) URLs.
 *
 * @param {unknown} evidence
 * @param {unknown} messageSources
 * @returns {{
 *   title: string,
 *   references: number,
 *   chunks: Array<{
 *     id: string,
 *     text: string,
 *     chunkSource: string,
 *     score: number | null,
 *     highlightQuote: string
 *   }>,
 *   isSnapshot: boolean,
 *   isHistory: boolean,
 *   displayInSources: boolean,
 *   origin: "retrieval" | "pinned" | "attachment" | "history",
 *   evidenceId: string | null,
 *   documentId: string | null,
 *   chunkId: string | null,
 *   externalUrl: string | null,
 *   quote: string
 * }}
 */
export function buildEvidencePreviewSource(evidence, messageSources = []) {
  if (!isPlainObject(evidence)) {
    return {
      title: "Evidence Snapshot",
      references: 1,
      chunks: [
        {
          id: "snapshot",
          text: "",
          chunkSource: "",
          score: null,
          highlightQuote: "",
        },
      ],
      isSnapshot: true,
      isHistory: false,
      displayInSources: false,
      origin: "retrieval",
      evidenceId: null,
      documentId: null,
      chunkId: null,
      externalUrl: null,
      quote: "",
    };
  }

  const evidenceId = normalizeNonEmptyString(evidence.evidenceId);
  const rawOrigin = normalizeNonEmptyString(evidence.origin);
  const origin = VALID_EVIDENCE_ORIGINS.has(rawOrigin)
    ? rawOrigin
    : evidence.displayInSources === false
      ? "history"
      : "retrieval";

  const isHistory = origin === "history" || evidence.displayInSources === false;
  const displayInSources = isHistory
    ? false
    : typeof evidence.displayInSources === "boolean"
      ? evidence.displayInSources
      : true;

  const hasExplicitNullDocumentId = evidence.documentId === null;
  const documentId =
    origin === "attachment" || hasExplicitNullDocumentId
      ? null
      : normalizeNonEmptyString(evidence.documentId);
  const chunkId = normalizeNonEmptyString(evidence.chunkId);
  const quote = typeof evidence.quote === "string" ? evidence.quote : "";
  const fallbackTitle =
    normalizeNonEmptyString(evidence.title) || "Evidence Snapshot";
  const evidenceExternalUrl = sanitizeHttpUrl(evidence.sourceUri);

  let matchedCandidate = null;

  // Historical evidence, attachments, or missing/null documentId must not be linked as a current-turn document source
  if (
    !isHistory &&
    !hasExplicitNullDocumentId &&
    Boolean(documentId) &&
    origin !== "attachment"
  ) {
    const candidates = collectCandidateSourceChunks(messageSources);

    if (evidenceId) {
      const byEvidenceId = candidates.filter(
        (candidate) =>
          candidate.evidenceId === evidenceId &&
          candidate.text.trim().length > 0
      );
      if (byEvidenceId.length === 1) {
        matchedCandidate = byEvidenceId[0];
      }
    }

    if (!matchedCandidate && documentId && chunkId) {
      const byDocAndChunk = candidates.filter(
        (candidate) =>
          candidate.documentId === documentId &&
          candidate.chunkId === chunkId &&
          candidate.text.trim().length > 0
      );
      if (byDocAndChunk.length === 1) {
        matchedCandidate = byDocAndChunk[0];
      }
    }
  }

  const isSnapshot = !matchedCandidate;
  const resolvedTitle = matchedCandidate?.title || fallbackTitle;
  const resolvedExternalUrl =
    matchedCandidate?.sourceUri || evidenceExternalUrl || null;
  const resolvedText = matchedCandidate ? matchedCandidate.text : quote;
  const resolvedChunkId =
    matchedCandidate?.chunkId || chunkId || evidenceId || "snapshot";
  const resolvedDocumentId = matchedCandidate?.documentId || documentId || null;

  return {
    title: resolvedTitle,
    references: 1,
    chunks: [
      {
        id: resolvedChunkId,
        text: resolvedText,
        chunkSource: resolvedExternalUrl || "",
        score: matchedCandidate ? matchedCandidate.score : null,
        highlightQuote: quote,
      },
    ],
    isSnapshot,
    isHistory,
    displayInSources,
    origin,
    evidenceId,
    documentId: isSnapshot ? documentId : resolvedDocumentId,
    chunkId,
    externalUrl: resolvedExternalUrl,
    quote,
  };
}

function buildDomTextStream(rootNode) {
  const streamChars = [];
  const charMappings = [];

  function pushVirtualNewline() {
    if (streamChars.length === 0) return;
    if (streamChars[streamChars.length - 1] === "\n") return;
    streamChars.push("\n");
    charMappings.push(null);
  }

  function walk(node, parentTag) {
    if (!node || typeof node.nodeType !== "number") return;

    if (node.nodeType === 3) {
      const value = node.nodeValue || "";
      if (!value) return;

      // Ignore inter-element indentation/newline whitespace text nodes
      if (/^[\s\r\n]+$/.test(value)) {
        if (
          /[\r\n]/.test(value) ||
          INTER_ELEMENT_WHITESPACE_CONTAINERS.has(parentTag)
        ) {
          pushVirtualNewline();
          return;
        }
      }

      for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (ch === "\r") {
          if (value[i + 1] === "\n") {
            continue;
          }
          streamChars.push("\n");
          charMappings.push({ node, offset: i });
          continue;
        }
        streamChars.push(ch);
        charMappings.push({ node, offset: i });
      }
      return;
    }

    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) {
      return;
    }

    const tagName =
      node.nodeType === 1 && typeof node.tagName === "string"
        ? node.tagName.toUpperCase()
        : "";

    if (tagName && IGNORED_ELEMENT_TAGS.has(tagName)) {
      return;
    }

    if (tagName === "BR") {
      pushVirtualNewline();
      return;
    }

    const isBlock = tagName && BLOCK_ELEMENT_TAGS.has(tagName);
    if (isBlock) {
      pushVirtualNewline();
    }

    const children = node.childNodes;
    if (children && typeof children.length === "number") {
      for (let i = 0; i < children.length; i += 1) {
        walk(children[i], tagName);
      }
    }

    if (isBlock) {
      pushVirtualNewline();
    }
  }

  walk(rootNode, "");

  while (
    streamChars.length > 0 &&
    streamChars[streamChars.length - 1] === "\n" &&
    charMappings[charMappings.length - 1] === null
  ) {
    streamChars.pop();
    charMappings.pop();
  }

  return {
    text: streamChars.join(""),
    mappings: charMappings,
  };
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n?/g, "\n");
}

function stripMarkdownFormatting(quote) {
  let cleaned = normalizeLineEndings(quote);

  // Strip block-level Markdown markers at line starts
  cleaned = cleaned
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/^[ \t]*\d+\.[ \t]+/gm, "");

  // Strip inline Markdown formatting while preserving text content
  cleaned = cleaned
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/___([^_]+)___/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1");

  // Collapse consecutive newlines to match single virtual block separator
  cleaned = cleaned.replace(/\n{2,}/g, "\n").replace(/^\n+|\n+$/g, "");

  return cleaned;
}

function findAllOccurrences(haystack, needle) {
  if (!haystack || !needle) return [];
  const matches = [];
  let fromIndex = 0;

  while (fromIndex <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, fromIndex);
    if (idx === -1) break;
    matches.push({ start: idx, end: idx + needle.length });
    if (matches.length > 1) break;
    fromIndex = idx + 1;
  }

  return matches;
}

function isSplitSurrogateBoundary(text, index) {
  if (index <= 0 || index >= text.length) return false;
  const prevCode = text.charCodeAt(index - 1);
  const nextCode = text.charCodeAt(index);
  return (
    prevCode >= 0xd800 &&
    prevCode <= 0xdbff &&
    nextCode >= 0xdc00 &&
    nextCode <= 0xdfff
  );
}

/**
 * Locate a unique DOM `Range` corresponding to `answerQuote` inside `rootNode`.
 *
 * Rules:
 * - Only attempts location when `answerLocation?.status === "located"`.
 * - Never uses `answerLocation.start/end` directly as DOM offsets.
 * - Traverses rendered DOM text nodes and handles quotes spanning multiple
 *   inline elements (`<strong>`, `<em>`, `<code>`, etc.).
 * - Inserts virtual block boundaries so unrelated paragraphs/list items are
 *   never falsely concatenated into a match.
 * - Returns a DOM `Range` if and only if there is a single unique match.
 * - Never mutates `rootNode`.
 *
 * @param {Node} rootNode
 * @param {string} answerQuote
 * @param {{ status?: string, ranges?: Array<{ start: number, end: number }> }} answerLocation
 * @returns {Range | null}
 */
export function findUniqueDomTextRange(rootNode, answerQuote, answerLocation) {
  if (
    !rootNode ||
    typeof rootNode !== "object" ||
    typeof rootNode.nodeType !== "number"
  ) {
    return null;
  }

  if (typeof answerQuote !== "string" || answerQuote.trim().length === 0) {
    return null;
  }

  if (!isPlainObject(answerLocation) || answerLocation.status !== "located") {
    return null;
  }

  if (
    !Array.isArray(answerLocation.ranges) ||
    answerLocation.ranges.length !== 1
  ) {
    return null;
  }

  const [locRange] = answerLocation.ranges;
  if (
    !isPlainObject(locRange) ||
    !Number.isInteger(locRange.start) ||
    !Number.isInteger(locRange.end) ||
    locRange.start < 0 ||
    locRange.end <= locRange.start
  ) {
    return null;
  }

  const ownerDocument =
    rootNode.nodeType === 9 ? rootNode : rootNode.ownerDocument;
  if (!ownerDocument || typeof ownerDocument.createRange !== "function") {
    return null;
  }

  const { text: streamText, mappings } = buildDomTextStream(rootNode);
  if (!streamText || mappings.length === 0) {
    return null;
  }

  const rawCandidate = normalizeLineEndings(answerQuote);
  let matches = findAllOccurrences(streamText, rawCandidate);

  if (matches.length > 1) {
    return null;
  }

  if (matches.length === 0) {
    const markdownStrippedCandidate = stripMarkdownFormatting(answerQuote);
    if (
      !markdownStrippedCandidate ||
      markdownStrippedCandidate.trim().length === 0
    ) {
      return null;
    }
    if (markdownStrippedCandidate !== rawCandidate) {
      matches = findAllOccurrences(streamText, markdownStrippedCandidate);
    }
  }

  if (matches.length !== 1) {
    return null;
  }

  const { start, end } = matches[0];
  if (
    isSplitSurrogateBoundary(streamText, start) ||
    isSplitSurrogateBoundary(streamText, end)
  ) {
    return null;
  }

  let startIndex = start;
  while (startIndex < end && mappings[startIndex] === null) {
    startIndex += 1;
  }

  let endIndex = end - 1;
  while (endIndex >= startIndex && mappings[endIndex] === null) {
    endIndex -= 1;
  }

  const startPos = mappings[startIndex];
  const endPos = mappings[endIndex];
  if (!startPos || !endPos) {
    return null;
  }

  try {
    const range = ownerDocument.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset + 1);
    return range;
  } catch {
    return null;
  }
}

/**
 * Safely slice evidence chunk text around a unique occurrence of `highlightQuote`
 * for React text-node rendering (`before`, `<mark>match</mark>`, `after`).
 *
 * Rules:
 * - Never modifies characters of `text`.
 * - Only highlights when `highlightQuote` is non-empty and matches uniquely (`matches.length === 1`).
 * - Falls back to `{ matched: false, before: text, match: "", after: "" }` when not found or ambiguous.
 *
 * @param {unknown} text
 * @param {unknown} highlightQuote
 * @returns {{ matched: boolean, before: string, match: string, after: string }}
 */
export function sliceTextForHighlight(text, highlightQuote) {
  const safeText = typeof text === "string" ? text : "";
  if (
    !safeText ||
    typeof highlightQuote !== "string" ||
    highlightQuote.trim().length === 0
  ) {
    return { matched: false, before: safeText, match: "", after: "" };
  }

  let matches = findAllOccurrences(safeText, highlightQuote);

  if (matches.length === 0) {
    const normalizedQuote = normalizeLineEndings(highlightQuote);
    if (
      normalizedQuote !== highlightQuote &&
      normalizedQuote.trim().length > 0
    ) {
      matches = findAllOccurrences(safeText, normalizedQuote);
    }
  }

  if (matches.length !== 1) {
    return { matched: false, before: safeText, match: "", after: "" };
  }

  const { start, end } = matches[0];
  if (
    isSplitSurrogateBoundary(safeText, start) ||
    isSplitSurrogateBoundary(safeText, end)
  ) {
    return { matched: false, before: safeText, match: "", after: "" };
  }

  return {
    matched: true,
    before: safeText.slice(0, start),
    match: safeText.slice(start, end),
    after: safeText.slice(end),
  };
}
