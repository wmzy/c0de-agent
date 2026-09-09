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

/** L1：图片体积/成本提示——贴图直接计入 token，大图消耗显著，发送前明示。 */
const sizeHint = css`
  width: 100%;
  font-size: 12px;
  color: var(--text-secondary);
`

const sizeHintHeavy = css`
  color: var(--warning);
`

type Props = {
  images: ImagePart[]
  supportsVision: boolean
  onRemove: (idx: number) => void
}

function AttachmentBar(props: Props) {
  if (props.images.length === 0) return null
  // base64 解码后近似字节数（每 4 字符 ≈ 3 字节）。
  const totalBytes = props.images.reduce(
    (sum, img) => sum + Math.floor((img.data.length * 3) / 4),
    0,
  )
  const sizeMb = totalBytes / (1024 * 1024)
  const heavy = sizeMb >= 2
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
      <span
        className={`${sizeHint}${heavy ? ` ${sizeHintHeavy}` : ''}`}
        data-testid="image-size-hint"
      >
        {props.images.length} 张 · 约 {sizeMb >= 0.1 ? `${sizeMb.toFixed(1)} MB` : '< 0.1 MB'}
        {heavy ? '——大图会显著增加 token 消耗与成本' : '——图片按 token 计费，发送后计入用量'}
      </span>
    </div>
  )
}

export { AttachmentBar }
