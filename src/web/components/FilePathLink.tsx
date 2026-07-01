import { css } from '@linaria/core'
import { useFileSelection } from '../contexts/FileSelectionContext.js'

const link = css`
  color: var(--primary);
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
    <button
      type="button"
      className={link}
      onClick={() => openFile(path)}
      title={`预览 ${path}`}
      data-testid="filepath-link"
    >
      {path}
    </button>
  )
}
