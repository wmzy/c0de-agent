import { css } from '@linaria/core'
import type { ToolResult } from '@shared/types/tool.js'
import { CodeBlock } from '@/components/CodeBlock.js'
import { CollapsiblePre } from '@/components/session/tools/CollapsiblePre.js'
import { FallbackToolView } from '@/components/session/tools/FallbackToolView.js'
import { ToolError, toolErrorText } from '@/components/session/tools/toolError.js'
import { resultText, strArg } from '@/components/session/tools/toolShape.js'

/** bash 输出块与上方命令块的上间距（追加到 CollapsiblePre 的统一 pre 样式）。 */
const outGap = css`
  margin-top: 4px;
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

/** exit 标签：失败分支（exit code 从 error 文本解析）与成功分支（metadata.exitCode）
 *  共用同一渲染——exit code 是失败命令最可操作的信号（127 命令不存在、124 超时）。 */
function ExitTag({ exitCode }: { exitCode: number }) {
  return (
    <span className={`${exitCode === 0 ? exitOk : exitErr} ${exitTag}`} data-testid="bash-exit">
      exit {exitCode}
    </span>
  )
}

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
  // input 是原样落库的 JSON：模型把 command 写成对象/数组时（校验会把它转成一次
  // 失败的工具结果，但 raw 入参已经进了持久化消息），CodeBlock 收到非字符串会在
  // 渲染期抛错，ErrorBoundary 裹的是整个应用壳——这条会话从此打不开。命令读不
  // 出来就退回兜底视图：既不用空串冒充「跑了一条空命令」，也不把失败原因吞掉。
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
  // 命令块保留：用户首先要看清是哪个命令挂了。
  // 仍然渲染 bash-exit：exit code 是失败命令最可操作的信号（127 命令不存在、
  // 124 超时），错误文本里本就带着它，保留后失败态相比成功态只多一块危险色原因。
  if (toolErrorText(output, status) !== null) {
    const m = output?._tag === 'error' ? output.error.match(/exit code:?\s*(\d+)/i) : null
    const exitCode = m ? Number(m[1]) : null
    return (
      <div>
        {commandBlock}
        <ToolError output={output} status={status} />
        {exitCode !== null && status !== 'running' && <ExitTag exitCode={exitCode} />}
      </div>
    )
  }

  // 成功：output.output + metadata.exitCode（正文判定走 resultText 统一口径，
  // truncated 只是超限截断、正文照取；metadata 只有 success 才有）
  const outText = resultText(output)
  const exitCode =
    output?._tag === 'success' && typeof output.metadata?.exitCode === 'number'
      ? output.metadata.exitCode
      : null

  return (
    <div>
      {commandBlock}
      {outText && (
        <CollapsiblePre testId="bash-output" preClassName={outGap}>
          {outText}
        </CollapsiblePre>
      )}
      {exitCode !== null && status !== 'running' && <ExitTag exitCode={exitCode} />}
    </div>
  )
}
