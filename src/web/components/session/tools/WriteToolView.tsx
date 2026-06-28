import { css } from '@linaria/core'
import { FileCodeBlock } from './FileCodeBlock.js'

const title = css`
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 2px;
`

const name = css`
  color: var(--text);
  font-weight: 500;
`

type WriteInput = { path: string; content: string }

export function WriteToolView({ input }: { input: WriteInput }) {
  const path = input?.path ?? ''
  const content = input?.content ?? ''
  return (
    <div>
      <div className={title} data-testid="tool-title">
        <span className={name}>write</span>
      </div>
      <div className={title} data-testid="file-name">
        {path}
      </div>
      <FileCodeBlock path={path} content={content} />
    </div>
  )
}