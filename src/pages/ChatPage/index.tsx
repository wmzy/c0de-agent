// ChatPage — main chat interface integrating all §10 components.
// Spec §10.4: left sidebar (session list + branch tree + file browser),
// right panel (message stream + input), permission dialog overlay.
//
// This file is the thin shell: state management + layout composition.
// Sub-components live in sibling files under ChatPage/.

import { cx } from "@linaria/core";
import {
  Button,
  ChatContainer,
  Drawer,
  Segmented,
  Spinner,
} from "haze-ui";
import { useCallback, useMemo, useState } from "react";
import { BranchTree } from "../../components/BranchTree";
import { FileBrowser } from "../../components/FileBrowser";
import { LLMDetails } from "../../components/LLMDetails";
import { PermissionDialog } from "../../components/PermissionDialog";
import { type ChatState, useChat } from "../../hooks/useChat";
import { useSession } from "../../hooks/useSession";
import { useSessionPreviews } from "../../hooks/useSessionPreviews";
import { getTextContent } from "./helpers";
import { ChatInputArea } from "./ChatInput";
import { EmptyState, MessageBubble, StreamingAssistantBlock } from "./EmptyState";
import {
  bottomTab,
  bottomTabActive,
  bottomTabBar,
  chatArea,
  collapseBtn,
  emptyChat,
  emptyChatHint,
  emptyChatTitle,
  errorBanner,
  errorMessage,
  mainArea,
  mobileFullContent,
  mobileHidden,
  mobileMenuBtn,
  messagesContainer,
  page,
  sidebar,
  sidebarCollapsed as sidebarCollapsedStyle,
  sidebarTabs,
  sidebarToggle,
  sidebarWrapper,
  tabContent,
  topBar,
  topBarMeta,
  topBarTitle,
} from "./styles";

// ---------------------------------------------------------------------------
// ChatPage component
// ---------------------------------------------------------------------------

