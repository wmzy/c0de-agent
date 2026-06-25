// ChatInput — controlled textarea with Shift+Enter, char count, send/abort.
// Slash command menu, voice input (mobile), and share API integration.

import { css, cx } from "@linaria/core";
import { Button } from "haze-ui";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type SlashCommandEntry, SLASH_COMMANDS, MAX_INPUT_CHARS } from "./helpers";
import {
  charCount,
  hint,
  inputArea,
  inputFooter,
  inputWrapper,
  inputWrapperDisabled,
  inputWrapperError,
  kbd,
  sendBtn,
  sendBtnStreaming,
  slashMenu,
  slashMenuDesc,
  slashMenuEmpty,
  slashMenuItem,
  slashMenuName,
  textarea,
} from "./styles";

// ---------------------------------------------------------------------------
// Chat input — controlled textarea with Shift+Enter, char count, send/abort
// ---------------------------------------------------------------------------

export function ChatInputArea({
  disabled,
  onSend,
  onAbort,
  initialDraft,
  onDraftConsumed,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  initialDraft?: string;
  onDraftConsumed?: () => void;
}) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);

  // Slash command menu — visible when input starts with '/'
  const slashQuery = value.startsWith("/") ? value.slice(1).trimEnd() : "";
  const slashMenuVisible = value.startsWith("/") && !value.includes("\n");
  const filteredCommands = useMemo(() => {
    if (!slashMenuVisible) return [];
    const q = slashQuery.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
  }, [slashMenuVisible, slashQuery]);

  // Apply external drafts (e.g. quick-action chips from the empty state)
  useEffect(() => {
    if (initialDraft !== undefined) {
      setValue(initialDraft);
      taRef.current?.focus();
      onDraftConsumed?.();
    }
  }, [initialDraft, onDraftConsumed]);

  const trimmed = value.trim();
  const canSend = trimmed.length > 0 && !disabled;
  const chars = value.length;
  const nearLimit = chars > MAX_INPUT_CHARS * 0.85;
  const overLimit = chars > MAX_INPUT_CHARS;

  // Reset slash menu selection when filtered list changes
  useEffect(() => {
    setSlashMenuIndex(0);
  }, [slashQuery]);

  // Auto-grow textarea up to MAX_TEXTAREA_HEIGHT.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ref-only effect; intentionally re-runs on value change
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    onSend(trimmed);
    setValue("");
  }, [canSend, onSend, trimmed]);

  // Select a slash command from the menu
  const handleSelectCommand = useCallback(
    (cmd: SlashCommandEntry) => {
      const insert = cmd.argsHint ? `/${cmd.name} ${cmd.argsHint} ` : `/${cmd.name} `;
      setValue(insert);
      setSlashMenuIndex(0);
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (el) {
          el.focus();
          const pos = insert.length;
          el.setSelectionRange(pos, pos);
        }
      });
    },
    [],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Slash menu keyboard navigation
      if (slashMenuVisible && filteredCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashMenuIndex((prev) => (prev + 1) % filteredCommands.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashMenuIndex((prev) =>
            prev <= 0 ? filteredCommands.length - 1 : prev - 1,
          );
          return;
        }
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          handleSelectCommand(filteredCommands[slashMenuIndex] ?? filteredCommands[0]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setValue("");
          setSlashMenuIndex(0);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [slashMenuVisible, filteredCommands, slashMenuIndex, handleSend, handleSelectCommand],
  );

  // Voice input (§10.3 Web Speech API)
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<any>(null);

  const toggleVoiceInput = useCallback(() => {
    const w = window as any;
    if (!w.SpeechRecognition && !w.webkitSpeechRecognition) {
      alert("您的浏览器不支持语音输入");
      return;
    }
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      return;
    }
    const SpeechRecognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((result: any) => result[0].transcript)
        .join("");
      setValue(transcript);
    };
    recognition.onend = () => setIsRecording(false);
    recognition.onerror = () => setIsRecording(false);
    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
  }, [isRecording, setValue]);

  // Share (§10.3 Web Share API)
  const handleShare = useCallback(() => {
    if (navigator.share && value) {
      navigator.share({ text: value });
    }
  }, [value]);

  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

  return (
    <div className={inputArea}>
      <div
        className={cx(
          inputWrapper,
          disabled && !value ? inputWrapperDisabled : "",
          overLimit ? inputWrapperError : "",
        )}
      >
        {slashMenuVisible && (
          <div className={slashMenu} role="listbox" aria-label="Slash commands">
            {filteredCommands.length === 0 ? (
              <div className={slashMenuEmpty}>没有匹配的命令</div>
            ) : (
              filteredCommands.map((cmd, idx) => (
                <button
                  key={cmd.name}
                  type="button"
                  className={slashMenuItem}
                  role="option"
                  data-active={String(idx === slashMenuIndex)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelectCommand(cmd);
                  }}
                  onMouseEnter={() => setSlashMenuIndex(idx)}
                >
                  <span className={slashMenuName}>/{cmd.name}</span>
                  <span className={slashMenuDesc}>{cmd.description}</span>
                  {cmd.argsHint ? (
                    <kbd className={kbd} style={{ fontSize: 10 }}>
                      {cmd.argsHint}
                    </kbd>
                  ) : null}
                </button>
              ))
            )}
          </div>
        )}
        <textarea
          ref={taRef}
          className={textarea}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? "正在生成回复…" : "输入消息…  Enter 发送, Shift+Enter 换行"}
          disabled={disabled && !value}
          rows={1}
          aria-label="Chat message"
        />
        <div className={inputFooter}>
          <span className={hint}>
            <kbd className={kbd}>Enter</kbd>
            发送
            <kbd className={kbd}>Shift</kbd>+<kbd className={kbd}>Enter</kbd>
            换行
          </span>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {isMobile && (
              <Button
                size="sm"
                variant="ghost"
                onClick={toggleVoiceInput}
                aria-label={isRecording ? "停止录音" : "语音输入"}
                style={{ color: isRecording ? "#ef4444" : undefined }}
              >
                {isRecording ? "⏹" : "🎤"}
              </Button>
            )}
            {isMobile && value && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleShare}
                aria-label="分享"
              >
                ↗
              </Button>
            )}
          </div>
          <span
            className={charCount}
            data-warn={String(nearLimit && !overLimit)}
            data-danger={String(overLimit)}
          >
            {chars} / {MAX_INPUT_CHARS}
          </span>
          {disabled ? (
            <Button
              size="sm"
              variant="outline"
              className={cx(sendBtn, sendBtnStreaming)}
              onClick={onAbort}
              aria-label="停止生成"
            >
              停止
            </Button>
          ) : (
            <Button
              size="sm"
              variant="solid"
              className={sendBtn}
              onClick={handleSend}
              disabled={!canSend || overLimit}
              aria-label="发送"
            >
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
