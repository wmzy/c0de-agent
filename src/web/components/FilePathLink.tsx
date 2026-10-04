import { css } from '@linaria/core'
import { Tooltip } from 'haze-ui'
import { useFileSelection } from '@/contexts/FileSelectionContext.js'

const link = css`
  color: var(--haze-color-primary);
  background: transparent;
  border: none;
  padding: 0;
  font: inherit;
  cursor: pointer;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`

/** 可点击文件路径：点击后在右侧 panel 打开预览。 */
export function FilePathLink({ path }: { path: string }) {
  const { openFile } = useFileSelection()
  return (
    <Tooltip content={`预览 ${path}`}>
      <button
        type="button"
        className={link}
        onClick={() => openFile(path)}
        data-testid="filepath-link"
      >
        {path}
      </button>
    </Tooltip>
  )
}
