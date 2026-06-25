// StreamingIndicator — animated dots indicating agent is thinking/generating.
// Spec §10.4: streaming input indicator.
//
// Data + functions: stateless render controlled by isStreaming prop.

import { css } from "@linaria/core";

// ---------------------------------------------------------------------------
// Styles (@linaria — zero runtime)
// ---------------------------------------------------------------------------

const container = css`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
`;

const dot = css`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--haze-color-text-secondary, #888);
  animation: bounce 1.4s infinite ease-in-out both;

  &:nth-child(1) {
    animation-delay: -0.32s;
  }

  &:nth-child(2) {
    animation-delay: -0.16s;
  }

  @keyframes bounce {
    0%,
    80%,
    100% {
      transform: scale(0.6);
      opacity: 0.4;
    }
    40% {
      transform: scale(1);
      opacity: 1;
    }
  }
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type StreamingIndicatorProps = {
  isStreaming?: boolean;
};

export function StreamingIndicator({ isStreaming = true }: StreamingIndicatorProps) {
  if (!isStreaming) return null;

  return (
    <div className={container} role="status" aria-label="Agent 正在生成">
      <span className={dot} />
      <span className={dot} />
      <span className={dot} />
    </div>
  );
}
