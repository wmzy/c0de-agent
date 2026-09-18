// 内容 diff 视图：haze DiffViewer 渲染行级差异（行号 + +/- 符号 + 语义底色），
// 外层保留项目的展开/收起（useOverflow 200px）与 testid 契约。
import { css } from '@linaria/core'
import { DiffViewer } from 'haze-ui'
import { useOverflow } from '@/components/session/hooks/useOverflow.js'

const wrap = css`
  margin: 4px 0;
  border-radius: 6px;
  overflow: auto;
  font-size: 13px;
  max-height: 400px;
`

const collapsed = css`
  max-height: 200px;
  overflow: hidden;
`

const btn = css`
  font-size: 12px;
  color: var(--haze-color-primary);
  background: transparent;
  border: none;
  cursor: pointer;
`

export function ContentDiff({ oldText, newText }: { oldText: string; newText: string }) {
  // DiffViewer 按 '\n' 切行，行尾换行会多出一行空行——先行归一化。
  const stripTrailing = (s: string) => (s.endsWith('\n') ? s.slice(0, -1) : s)
  const { ref, overflowing, expanded, toggle } = useOverflow(200)
  const showToggle = overflowing && !expanded
  return (
    <div data-testid="diff-wrap">
      <div ref={ref} className={showToggle ? collapsed : ''}>
        <div className={wrap} data-testid="diff">
          <DiffViewer oldValue={stripTrailing(oldText)} newValue={stripTrailing(newText)} />
        </div>
      </div>
      {overflowing && (
        <button type="button" className={btn} onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}
