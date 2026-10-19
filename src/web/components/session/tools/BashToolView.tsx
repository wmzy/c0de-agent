import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { CodeBlock } from '@/components/CodeBlock.js'
import { useOverflow } from '@/components/session/hooks/useOverflow.js'
import { FallbackToolView } from '@/components/session/tools/FallbackToolView.js'
import { ToolError, toolErrorText } from '@/components/session/tools/toolError.js'
import { strArg } from '@/components/session/tools/toolShape.js'

const out = css`
  margin: 4px 0 0;
  padding: 8px;
  background: var(--haze-color-bg-muted);
  border-radius: 6px;
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: 400px;
`

const collapsed = css`
  max-height: 200px;
  /* 只限高不裁剪，超长输出会照样画到盒子之外：折叠态看起来没折叠，
     「展开」按钮被压在输出文字上，虚拟化行高（量的是这个盒子）也会
     小于实际绘制高度、让输出盖住下一条消息。同 FallbackToolView。 */
  overflow: hidden;
`

const btn = css`
  font-size: 12px;
  color: var(--haze-color-primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

const exitOk = css`
  font-size: 12px;
  color: var(--haze-color-success);
`
const exitErr = css`
  font-size: 12px;
  color: var(--haze-color-danger);
`

const exitTag = css`
  margin-left: 4px;
`

type BashInput = { command: string; cwd?: string; timeout?: number }

export function BashToolView({
  input,
  output,
  status,
}: {
  input: BashInput
  output?: ToolResult
  status: string
}) {
  const { ref, overflowing, expanded, toggle } = useOverflow(200)
  const showToggle = overflowing && !expanded

  // input 是原样落库的 JSON：模型把 command 写成对象/数组时（校验会把它转成一次
  // 失败的工具结果，但 raw 入参已经进了持久化消息），CodeBlock 收到非字符串会在
  // 渲染期抛错，ErrorBoundary 裹的是整个应用壳——这条会话从此打不开。命令读不
  // 出来就退回兜底视图：既不用空串冒充「跑了一条空命令」，也不把失败原因吞掉。
  // 位置在 useOverflow 之后：短路不能让 hook 数量随入参形状变化。
  const command = strArg(input, 'command')
  if (command.broken) {
    return <FallbackToolView tool="bash" input={input} output={output} status={status} />
  }
  const commandText = command.value ?? ''

  const commandBlock = (
    <div data-testid="bash-command">
      <CodeBlock code={commandText} lang="bash" />
    </div>
  )

  // 失败：原因必须走 ToolError 的危险色块，不能塞进与成功 stdout 同形的灰 <pre>——
  // 旧行为把 `Command failed with exit code: 127` 当成「输出」渲染，用户分不清它是
  // 命令的正常输出还是失败原因；error 为空白串时更是整块不渲染，只剩一个 ✗。
  // 短路必须放在 useOverflow 之后：status 由 running 变 error 时 hook 数量不能变。
  if (toolErrorText(output, status) !== null) {
    // 命令块保留：用户首先要看清是哪个命令挂了。
    // 仍然渲染 bash-exit：exit code 是失败命令最可操作的信号（127 命令不存在、
    // 124 超时），错误文本里本就带着它，保留后失败态相比成功态只多一块危险色原因。
    const m = output?._tag === 'error' ? output.error.match(/exit code:?\s*(\d+)/i) : null
    const exitCode = m ? Number(m[1]) : null
    return (
      <div>
        {commandBlock}
        <ToolError output={output} status={status} />
        {exitCode !== null && status !== 'running' && (
          <span
            className={`${exitCode === 0 ? exitOk : exitErr} ${exitTag}`}
            data-testid="bash-exit"
          >
            exit {exitCode}
          </span>
        )}
      </div>
    )
  }

  // 成功：output.output + metadata.exitCode
  let outText = ''
  let exitCode: number | null = null
  if (output?._tag === 'success') {
    outText = output.output
    exitCode = typeof output.metadata?.exitCode === 'number' ? output.metadata.exitCode : null
  } else if (output?._tag === 'truncated') {
    outText = output.output
  }

  return (
    <div>
      {commandBlock}
      {outText && (
        <div>
          <div ref={ref} className={showToggle ? collapsed : ''}>
            <pre data-testid="bash-output" className={out}>
              {outText}
            </pre>
          </div>
          {overflowing && (
            <button type="button" className={btn} onClick={toggle}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
      {exitCode !== null && status !== 'running' && (
        <span className={`${exitCode === 0 ? exitOk : exitErr} ${exitTag}`} data-testid="bash-exit">
          exit {exitCode}
        </span>
      )}
    </div>
  )
}
