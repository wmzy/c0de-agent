import { css } from '@linaria/core'
import { useQuery } from '@tanstack/react-query'
import fuzzysort from 'fuzzysort'
import type { DragEvent, KeyboardEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { AtFilePopover } from '@/composer/AtFilePopover.js'
import { AttachmentBar } from '@/composer/AttachmentBar.js'
import { ComposerEditor } from '@/composer/ComposerEditor.js'
import { currentCursor } from '@/composer/editor-sync.js'
import { PermissionDock } from '@/composer/PermissionDock.js'
import { SlashPopover, SubcommandPopover } from '@/composer/SlashPopover.js'
import type { ComposerSendPayload } from '@/composer/types.js'
import {
  atTokenRange,
  extractAgentMentions,
  promptToText,
  replacePromptRange,
} from '@/composer/types.js'
import { useComposer } from '@/composer/useComposer.js'
import { WorkflowPopover } from '@/composer/WorkflowPopover.js'
import { useFileReferenceSetter } from '@/contexts/ReferenceContext.js'
import { useCommands } from '@/hooks/useCommands.js'
import { useFileSearch } from '@/hooks/useFiles.js'
import type { AgentListItem } from '@/services/agent.js'
import { workflowsAPI } from '@/services/workflows.js'
import { MOBILE } from '@/styles/breakpoints.js'
import { isImeComposing } from '@/utils/ime.js'

/**
 * 底栏容器。
 *
 * sticky bottom:0 而非普通流内元素：.haze-Workbench__editor 是本页唯一滚动
 * 容器（display:block，子元素按块级堆叠），聊天页的顶栏/消息流/权限条/输入框
 * 全部平铺在它内部。输入区可增长到 max-height:200px，多行输入时 wrap 高度
 * 会超过容器剩余空间——普通流下它被推到容器下沿之外，而容器此时已滚到底、
 * 没有更多可滚高度，用户既看不到也点不到「发送」：
 * 1440×900 实测输入区 190px 时「发送」按钮 top=962 / bottom=1001 全在视口
 * （900）之外，elementFromPoint 命中的是 resize 把手；
 * 375×667 更严重（main scrollHeight=1222 vs clientHeight=591）。
 *
 * 固定在容器底部后，输入区增长只压缩上方消息流的可视高度，发送按钮恒在
 * 视口内可达；未溢出时 sticky 元素停在自然位置，布局与此前完全一致。
 * z-index 高于消息流，避免长输入时压住最后一条消息。
 */
const wrap = css`
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
`

const editorRow = css`
  position: relative;
  display: flex;
  gap: 8px;
  padding: 12px;
  ${MOBILE} {
    /* 窄屏：输入区独占一行（宽度=视口-padding），按钮换行到第二行平分 */
    flex-wrap: wrap;
    & > button {
      flex: 1;
    }
  }
`

const sendBtn = css`
  align-self: flex-end;
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--haze-color-primary);
  color: #fff;
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
  &:hover:not(:disabled) {
    background: var(--haze-color-primary-hover);
  }
  &:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--haze-color-primary) 50%, transparent);
  }
  &:disabled {
    color: var(--haze-color-text-muted);
    background: var(--haze-color-bg-muted);
    cursor: not-allowed;
  }
`

const appendBtn = css`
  align-self: flex-end;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--haze-color-border);
  background: transparent;
  color: var(--haze-color-text);
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
  &:hover:not(:disabled) {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
  &:focus-visible {
    outline: none;
    border-color: var(--haze-color-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--haze-color-primary) 50%, transparent);
  }
  &:disabled {
    color: var(--haze-color-text-muted);
    background: var(--haze-color-bg-muted);
    cursor: not-allowed;
  }
`

const stopBtn = css`
  align-self: flex-end;
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--haze-color-danger);
  color: #fff;
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
`

const dragOverlay = css`
  position: absolute;
  inset: 0;
  background: rgba(74, 158, 255, 0.12);
  border: 2px dashed var(--haze-color-primary, #4a9eff);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--haze-color-primary, #4a9eff);
  font-size: 14px;
  pointer-events: none;
  z-index: 20;
`

// display:contents 让承载 aria-label 的包装层不占用 editorRow 的 flex 槽位（否则会多出 gap 间距）
const popoverGroup = css`
  display: contents;
`

type SendPayload = ComposerSendPayload & {
  agents: string[]
}

type ComposerProps = {
  onSend: (payload: SendPayload) => void
  onAbort?: () => void
  /** 流式态「追加指令」注入 steering 文本。 */
  onSteer?: (message: string) => void
  isStreaming: boolean
  hasHistory: boolean
  supportsVision?: boolean
  permission?: { tool: string; input: unknown } | null
  /** 允许「本会话始终允许」勾选（会话级 dock 为 true，草稿页无会话概念为 false）。 */
  permissionAllowAlways?: boolean
  onPermissionConfirm?: (alwaysAllow: boolean) => void
  onPermissionCancel?: () => void
  /** 当前项目 id（用于 @ 文件提及按项目 worktree 搜索）。 */
  projectId?: string
  /** 可用 agent 列表（@ mention 渲染与校验）。 */
  agents: AgentListItem[]
}

function Composer(props: ComposerProps) {
  // 从 Prompt 结构提取 @agent mentions（仅非 primary 可调用的 subagent）。
  // 只扫描用户输入的文本 part 并剥离 markdown 代码（见 extractAgentMentions）——
  // 此前对平铺消息文本整体正则：snippet/terminal 展开的代码块、用户手写的
  // ``` 示例里出现 agent 名即被当成提及，服务端据此注入「用户要求派发 subagent」
  // 指令，运行被误导去派发子 agent（隔离 worktree + 独立 session + 额外成本）。
  const handleSend = (payload: ComposerSendPayload) => {
    const subagentNames = props.agents.filter((a) => a.mode !== 'primary').map((a) => a.name)
    const agents = extractAgentMentions(payload.prompt, subagentNames)
    props.onSend({ ...payload, agents })
  }
  const { data: commands = [] } = useCommands()
  const composer = useComposer({
    onSend: handleSend,
    onAbort: props.onAbort,
    onSteer: props.onSteer,
    isStreaming: props.isStreaming,
    hasHistory: props.hasHistory,
    commands,
  })
  const fileSearch = useFileSearch(composer.popoverQuery, props.projectId)

  // 工作流列表：传入 projectId 以发现项目级 .c0de/workflows/*.js。
  // queryKey 含 projectId 确保切换项目时重新拉取。
  const { data: workflows = [] } = useQuery({
    queryKey: ['workflows', props.projectId],
    queryFn: () => workflowsAPI.list(props.projectId),
    staleTime: Infinity,
    select: (data) => data.workflows,
  })

  // slash 命令按 query 过滤——过滤必须与键盘导航/选择使用同一列表，
  // 否则 activeIndex 指向的项与 popover 展示的项不一致（选中错误命令）。
  const filteredCommands = useMemo(() => {
    if (!composer.popoverQuery) return commands
    return fuzzysort.go(composer.popoverQuery, commands, { key: 'name' }).map((r) => r.obj)
  }, [composer.popoverQuery, commands])

  // /workflow (run|show|create|edit) <name> 补全：按 name 过滤工作流列表
  const filteredWorkflows = useMemo(() => {
    if (!composer.popoverQuery) return workflows
    return fuzzysort.go(composer.popoverQuery, workflows, { key: 'name' }).map((r) => r.obj)
  }, [composer.popoverQuery, workflows])

  // 子命令补全：从当前命令的 subcommands 按 query 过滤
  const filteredSubcommands = useMemo(() => {
    const cmd = commands.find((c) => c.name === composer.subcommandCmd)
    if (!cmd?.subcommands) return []
    if (!composer.popoverQuery) return cmd.subcommands
    const lower = composer.popoverQuery.toLowerCase()
    return cmd.subcommands.filter((s) => s.name.toLowerCase().startsWith(lower))
  }, [commands, composer.subcommandCmd, composer.popoverQuery])

  // 注册文件引用 API，供文件树/预览面板跨组件调用
  const setFileReferenceApi = useFileReferenceSetter()
  useEffect(() => {
    setFileReferenceApi({
      insertFileReference: composer.appendFileReference,
      insertSnippetReference: composer.appendSnippetReference,
      insertTerminalReference: composer.appendTerminalReference,
      insertPromptText: composer.insertPromptText,
    })
    return () => setFileReferenceApi(null)
  }, [
    composer.appendFileReference,
    composer.appendSnippetReference,
    composer.appendTerminalReference,
    composer.insertPromptText,
    setFileReferenceApi,
  ])

  const [slashActive, setSlashActive] = useState(0)
  const [atActive, setAtActive] = useState(0)
  const [workflowActive, setWorkflowActive] = useState(0)
  const [subcommandActive, setSubcommandActive] = useState(0)
  const [isDragging, setIsDragging] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: query 变化时重置选中项到顶部
  useEffect(() => {
    if (composer.popover === 'slash') setSlashActive(0)
  }, [composer.popover, composer.popoverQuery])
  // biome-ignore lint/correctness/useExhaustiveDependencies: query 变化时重置选中项到顶部
  useEffect(() => {
    if (composer.popover === 'at') setAtActive(0)
  }, [composer.popover, composer.popoverQuery])
  // biome-ignore lint/correctness/useExhaustiveDependencies: query 变化时重置选中项到顶部
  useEffect(() => {
    if (composer.popover === 'workflow') setWorkflowActive(0)
  }, [composer.popover, composer.popoverQuery])
  // biome-ignore lint/correctness/useExhaustiveDependencies: query 变化时重置选中项到顶部
  useEffect(() => {
    if (composer.popover === 'subcommand') setSubcommandActive(0)
  }, [composer.popover, composer.popoverQuery])

  // @ mention 候选：subagent（非 primary）按 query 过滤
  const atSubagents = props.agents
    .filter((a) => a.mode !== 'primary')
    .filter((a) => !composer.popoverQuery || a.name.includes(composer.popoverQuery))
    .slice(0, 5)
  const atFiles = (fileSearch.data ?? []).filter((r) => r.type === 'file')

  // 选中 @agent：把光标前的 @query token 原位替换为 @name 文本。
  // 此前从 promptToText 平铺文本重建整个 prompt——既有 file/snippet/terminal
  // pill 被降级为纯文本（发送时 files 附件丢失）。改为 atTokenRange 定位 +
  // replacePromptRange 原位替换，范围外 part 原样保留。
  const insertAgentToken = (name: string) => {
    const prompt = composer.promptRef.current
    const editor = composer.editorRef.current
    if (!editor) return
    const cursor = currentCursor(editor)
    const range = atTokenRange(promptToText(prompt), cursor)
    if (!range) return
    const token = `@${name} `
    composer.setPromptExternal(
      replacePromptRange(prompt, range.start, range.end, [
        { type: 'text', content: token, start: 0, end: token.length },
      ]),
      true,
    )
    composer.setPopover(null)
    editor.focus()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    // IME 组合中不拦截：回车确认候选词/ESC 取消候选/方向键选候选由输入法处理。
    // popover 分支在 composer.handleKeyDown（内部查 composingRef）之前执行，
    // 不判定就会把未确认的候选当最终输入：回车直接插入斜杠命令/子命令/工作流名
    // 或选中 @ 候选，用户正在组合的内容被替换掉。
    if (isImeComposing(e)) return
    if (composer.popover === 'workflow') {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setWorkflowActive((i) => Math.min(i + 1, filteredWorkflows.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setWorkflowActive((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const wf = filteredWorkflows[workflowActive]
        if (wf) composer.insertWorkflow(wf.name)
        return
      }
    }
    if (composer.popover === 'slash') {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashActive((i) => Math.min(i + 1, filteredCommands.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashActive((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const cmd = filteredCommands[slashActive]
        if (cmd) composer.insertSlash(cmd.name)
        return
      }
    }
    if (composer.popover === 'subcommand') {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSubcommandActive((i) => Math.min(i + 1, filteredSubcommands.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSubcommandActive((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const sub = filteredSubcommands[subcommandActive]
        if (sub) composer.insertSubcommand(sub.name)
        return
      }
    }
    if (composer.popover === 'at') {
      const total = atSubagents.length + atFiles.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAtActive((i) => Math.min(i + 1, total - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAtActive((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (atActive < atSubagents.length) {
          const a = atSubagents[atActive]
          if (a) insertAgentToken(a.name)
        } else {
          const f = atFiles[atActive - atSubagents.length]
          if (f) composer.insertFile(f.path)
        }
        return
      }
    }
    composer.handleKeyDown(e)
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const dropped = Array.from(e.dataTransfer.files)
    const hasImage = dropped.some((f) => f.type.startsWith('image/'))
    for (const f of dropped) {
      if (f.type.startsWith('image/')) composer.addImage(f)
    }
    if (!hasImage) {
      const text = e.dataTransfer.getData('text/plain')
      if (text) document.execCommand('insertText', false, text)
    }
  }

  const sendLabel = props.isStreaming ? '终止' : '发送'

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: composer 拖放区，容器需捕获 drag/drop 事件
    <div
      className={wrap}
      onDragOver={(e) => {
        e.preventDefault()
        if (!isDragging) setIsDragging(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        setIsDragging(false)
      }}
      onDrop={handleDrop}
    >
      {isDragging && <div className={dragOverlay}>拖放图片或文本到此处</div>}
      {props.permission && props.onPermissionConfirm && props.onPermissionCancel && (
        <PermissionDock
          tool={props.permission.tool}
          input={props.permission.input}
          allowAlways={props.permissionAllowAlways ?? false}
          onConfirm={props.onPermissionConfirm}
          onCancel={props.onPermissionCancel}
        />
      )}
      <AttachmentBar
        images={composer.images}
        supportsVision={props.supportsVision ?? true}
        onRemove={composer.removeImage}
      />
      {composer.imageError && (
        <div
          className={css`
            padding: 4px 12px 0;
            font-size: 12px;
            color: var(--haze-color-danger);
          `}
          data-testid="image-error"
        >
          {composer.imageError}
        </div>
      )}
      <div className={editorRow}>
        {composer.popover === 'slash' && (
          // biome-ignore lint/a11y/useSemanticElements: role="group" 仅承载可访问名称，fieldset 不适用于绝对定位浮层
          <div className={popoverGroup} role="group" aria-label="斜杠命令">
            <SlashPopover
              commands={filteredCommands}
              activeIndex={slashActive}
              onSelect={(name) => composer.insertSlash(name)}
            />
          </div>
        )}
        {composer.popover === 'subcommand' && composer.subcommandCmd && (
          // biome-ignore lint/a11y/useSemanticElements: role="group" 仅承载可访问名称，fieldset 不适用于绝对定位浮层
          <div className={popoverGroup} role="group" aria-label="子命令">
            <SubcommandPopover
              subcommands={filteredSubcommands}
              activeIndex={subcommandActive}
              onSelect={(name) => composer.insertSubcommand(name)}
              parentCommand={composer.subcommandCmd}
            />
          </div>
        )}
        {composer.popover === 'workflow' && (
          // biome-ignore lint/a11y/useSemanticElements: role="group" 仅承载可访问名称，fieldset 不适用于绝对定位浮层
          <div className={popoverGroup} role="group" aria-label="工作流">
            <WorkflowPopover
              workflows={filteredWorkflows}
              activeIndex={workflowActive}
              onSelect={(name) => composer.insertWorkflow(name)}
            />
          </div>
        )}
        {composer.popover === 'at' && (
          // biome-ignore lint/a11y/useSemanticElements: role="group" 仅承载可访问名称，fieldset 不适用于绝对定位浮层
          <div className={popoverGroup} role="group" aria-label="文件与提及">
            <AtFilePopover
              results={fileSearch.data ?? []}
              activeIndex={atActive}
              onSelect={(path) => composer.insertFile(path)}
              agents={props.agents}
              query={composer.popoverQuery}
              activeAgentIndex={atActive}
              onAgentSelect={insertAgentToken}
            />
          </div>
        )}
        <ComposerEditor
          editorRef={composer.editorRef}
          composingRef={composer.composingRef}
          streaming={props.isStreaming}
          hasHistory={props.hasHistory}
          isEmpty={composer.isEmpty}
          onInput={composer.handleInput}
          onKeyDown={handleKeyDown}
          onPaste={composer.handlePaste}
        />
        <button
          className={appendBtn}
          onClick={composer.steer}
          type="button"
          disabled={!props.isStreaming}
          data-testid="append"
        >
          追加指令
        </button>
        <button
          className={props.isStreaming ? stopBtn : sendBtn}
          onClick={composer.send}
          type="button"
          aria-label={props.isStreaming ? '终止生成' : '发送消息'}
          data-testid="send"
          disabled={!props.isStreaming && composer.isEmpty && composer.images.length === 0}
        >
          {sendLabel}
        </button>
      </div>
    </div>
  )
}

export type { SendPayload }
export { Composer }
