// ChatPage layout styles — linaria css definitions.
// All visual styling for the ChatPage module lives here.

import { css } from "@linaria/core";

// ---------------------------------------------------------------------------
// Tunables (used by css template literals)
// ---------------------------------------------------------------------------

export const MAX_TEXTAREA_HEIGHT = 200;

// ---------------------------------------------------------------------------
// Page layout
// ---------------------------------------------------------------------------

export const page = css`
  display: flex;
  height: calc(100vh - 64px);
  overflow: hidden;
  background-color: var(--haze-color-bg);
  background-image:
    radial-gradient(ellipse 70% 50% at 50% -10%, rgba(88, 166, 255, 0.04) 0%, transparent 60%);

  @media (max-width: 768px) {
    height: calc(100vh - 64px - 56px);
  }
`;

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export const sidebar = css`
  width: 320px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
  overflow: hidden;
  box-shadow: 1px 0 4px rgba(0, 0, 0, 0.08);
  transition: width 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;

  @media (max-width: 768px) {
    display: none;
  }
`;

export const sidebarCollapsed = css`
  width: 0;
  opacity: 0;
  border-right: none;
  pointer-events: none;
`;

export const sidebarToggle = css`
  position: absolute;
  top: 8px;
  right: -14px;
  z-index: 10;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);

  &:hover {
    background: var(--haze-color-bg-subtle);
    border-color: var(--haze-color-primary);
    transform: scale(1.1);
  }
`;

export const sidebarWrapper = css`
  position: relative;
  flex-shrink: 0;

  @media (max-width: 768px) {
    display: none;
  }
`;

export const tabContent = css`
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  animation: c0de-tabFadeIn 0.2s ease;

  @keyframes c0de-tabFadeIn {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

export const sidebarTabs = css`
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
`;

// ---------------------------------------------------------------------------
// Main area
// ---------------------------------------------------------------------------

export const mainArea = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
`;

export const chatArea = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

export const messagesContainer = css`
  flex: 1;
  overflow-y: auto;
  padding: 20px 16px;
  scroll-behavior: smooth;
`;

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

export const topBar = css`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  z-index: 1;
`;

export const topBarTitle = css`
  font-size: 14px;
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const topBarMeta = css`
  font-size: 12px;
  color: var(--haze-color-text-muted);
  display: inline-flex;
  align-items: center;
  gap: 6px;
`;

// ---------------------------------------------------------------------------
// Responsive buttons
// ---------------------------------------------------------------------------

export const mobileMenuBtn = css`
  @media (min-width: 769px) {
    display: none;
  }
`;

export const collapseBtn = css`
  @media (max-width: 768px) {
    display: none;
  }
`;

// ---------------------------------------------------------------------------
// Message rows
// ---------------------------------------------------------------------------

export const messageRow = css`
  max-width: 820px;
  margin: 0 auto 16px;
  animation: c0de-fadeInUp 0.35s var(--c0de-ease-out) both;
`;

export const streamingBubble = css`
  background: var(--haze-color-bg-subtle);
  border: 1px solid var(--haze-color-border);
  padding: 14px 18px;
  border-radius: 12px 12px 12px 4px;
  line-height: 1.6;
  font-size: 14px;
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.03);
  animation: c0de-fadeInUp 0.3s var(--c0de-ease-out) both;
`;

export const thinkingBubble = css`
  background: rgba(88, 166, 255, 0.06);
  border: 1px solid rgba(88, 166, 255, 0.12);
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--haze-color-text-muted);
  display: inline-flex;
  animation: c0de-fadeIn 0.4s var(--c0de-ease-out) both;
`;

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export const toolCallContainer = css`
  margin-top: 8px;
`;

export const toolCallStack = css`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

// ---------------------------------------------------------------------------
// Error banner
// ---------------------------------------------------------------------------

export const errorBanner = css`
  background: color-mix(in srgb, var(--haze-color-danger) 8%, var(--haze-color-bg));
  border: 1px solid color-mix(in srgb, var(--haze-color-danger) 30%, var(--haze-color-bg));
  color: var(--haze-color-danger);
  padding: 10px 14px;
  border-radius: 10px;
  margin: 12px auto;
  font-size: 13px;
  max-width: 800px;
  display: flex;
  align-items: center;
  gap: 12px;
  box-shadow: 0 2px 8px rgba(248, 81, 73, 0.1);
  animation: c0de-fadeInUp 0.3s var(--c0de-ease-out) both;
`;

export const errorMessage = css`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`;

// ---------------------------------------------------------------------------
// Empty chat
// ---------------------------------------------------------------------------

export const emptyChat = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--haze-color-text-muted);
  gap: 16px;
  padding: 48px 24px;
`;

export const emptyChatTitle = css`
  font-size: 20px;
  font-weight: 600;
  color: var(--haze-color-text);
`;

export const emptyChatHint = css`
  font-size: 14px;
  text-align: center;
  max-width: 360px;
  line-height: 1.6;
