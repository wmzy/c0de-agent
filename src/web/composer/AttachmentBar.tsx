import { css } from '@linaria/core'
import type { ImagePart } from './types.js'

const bar = css`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px 0;
`

const thumb = css`
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--border);
  & img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
`

const removeBtn = css`
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  border: none;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
`

const warning = css`
  width: 100%;
  font-size: 12px;
  color: var(--danger, #e5484d);
`

type Props = {
  images: ImagePart[]
  supportsVision: boolean
  onRemove: (idx: number) => void
}

function AttachmentBar(props: Props) {
  if (props.images.length === 0) return null
  return (
    <div className={bar} data-testid="attachment-bar">
      {!props.supportsVision && <span className={warning}>当前模型不支持图片</span>}
      {props.images.map((img, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 图片附件无稳定 id，按索引作 key
        <div key={`img-${i}`} className={thumb}>
          <img src={`data:${img.mediaType};base64,${img.data}`} alt={`图片附件 ${i + 1}`} />
          <button
            className={removeBtn}
            onClick={() => props.onRemove(i)}
            type="button"
            aria-label="移除图片"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export { AttachmentBar }
