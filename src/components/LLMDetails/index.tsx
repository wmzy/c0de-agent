// LLMDetails — LLM call timeline with token usage, latency, expandable details.
// Spec §10: timeline display of each LLM call with usage stats.
//
// Data + functions: pure render from LLMDetail[] prop.

import { css } from "@linaria/core";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  ScrollArea,
  Tag,
} from "haze-ui";
import { useMemo, useState } from "react";
import type { LLMDetail as LLMDetailType } from "../../core/types";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const container = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 13px;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
`;

const timelineArea = css`
  flex: 1;
  overflow-y: auto;
  padding: 8px;
`;

const timelineItem = css`
  margin-bottom: 8px;
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  overflow: hidden;
`;

const timelineHeader = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.1s;

  &:hover {
    background: var(--haze-color-bg-subtle);
  }
`;

const timelineIndex = css`
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--haze-color-primary);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
`;

const timelineTitle = css`
  flex: 1;
  font-weight: 500;
  color: var(--haze-color-text);
`;

const timelineMeta = css`
  display: flex;
  gap: 6px;
  flex-shrink: 0;
`;

const detailBody = css`
  padding: 12px;
  border-top: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg-subtle);
`;

const statsGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
`;

const statBox = css`
  padding: 8px 10px;
  background: var(--haze-color-bg);
  border-radius: 6px;
  border: 1px solid var(--haze-color-border);
`;

const statLabel = css`
  font-size: 11px;
  color: var(--haze-color-text-muted);
  margin-bottom: 2px;
`;

const statValue = css`
  font-size: 15px;
  font-weight: 600;
  color: var(--haze-color-text);
`;

const sectionTitle = css`
  font-size: 12px;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
  margin: 12px 0 6px;
`;

const preBlock = css`
  font-family: var(--haze-font-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
  padding: 10px;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  overflow-x: auto;
  max-height: 200px;
  white-space: pre-wrap;
  word-break: break-word;
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLatency(firstToken: number | null, total: number | null): string {
  if (total === null) return "进行中…";
  if (total < 1000) return `${total}ms`;
  return `${(total / 1000).toFixed(1)}s`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1000000).toFixed(2)}M`;
}

// ---------------------------------------------------------------------------
// Single timeline entry
// ---------------------------------------------------------------------------

type TimelineEntryProps = {
  detail: LLMDetailType;
  index: number;
  defaultOpen?: boolean;
};

function TimelineEntry({ detail, index, defaultOpen = false }: TimelineEntryProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const latency = formatLatency(detail.latency.firstToken, detail.latency.total);
  const totalTokens = detail.usage.input + detail.usage.output;
  const hasError = !!detail.error;

  return (
    <div className={timelineItem}>
      <Collapsible open={isOpen}>
        <CollapsibleTrigger>
          <div className={timelineHeader}>
            <div className={timelineIndex}>{index + 1}</div>
            <div className={timelineTitle}>
              {detail.model}
              {detail.provider && detail.provider !== detail.model && (
                <span
                  style={{ fontSize: 11, color: "var(--haze-color-text-muted)", marginLeft: 6 }}
                >
                  via {detail.provider}
                </span>
              )}
            </div>
            <div className={timelineMeta}>
              <Tag size="sm">{formatTokens(totalTokens)} tokens</Tag>
              <Tag size="sm">{latency}</Tag>
              {hasError && (
                <Tag variant="danger" size="sm">
                  错误
                </Tag>
              )}
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className={detailBody}>
            <div className={statsGrid}>
              <div className={statBox}>
                <div className={statLabel}>输入 Tokens</div>
                <div className={statValue}>{formatTokens(detail.usage.input)}</div>
              </div>
              <div className={statBox}>
                <div className={statLabel}>输出 Tokens</div>
                <div className={statValue}>{formatTokens(detail.usage.output)}</div>
              </div>
              <div className={statBox}>
                <div className={statLabel}>首 Token 延迟</div>
                <div className={statValue}>
                  {detail.latency.firstToken !== null ? `${detail.latency.firstToken}ms` : "—"}
                </div>
              </div>
              <div className={statBox}>
                <div className={statLabel}>总延迟</div>
                <div className={statValue}>{latency}</div>
              </div>
              <div className={statBox}>
                <div className={statLabel}>成本</div>
                <div className={statValue}>
                  {detail.cost !== null ? `$${detail.cost.toFixed(4)}` : "—"}
                </div>
              </div>
              {detail.usage.cacheHit !== undefined && detail.usage.cacheHit > 0 && (
                <div className={statBox}>
                  <div className={statLabel}>缓存命中</div>
                  <div className={statValue}>{formatTokens(detail.usage.cacheHit)}</div>
                </div>
              )}
            </div>

            {detail.thinking && (
              <>
                <div className={sectionTitle}>思考过程</div>
                <pre className={preBlock}>{detail.thinking}</pre>
              </>
            )}

            {detail.error && (
              <>
                <div className={sectionTitle}>错误信息</div>
                <pre className={preBlock}>
                  {detail.error._tag === "llm_error"
                    ? detail.error.message
                    : detail.error._tag === "unknown"
                      ? detail.error.message
                      : `错误类型: ${detail.error._tag}`}
                </pre>
              </>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export type LLMDetailsProps = {
  details: LLMDetailType[];
  className?: string;
};

export function LLMDetails({ details, className }: LLMDetailsProps) {
  const totalInput = useMemo(() => details.reduce((sum, d) => sum + d.usage.input, 0), [details]);
  const totalOutput = useMemo(() => details.reduce((sum, d) => sum + d.usage.output, 0), [details]);

  return (
    <div className={`${container} ${className ?? ""}`}>
      <div className={header}>
        <span>LLM 调用记录</span>
        <span style={{ fontSize: 11, fontWeight: 400 }}>
          {details.length} 次调用 · {formatTokens(totalInput + totalOutput)} tokens
        </span>
      </div>
      <ScrollArea>
        <div className={timelineArea}>
          {details.length === 0 ? (
            <Empty description="暂无 LLM 调用记录" />
          ) : (
            details.map((detail, i) => (
              <TimelineEntry
                key={detail.id}
                detail={detail}
                index={i}
                defaultOpen={i === details.length - 1}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
