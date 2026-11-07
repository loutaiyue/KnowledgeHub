import { useState, useEffect } from "react";
import {
  CheckCircle,
  WarningCircle,
  Question,
  Info,
  CaretDown,
  CaretRight,
  FileText,
  ClockCounterClockwise,
  Paperclip,
  PushPin,
  MagnifyingGlass,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { CitationDetailModal } from "../Citation";
import {
  normalizeVerification,
  buildEvidencePreviewSource,
  findUniqueDomTextRange,
} from "./utils";

const STATUS_META = {
  supported: {
    label: "已核查：证据支持",
    badgeClass:
      "bg-emerald-500/10 text-emerald-400 light:bg-emerald-50 light:text-emerald-700 border-emerald-500/25 light:border-emerald-300",
    Icon: CheckCircle,
  },
  partially_supported: {
    label: "部分证据支持",
    badgeClass:
      "bg-amber-500/10 text-amber-400 light:bg-amber-50 light:text-amber-700 border-amber-500/25 light:border-amber-300",
    Icon: WarningCircle,
  },
  unsupported: {
    label: "缺乏证据支持",
    badgeClass:
      "bg-rose-500/10 text-rose-400 light:bg-rose-50 light:text-rose-700 border-rose-500/25 light:border-rose-300",
    Icon: WarningCircle,
  },
  skipped: {
    label: "未执行事实核查",
    badgeClass:
      "bg-zinc-800/80 text-zinc-400 light:bg-slate-100 light:text-slate-600 border-zinc-700/80 light:border-slate-300",
    Icon: Info,
  },
  verification_error: {
    label: "核查未完成",
    badgeClass:
      "bg-zinc-800/80 text-zinc-400 light:bg-slate-100 light:text-slate-600 border-zinc-700/80 light:border-slate-300",
    Icon: Info,
  },
};

const VERDICT_META = {
  supported: {
    label: "证据支持",
    badgeClass:
      "bg-emerald-500/10 text-emerald-300 light:bg-emerald-50 light:text-emerald-700 border-emerald-500/25 light:border-emerald-300",
    Icon: CheckCircle,
  },
  unsupported: {
    label: "无证据支持",
    badgeClass:
      "bg-rose-500/10 text-rose-300 light:bg-rose-50 light:text-rose-700 border-rose-500/25 light:border-rose-300",
    Icon: WarningCircle,
  },
  uncertain: {
    label: "证据存疑",
    badgeClass:
      "bg-amber-500/10 text-amber-300 light:bg-amber-50 light:text-amber-700 border-amber-500/25 light:border-amber-300",
    Icon: Question,
  },
};

const ORIGIN_META = {
  retrieval: {
    label: "检索片段",
    Icon: MagnifyingGlass,
  },
  pinned: {
    label: "置顶文档",
    Icon: PushPin,
  },
  attachment: {
    label: "会话附件",
    Icon: Paperclip,
  },
  history: {
    label: "历史上下文",
    Icon: ClockCounterClockwise,
  },
};

function getSkippedDescription(skipReason, summary) {
  switch (skipReason) {
    case "NO_CONTEXT":
    case "NO_VERIFIABLE_CONTEXT":
      return "当前回答未使用可核查的检索上下文，已跳过事实一致性核查。";
    case "CONTEXT_COMPRESSED":
    case "INCOMPLETE_EVIDENCE":
      return "当前会话上下文经过窗口压缩，为避免不完整证据导致误判，已跳过自动核查。";
    case "NO_FACTUAL_CLAIMS":
      return "未从回答中提取到需要核查的具体事实陈述。";
    case "EMPTY_ANSWER":
      return "回答内容为空，未执行事实核查。";
    case "PROVIDER_UNSUPPORTED":
    case "evaluator_unavailable":
      return "当前模型提供方暂不支持自动事实核查。";
    case "evaluation_context_too_large":
      return "证据上下文超出评估窗口上限，已跳过自动核查。";
    default:
      return summary || "本次回答已跳过自动事实一致性核查。";
  }
}

function getErrorDescription(errorCode, summary) {
  switch (errorCode) {
    case "EVALUATION_TIMEOUT":
      return "事实核查请求超时，未影响原始回答展示，请以引用来源为准。";
    case "INVALID_JSON":
      return "事实核查结果格式解析失败（JSON 格式无效），未影响原始回答展示，请直接参考引用来源核对原文。";
    case "INVALID_SCHEMA":
      return "事实核查结果结构校验未通过，未影响原始回答展示，请直接参考引用来源核对原文。";
    case "EVALUATION_FAILED":
      return "事实核查服务调用失败，未影响原始回答展示，请直接参考引用来源核对原文。";
    case "evaluation_context_not_preserved":
      return "当前会话上下文经过压缩或截断，无法基于完整证据完成核查，请直接参考引用来源核对原文。";
    case "evaluation_context_too_large":
      return "待核查的证据上下文超出模型评估窗口上限，未能完成自动核查，请直接参考引用来源核对原文。";
    case "evaluator_unavailable":
      return "当前模型提供方暂不支持自动事实核查，请直接参考引用来源核对原文。";
    default:
      return summary &&
        summary !== "Answer verification could not be completed."
        ? summary
        : "事实一致性核查暂时未能完成，请直接参考引用文档核对原文。";
  }
}

/**
 * Claim -> Evidence verification panel for assistant chat replies.
 *
 * @param {Object} props
 * @param {Object|null|undefined} props.verification - Raw verification payload from backend SSE or chat history
 * @param {Array<Object>} [props.messageSources=[]] - Current message `sources` array
 * @param {import("react").RefObject<HTMLElement>|HTMLElement|null} [props.answerRootRef=null] - Optional container ref for DOM range lookup
 * @param {boolean} [props.defaultExpanded=false] - Whether the panel starts expanded
 * @param {(range: Range | null, claimItem: Object) => void} [props.onLocateClaimQuote] - Optional callback when locating a claim quote in the answer DOM
 */
export default function ClaimVerification({
  verification,
  messageSources = [],
  answerRootRef = null,
  defaultExpanded = false,
  onLocateClaimQuote = null,
}) {
  const [isExpanded, setIsExpanded] = useState(Boolean(defaultExpanded));
  const [collapsedClaimIndices, setCollapsedClaimIndices] = useState({});
  const [locateStatusByClaim, setLocateStatusByClaim] = useState({});
  const [activePreview, setActivePreview] = useState(null);

  useEffect(() => {
    setIsExpanded(Boolean(defaultExpanded));
  }, [defaultExpanded]);

  // Do not render anything for normal chat messages without verification data
  if (verification === null || verification === undefined) {
    return null;
  }

  const normalized = normalizeVerification(verification);
  const statusMeta =
    STATUS_META[normalized.status] || STATUS_META.verification_error;
  const StatusIcon = statusMeta.Icon;

  const totalClaims = normalized.claims.length;
  const supportedClaimsCount = normalized.claims.filter(
    (c) => c.verdict === "supported"
  ).length;

  function toggleClaimCollapse(idx) {
    setCollapsedClaimIndices((prev) => ({
      ...prev,
      [idx]: !prev[idx],
    }));
  }

  function handleOpenEvidence(evidenceItem) {
    const previewSource = buildEvidencePreviewSource(
      evidenceItem,
      messageSources
    );
    setActivePreview({
      source: previewSource,
      highlightQuote: evidenceItem?.quote || null,
    });
  }

  function handleLocateQuote(claimItem, claimIdx) {
    const rootNode =
      answerRootRef && "current" in answerRootRef
        ? answerRootRef.current
        : answerRootRef;
    const range = rootNode
      ? findUniqueDomTextRange(
          rootNode,
          claimItem.answerQuote,
          claimItem.answerLocation
        )
      : null;

    if (range) {
      try {
        const startNode = range.startContainer;
        const targetElement =
          startNode?.nodeType === 1 ? startNode : startNode?.parentElement;
        if (typeof targetElement?.scrollIntoView === "function") {
          targetElement.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }
      } catch {}

      try {
        const ownerWindow =
          rootNode?.ownerDocument?.defaultView ||
          (typeof window !== "undefined" ? window : null);
        const selection = ownerWindow?.getSelection?.();
        if (
          selection &&
          typeof selection.removeAllRanges === "function" &&
          typeof selection.addRange === "function"
        ) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
      } catch {}
    }

    setLocateStatusByClaim((prev) => ({
      ...prev,
      [claimIdx]: range ? "located" : "unlocated",
    }));

    if (typeof onLocateClaimQuote === "function") {
      onLocateClaimQuote(range, claimItem);
    }
  }

  let statusCountSummary = null;
  if (
    normalized.status === "supported" ||
    normalized.status === "partially_supported" ||
    normalized.status === "unsupported"
  ) {
    statusCountSummary = `(${supportedClaimsCount}/${totalClaims} 条陈述获证据支持)`;
  }

  return (
    <div
      data-testid="claim-verification-panel"
      data-verification-status={normalized.status}
      className="mt-2 w-full max-w-full rounded-lg border border-zinc-800 light:border-slate-200 bg-zinc-900/60 light:bg-slate-50/80 text-xs text-zinc-200 light:text-slate-800"
    >
      <button
        type="button"
        data-testid="claim-verification-toggle"
        aria-expanded={isExpanded}
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-white/5 light:hover:bg-black/5 transition-colors rounded-lg cursor-pointer"
      >
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span
            data-testid="claim-verification-status-badge"
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium ${statusMeta.badgeClass}`}
          >
            <StatusIcon size={13} weight="bold" className="shrink-0" />
            <span>{statusMeta.label}</span>
          </span>
          {statusCountSummary && (
            <span className="text-[11px] text-zinc-400 light:text-slate-500">
              {statusCountSummary}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px] text-zinc-400 light:text-slate-500 shrink-0">
          <span>{isExpanded ? "收起详情" : "展开详情"}</span>
          {isExpanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </div>
      </button>

      {isExpanded && (
        <div
          data-testid="claim-verification-body"
          className="px-3 pb-3 pt-1 border-t border-zinc-800/80 light:border-slate-200 flex flex-col gap-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-400 light:text-slate-500">
            <span>核查范围：仅针对模型提取的事实陈述（不改写原始回答）</span>
          </div>

          {normalized.status === "skipped" && (
            <div
              data-testid="claim-verification-skipped-message"
              className="p-2.5 rounded bg-zinc-800/50 light:bg-slate-100 text-zinc-300 light:text-slate-700 leading-relaxed"
            >
              {getSkippedDescription(normalized.skipReason, normalized.summary)}
            </div>
          )}

          {normalized.status === "verification_error" && (
            <div
              data-testid="claim-verification-error-message"
              className="p-2.5 rounded bg-zinc-800/50 light:bg-slate-100 text-zinc-300 light:text-slate-700 leading-relaxed"
            >
              {getErrorDescription(normalized.error?.code, normalized.summary)}
            </div>
          )}

          {normalized.status !== "skipped" &&
            normalized.status !== "verification_error" &&
            normalized.summary && (
              <p
                data-testid="claim-verification-summary"
                className="m-0 text-zinc-300 light:text-slate-700 leading-relaxed"
              >
                {normalized.summary}
              </p>
            )}

          {normalized.claims.length > 0 && (
            <div
              data-testid="claim-verification-claims-list"
              className="flex flex-col gap-2"
            >
              {normalized.claims.map((claimItem, claimIdx) => {
                const verdictMeta =
                  VERDICT_META[claimItem.verdict] || VERDICT_META.uncertain;
                const VerdictIcon = verdictMeta.Icon;
                const isClaimCollapsed = Boolean(
                  collapsedClaimIndices[claimIdx]
                );
                const isAnswerQuoteLocated =
                  claimItem.answerLocation?.status === "located";

                return (
                  <div
                    key={`${claimIdx}-${claimItem.claim.slice(0, 24)}`}
                    data-testid={`claim-card-${claimIdx}`}
                    data-claim-verdict={claimItem.verdict}
                    className="rounded-md border border-zinc-800 light:border-slate-200 bg-zinc-900/90 light:bg-white p-2.5 flex flex-col gap-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
                        <span
                          data-testid={`claim-verdict-badge-${claimIdx}`}
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium shrink-0 ${verdictMeta.badgeClass}`}
                        >
                          <VerdictIcon size={11} weight="bold" />
                          <span>{verdictMeta.label}</span>
                        </span>
                        <span
                          data-testid={`claim-text-${claimIdx}`}
                          className="font-medium text-zinc-100 light:text-slate-900 break-words"
                        >
                          {claimItem.claim}
                        </span>
                      </div>

                      <button
                        type="button"
                        data-testid={`claim-card-toggle-${claimIdx}`}
                        aria-expanded={!isClaimCollapsed}
                        onClick={() => toggleClaimCollapse(claimIdx)}
                        className="text-[11px] text-zinc-400 light:text-slate-500 hover:text-zinc-200 light:hover:text-slate-800 flex items-center gap-0.5 shrink-0 cursor-pointer bg-transparent border-none p-0.5"
                      >
                        <span>{isClaimCollapsed ? "展开" : "收起"}</span>
                        {isClaimCollapsed ? (
                          <CaretRight size={11} />
                        ) : (
                          <CaretDown size={11} />
                        )}
                      </button>
                    </div>

                    {!isClaimCollapsed && (
                      <div
                        data-testid={`claim-card-details-${claimIdx}`}
                        className="flex flex-col gap-2 pl-1"
                      >
                        {claimItem.answerQuote && (
                          <div className="flex flex-wrap items-baseline gap-1.5 text-[11px] text-zinc-400 light:text-slate-600">
                            <span className="shrink-0">回答原文片段：</span>
                            {isAnswerQuoteLocated &&
                            (answerRootRef || onLocateClaimQuote) ? (
                              <button
                                type="button"
                                data-testid={`claim-answer-quote-${claimIdx}`}
                                data-locate-status={
                                  locateStatusByClaim[claimIdx] || "idle"
                                }
                                onClick={() =>
                                  handleLocateQuote(claimItem, claimIdx)
                                }
                                className="text-left italic text-zinc-300 light:text-slate-700 hover:underline bg-transparent border-none p-0 cursor-pointer"
                              >
                                “{claimItem.answerQuote}”
                              </button>
                            ) : (
                              <span
                                data-testid={`claim-answer-quote-${claimIdx}`}
                                data-locate-status="disabled"
                                className="italic text-zinc-300 light:text-slate-700 break-words"
                              >
                                “{claimItem.answerQuote}”
                              </span>
                            )}
                            {locateStatusByClaim[claimIdx] === "unlocated" && (
                              <span
                                data-testid={`claim-locate-feedback-${claimIdx}`}
                                className="text-[10px] text-zinc-500 light:text-slate-400"
                              >
                                （未能唯一定位原文位置）
                              </span>
                            )}
                          </div>
                        )}

                        {claimItem.reason && (
                          <p
                            data-testid={`claim-reason-${claimIdx}`}
                            className="m-0 text-[11px] text-zinc-400 light:text-slate-600"
                          >
                            说明：{claimItem.reason}
                          </p>
                        )}

                        {claimItem.evidence.length > 0 ? (
                          <div
                            data-testid={`claim-evidence-list-${claimIdx}`}
                            className="flex flex-col gap-1.5 mt-0.5"
                          >
                            {claimItem.evidence.map((ev, evIdx) => {
                              const previewInfo = buildEvidencePreviewSource(
                                ev,
                                messageSources
                              );
                              const originKey = previewInfo.isHistory
                                ? "history"
                                : previewInfo.origin;
                              const originMeta =
                                ORIGIN_META[originKey] || ORIGIN_META.retrieval;
                              const OriginIcon = originMeta.Icon;

                              return (
                                <button
                                  key={`${ev.evidenceId}-${evIdx}`}
                                  type="button"
                                  data-testid={`evidence-item-${claimIdx}-${evIdx}`}
                                  data-evidence-origin={originKey}
                                  data-evidence-is-history={String(
                                    previewInfo.isHistory
                                  )}
                                  data-evidence-is-snapshot={String(
                                    previewInfo.isSnapshot
                                  )}
                                  onClick={() => handleOpenEvidence(ev)}
                                  className="w-full text-left rounded border border-zinc-800 light:border-slate-200 bg-zinc-950/60 light:bg-slate-50 hover:bg-zinc-800/60 light:hover:bg-slate-100 transition-colors p-2 flex flex-col gap-1 cursor-pointer"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-1.5 w-full">
                                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                                      <FileText
                                        size={12}
                                        className="text-zinc-400 light:text-slate-500 shrink-0"
                                      />
                                      <span
                                        data-testid={`evidence-title-${claimIdx}-${evIdx}`}
                                        className="font-medium text-zinc-200 light:text-slate-800 truncate max-w-[260px]"
                                      >
                                        {previewInfo.title}
                                      </span>

                                      <span
                                        data-testid={`evidence-origin-badge-${claimIdx}-${evIdx}`}
                                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border ${
                                          previewInfo.isHistory
                                            ? "bg-amber-500/15 text-amber-300 light:bg-amber-100 light:text-amber-800 border-amber-500/30 light:border-amber-300"
                                            : "bg-zinc-800 text-zinc-300 light:bg-slate-200/70 light:text-slate-700 border-zinc-700 light:border-slate-300"
                                        }`}
                                      >
                                        <OriginIcon size={10} />
                                        <span>{originMeta.label}</span>
                                      </span>

                                      {previewInfo.isSnapshot && (
                                        <span
                                          data-testid={`evidence-snapshot-badge-${claimIdx}-${evIdx}`}
                                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-zinc-800/80 text-zinc-400 light:bg-slate-200/60 light:text-slate-600 border border-zinc-700/80 light:border-slate-300"
                                        >
                                          文本快照
                                        </span>
                                      )}
                                    </div>

                                    <span className="inline-flex items-center gap-0.5 text-[10px] text-blue-400 light:text-blue-600 shrink-0">
                                      <span>查看证据</span>
                                      <ArrowSquareOut size={11} />
                                    </span>
                                  </div>

                                  <p
                                    data-testid={`evidence-quote-${claimIdx}-${evIdx}`}
                                    className="m-0 text-[11px] text-zinc-300 light:text-slate-700 line-clamp-3 whitespace-pre-line break-words border-l-2 border-zinc-700 light:border-slate-300 pl-2"
                                  >
                                    {ev.quote}
                                  </p>
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <p
                            data-testid={`claim-no-evidence-${claimIdx}`}
                            className="m-0 text-[11px] text-zinc-500 light:text-slate-500 italic"
                          >
                            无关联证据片段
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {activePreview && (
        <CitationDetailModal
          source={activePreview.source}
          highlightQuote={activePreview.highlightQuote}
          onClose={() => setActivePreview(null)}
        />
      )}
    </div>
  );
}