`;

// ---------------------------------------------------------------------------
// Chat input area
// ---------------------------------------------------------------------------

export const inputArea = css`
  padding: 12px 16px 14px;
  border-top: 1px solid var(--haze-color-border);
  background: linear-gradient(180deg, var(--haze-color-bg) 0%, rgba(13, 17, 23, 0.98) 100%);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
`;

export const inputWrapper = css`
  max-width: 800px;
  margin: 0 auto;
  display: flex;
  position: relative;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
  border: 1px solid var(--haze-color-border);
  border-radius: 14px;
  background: var(--haze-color-bg-subtle);
  box-shadow: var(--haze-shadow-sm);
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);

  &:focus-within {
    border-color: var(--haze-color-primary);
    box-shadow:
      0 0 0 3px var(--haze-color-focus-ring),
      0 4px 16px rgba(88, 166, 255, 0.1);
    background: var(--haze-color-bg);
  }
`;

export const inputWrapperDisabled = css`
  opacity: 0.6;
  pointer-events: none;
`;

export const inputWrapperError = css`
  border-color: color-mix(in srgb, var(--haze-color-danger) 50%, var(--haze-color-border));

  &:focus-within {
    border-color: var(--haze-color-danger);
    box-shadow: 0 0 0 3px
      color-mix(in srgb, var(--haze-color-danger) 25%, transparent);
  }
`;

export const textarea = css`
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--haze-color-text);
  font-family: var(--haze-font-sans);
  font-size: 14px;
  line-height: 1.55;
  max-height: ${MAX_TEXTAREA_HEIGHT}px;
  overflow-y: auto;
  padding: 2px 0;
  caret-color: var(--haze-color-primary);

  &::placeholder {
    color: var(--haze-color-text-muted);
    opacity: 0.7;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

export const inputFooter = css`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--haze-color-text-muted);
`;

export const hint = css`
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 6px;
`;

export const kbd = css`
  font-family: var(--haze-font-mono);
  font-size: 11px;
  padding: 1px 6px;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: var(--haze-color-bg-muted);
  color: var(--haze-color-text-muted);
  box-shadow: 0 1px 0 var(--haze-color-border);
`;

export const charCount = css`
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--haze-color-text-muted);
  transition: color 0.2s;

  &[data-warn='true'] {
    color: var(--haze-color-warning);
  }

  &[data-danger='true'] {
    color: var(--haze-color-danger);
    font-weight: 500;
  }
`;

export const sendBtn = css`
  flex-shrink: 0;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

  &:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 2px 8px rgba(88, 166, 255, 0.25);
  }

  &:active:not(:disabled) {
    transform: translateY(0);
  }
`;

export const sendBtnStreaming = css`
  background: var(--haze-color-bg-muted);
  color: var(--haze-color-text-secondary);
  border-color: var(--haze-color-border);
`;

// ---------------------------------------------------------------------------
// Slash command menu (§3.8)
// ---------------------------------------------------------------------------

export const slashMenu = css`
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  right: 0;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 10px;
  box-shadow:
    0 4px 24px rgba(0, 0, 0, 0.12),
    0 0 0 1px var(--haze-color-border);
  max-height: 260px;
  overflow-y: auto;
  z-index: 50;
  padding: 4px;
  animation: slashMenuSlideIn 0.12s ease-out;

  @keyframes slashMenuSlideIn {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

export const slashMenuItem = css`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.08s;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  font-family: var(--haze-font-sans);
  font-size: 13px;
  color: var(--haze-color-text);

  &:hover,
  &[data-active='true'] {
    background: var(--haze-color-bg-muted);
  }
`;

export const slashMenuName = css`
  font-weight: 600;
  font-family: var(--haze-font-mono);
  font-size: 13px;
  color: var(--haze-color-primary);
  min-width: 72px;
`;

export const slashMenuDesc = css`
  font-size: 12px;
  color: var(--haze-color-text-muted);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

export const slashMenuEmpty = css`
  padding: 12px 16px;
  text-align: center;
  font-size: 12px;
  color: var(--haze-color-text-muted);
`;

// ---------------------------------------------------------------------------
// Responsive — mobile only
// ---------------------------------------------------------------------------

export const mobileHidden = css`
  @media (max-width: 768px) {
    display: none !important;
  }
`;

export const bottomTabBar = css`
  display: none;

  @media (max-width: 768px) {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 56px;
    background: var(--haze-color-bg);
    border-top: 1px solid var(--haze-color-border);
    z-index: 100;
    align-items: center;
    justify-content: space-around;
    padding-bottom: env(safe-area-inset-bottom, 0);
    box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.15);
  }
`;

export const bottomTab = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--haze-color-text-muted);
  font-size: 11px;
  cursor: pointer;
  transition: color 0.2s;
  border-radius: 8px;
  font-family: var(--haze-font-sans);

  &:hover {
    color: var(--haze-color-text-secondary);
  }
`;

export const bottomTabActive = css`
  color: var(--haze-color-primary);

  &:hover {
    color: var(--haze-color-primary);
  }
`;

export const mobileFullContent = css`
  display: none;

  @media (max-width: 768px) {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
  }
`;
