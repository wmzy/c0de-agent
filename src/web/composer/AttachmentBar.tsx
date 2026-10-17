import { css } from '@linaria/core'
import type { ImagePart } from '@/composer/types.js'

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
  border: 1px solid var(--haze-color-border);
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
  /* 命中区 24×24（WCAG 2.5.8）：此前 18×18，且没复位 global.ts 给裸按钮的
     padding 8px 12px——内容区被挤成 0，12px 的 × 从圆形底里溢出来。 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  border: none;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;

  /*
   * hover 必须与 global.ts 的规则同形状（:where(button):hover:not(:disabled)
   * :not([aria-disabled])，特异度 0,3,0）：裸类的 &:hover 只有 0,2,0，会被那条
   * 中性兜底压掉。兜底值 color-mix(bg-subtle 80%, text 8%) 的两段百分比只加到
   * 88%，落成半透明近白底——鼠标恰停在这颗 × 上的那一刻，白字 × 彻底消失
   * （实测 1.28:1）。同仓 TerminalPanel/PaneSplitContainer/Terminal 的破坏性
   * 按钮已是这个口径，这里此前漏了。
   */
  &:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--haze-color-danger);
    color: var(--c0de-danger-on-solid, #fff);
  }
`

const warning = css`
  width: 100%;
  font-size: 12px;
  color: var(--haze-color-danger, #e5484d);
`

/** L1：图片体积/成本提示——贴图直接计入 token，大图消耗显著，发送前明示。 */
const sizeHint = css`
  width: 100%;
  font-size: 12px;
  color: var(--haze-color-text-secondary);
`

const sizeHintHeavy = css`
  color: var(--haze-color-warning);
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