export default function ChatPage() {
  const { sessions, activeSessionId, setActiveSession, createNewSession, fork } = useSession();
  const chat = useChat(activeSessionId ?? "");
  const {
    messages,
    isStreaming,
    error,
    permissionRequest,
    sendMessage,
    abort,
    retry,
    approveTool,
    denyTool,
    clearPermission,
  } = chat;

  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"sessions" | "files" | "llm">("sessions");
  const [inputDraft, setInputDraft] = useState<string | undefined>(undefined);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileTab, setMobileTab] = useState<"chat" | "sessions" | "files" | "llm">("chat");

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const { previews } = useSessionPreviews(sessions);

  const handleChipSelect = useCallback((prompt: string) => {
    setInputDraft(prompt);
  }, []);

  const handleDraftConsumed = useCallback(() => {
    setInputDraft(undefined);
  }, []);

  const handleNewSession = useCallback(async () => {
    await createNewSession();
    setShowMobileSidebar(false);
    setMobileTab("chat");
  }, [createNewSession]);

  const handleSelectSession = useCallback(
    (id: string) => {
      setActiveSession(id);
      setShowMobileSidebar(false);
      setMobileTab("chat");
    },
    [setActiveSession],
  );

  const handleFork = useCallback(
    async (sessionId: string, branchPoint: number) => {
      await fork(sessionId, branchPoint);
    },
    [fork],
  );

  const handleReferenceFile = useCallback(
    (filePath: string) => {
      const ref = `\n\n参考文件: \`${filePath}\`\n\n`;
      setInputDraft((prev) => (prev ?? "") + ref);
    },
    [],
  );

  // Sidebar content shared between desktop and mobile
  const sidebarContent = useMemo(
    () => (
      <div className={sidebarTabs}>
        <div style={{ padding: "8px" }}>
          <Segmented
            value={sidebarTab}
            onChange={(v: string) => setSidebarTab(v as "sessions" | "files" | "llm")}
            options={[
              { label: "会话", value: "sessions" },
              { label: "文件", value: "files" },
              { label: "LLM", value: "llm" },
            ]}
          />
        </div>

        {sidebarTab === "sessions" && (
          <div key="tab-sessions" className={tabContent}>
            <div style={{ padding: "8px 12px" }}>
              <Button
                variant="solid"
                size="sm"
                onClick={handleNewSession}
                style={{ width: "100%" }}
              >
                + 新建会话
              </Button>
            </div>
            <div style={{ flex: 1, overflow: "hidden" }}>
              <BranchTree
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelectSession={handleSelectSession}
                onFork={handleFork}
                previews={previews}
              />
            </div>
          </div>
        )}

        {sidebarTab === "files" && (
          <div key="tab-files" className={tabContent}>
            <FileBrowser onReferenceFile={handleReferenceFile} />
          </div>
        )}

        {sidebarTab === "llm" && (
          <div key="tab-llm" className={tabContent}>
            <LLMDetails details={[]} />
          </div>
        )}
      </div>
    ),
    [sidebarTab, handleNewSession, sessions, activeSessionId, handleSelectSession, handleFork, previews, handleReferenceFile],
  );

  const showEmpty = messages.length === 0 && !isStreaming;

  return (
    <div className={page}>
      {/* Desktop sidebar */}
      <div className={sidebarWrapper}>
        <div className={`${sidebar} ${sidebarCollapsed ? sidebarCollapsedStyle : ""}`}>
          {sidebarContent}
        </div>
        <button
          type="button"
          className={`${sidebarToggle} ${collapseBtn}`}
          onClick={() => setSidebarCollapsed((prev) => !prev)}
          aria-label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
          title={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: sidebarCollapsed ? "rotate(180deg)" : "none",
              transition: "transform 0.2s ease",
            }}
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>

      {/* Mobile sidebar drawer */}
      <Drawer open={showMobileSidebar} onClose={() => setShowMobileSidebar(false)} placement="left">
        {sidebarContent}
      </Drawer>

      {/* Mobile full-screen sidebar content (bottom tab navigation) */}
      {mobileTab !== "chat" && (
        <div className={mobileFullContent}>
          <div className={topBar}>
            <span className={topBarTitle}>
              {mobileTab === "sessions" ? "会话" : mobileTab === "files" ? "文件" : "LLM"}
            </span>
          </div>
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div className={sidebarTabs}>
              {mobileTab === "sessions" && (
                <div className={tabContent}>
                  <div style={{ padding: "8px 12px" }}>
                    <Button variant="solid" size="sm" onClick={handleNewSession} style={{ width: "100%" }}>
                      + 新建会话
                    </Button>
                  </div>
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <BranchTree
                      sessions={sessions}
                      activeSessionId={activeSessionId}
                      onSelectSession={handleSelectSession}
                      onFork={handleFork}
                      previews={previews}
                    />
                  </div>
                </div>
              )}
              {mobileTab === "files" && (
                <div className={tabContent}>
                  <FileBrowser onReferenceFile={handleReferenceFile} />
                </div>
              )}
              {mobileTab === "llm" && (
                <div className={tabContent}>
                  <LLMDetails details={[]} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main chat area */}
      <div className={cx(mainArea, mobileTab !== "chat" ? mobileHidden : "")}>
        {/* Top bar */}
        <div className={topBar}>
          <Button
            className={`${mobileMenuBtn}`}
            variant="ghost"
            size="sm"
            onClick={() => setShowMobileSidebar(true)}
            aria-label="打开侧栏"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
          </Button>
          <Button
            className={collapseBtn}
            variant="ghost"
            size="sm"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
            aria-label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
            style={{ padding: "4px" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: sidebarCollapsed ? "rotate(180deg)" : "none", transition: "transform 0.2s ease" }}><path d="M15 18l-6-6 6-6" /></svg>
          </Button>
          <span className={topBarTitle}>{activeSession?.title ?? "新会话"}</span>
          {isStreaming ? (
            <span className={topBarMeta}>
              <Spinner size="sm" />
              回复中…
            </span>
          ) : null}
        </div>

        {/* Messages */}
        <div className={chatArea}>
          <ChatContainer autoScroll className={messagesContainer}>
            {showEmpty ? (
              <EmptyState onChipSelect={handleChipSelect} />
            ) : (
              <>
                {messages.map((msg) => {
                  const text = getTextContent(msg.content);
                  const isOptimistic = msg.id.startsWith("temp-");
                  const status: "sending" | "sent" | "error" | undefined = isOptimistic
                    ? isStreaming
                      ? "sending"
                      : "sent"
                    : undefined;
                  return (
                    <MessageBubble
                      key={msg.id}
                      role={
                        msg.role === "user"
                          ? "user"
                          : msg.role === "system"
                            ? "system"
                            : "assistant"
                      }
                      text={text}
                      timestamp={msg.createdAt}
                      status={status}
                      toolCalls={msg.toolCalls}
                    />
                  );
                })}

                <StreamingAssistantBlock chat={chat} />
              </>
            )}

            {error ? (
              <div className={errorBanner} role="alert">
                <span className={errorMessage}>{error}</span>
                <Button size="sm" variant="outline" onClick={retry} disabled={isStreaming}>
                  重试
                </Button>
                <Button size="sm" variant="ghost" onClick={abort} aria-label="关闭错误">
                  ✕
                </Button>
              </div>
            ) : null}
          </ChatContainer>

          <ChatInputArea
            disabled={isStreaming}
            onSend={sendMessage}
            onAbort={abort}
            initialDraft={inputDraft}
            onDraftConsumed={handleDraftConsumed}
          />
        </div>
      </div>

      {/* Mobile bottom tab bar */}
      <nav className={bottomTabBar} aria-label="Mobile navigation">
        <button
          type="button"
          className={cx(bottomTab, mobileTab === "chat" && bottomTabActive)}
          onClick={() => setMobileTab("chat")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>对话</span>
        </button>
        <button
          type="button"
          className={cx(bottomTab, mobileTab === "sessions" && bottomTabActive)}
          onClick={() => setMobileTab("sessions")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span>会话</span>
        </button>
        <button
          type="button"
          className={cx(bottomTab, mobileTab === "files" && bottomTabActive)}
          onClick={() => setMobileTab("files")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span>文件</span>
        </button>
        <button
          type="button"
          className={cx(bottomTab, mobileTab === "llm" && bottomTabActive)}
          onClick={() => setMobileTab("llm")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>设置</span>
        </button>
      </nav>

      {/* Permission dialog overlay */}
      {permissionRequest ? (
        <PermissionDialog
          open={!!permissionRequest}
          toolCallId={permissionRequest.toolCallId}
          toolName={permissionRequest.tool}
          toolInput={permissionRequest.input}
          onApprove={() => approveTool(permissionRequest.toolCallId, true)}
          onDeny={() => denyTool(permissionRequest.toolCallId)}
          onClose={clearPermission}
        />
      ) : null}
    </div>
  );
}
