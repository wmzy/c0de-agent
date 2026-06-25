// PermissionDialog — tool permission confirmation dialog.
// Spec §10.4: show tool name, input params; confirm/deny buttons.
//
// Data + functions: stateless render + callback props.

import { css } from "@linaria/core";
import { Button, CodeBlock, Dialog } from "haze-ui";
import { useMemo } from "react";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const dialogBody = css`
  padding: 0;
`;

const toolHeader = css`
  padding: 16px 20px;
  border-bottom: 1px solid var(--haze-color-border);
  display: flex;
  align-items: center;
  gap: 12px;
`;

const toolIcon = css`
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: var(--haze-color-warning);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  flex-shrink: 0;
`;

const toolInfo = css`
  flex: 1;
`;

const toolName = css`
  font-size: 16px;
  font-weight: 600;
  color: var(--haze-color-text);
`;

const toolDesc = css`
  font-size: 13px;
  color: var(--haze-color-text-secondary);
  margin-top: 2px;
`;

const paramsSection = css`
  padding: 16px 20px;
`;

const paramsTitle = css`
  font-size: 13px;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
  margin-bottom: 8px;
`;

const paramsCode = css`
  max-height: 300px;
  overflow: auto;
  border-radius: 8px;
  font-size: 12px;
`;

const actions = css`
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--haze-color-border);
  justify-content: flex-end;
`;

const denyButton = css`
  min-width: 80px;
`;

const approveButton = css`
  min-width: 80px;
`;

// ---------------------------------------------------------------------------
// Tool descriptions (for common tools)
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTIONS: Record<string, string> = {
  read: "读取文件内容",
  edit: "修改文件内容",
  write: "创建/覆盖文件",
  bash: "执行终端命令",
  glob: "搜索文件路径",
  grep: "搜索文件内容",
  browser: "操作浏览器",
  task: "创建子代理",
  web_search: "网络搜索",
};

// ---------------------------------------------------------------------------
// Format input for display
// ---------------------------------------------------------------------------

function formatInput(input: unknown): string {
  if (input === null || input === undefined) return "(无参数)";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// ---------------------------------------------------------------------------
// Get tool display icon
// ---------------------------------------------------------------------------

function getToolIcon(tool: string): string {
  const icons: Record<string, string> = {
    read: "📖",
    edit: "✏️",
    write: "📝",
    bash: "💻",
    glob: "🔍",
    grep: "🔎",
    browser: "🌐",
    task: "🤖",
    web_search: "🌐",
  };
  return icons[tool] ?? "🔧";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export type PermissionDialogProps = {
  open: boolean;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
  onApprove: () => void;
  onDeny: () => void;
  onClose: () => void;
};

export function PermissionDialog({
  open,
  toolCallId,
  toolName,
  toolInput,
  onApprove,
  onDeny,
  onClose,
}: PermissionDialogProps) {
  const formattedInput = useMemo(() => formatInput(toolInput), [toolInput]);
  const description = TOOL_DESCRIPTIONS[toolName] ?? `执行工具: ${toolName}`;
  const icon = getToolIcon(toolName);

  return (
    <Dialog open={open} onClose={onClose}>
      <div className={dialogBody}>
        <div className={toolHeader}>
          <div className={toolIcon}>{icon}</div>
          <div className={toolInfo}>
            <div className={toolName}>{toolName}</div>
            <div className={toolDesc}>{description}</div>
          </div>
        </div>

        <div className={paramsSection}>
          <div className={paramsTitle}>调用参数</div>
          <div className={paramsCode}>
            <CodeBlock language="json">{formattedInput}</CodeBlock>
          </div>
        </div>

        <div className={actions}>
          <Button className={denyButton} variant="outline" onClick={onDeny}>
            拒绝
          </Button>
          <Button className={approveButton} variant="solid" onClick={onApprove}>
            允许执行
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
