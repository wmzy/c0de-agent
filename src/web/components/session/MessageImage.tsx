// 会话消息里的图片（用户粘贴/拖入/选择的附件，服务端以 base64 存在 message.content 的
// image part 里）。
//
// 此前 normalizeParts 没有 image 分支：图片压根不渲染，纯图片消息在时间线上是一整行
// 空白（顶部滞留条显示「(空消息)」），图文消息只看到文字——用户自己发过什么在会话里
// 没有痕迹，只能靠记忆。
//
// 缩放规则：缩略图按容器宽度自适应、限高，避免一张大图把消息流撑到几屏；用
// object-fit: contain 而不是 cover，图片不被裁切（用户要确认发的是哪张图）。
import { css } from '@linaria/core'

const thumb = css`
  display: block;
  max-width: min(320px, 100%);
  max-height: 240px;
  width: auto;
  height: auto;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg-subtle);
  object-fit: contain;
`

export function MessageImage({ mediaType, data }: { mediaType: string; data: string }) {
  return (
    <img
      className={thumb}
      src={`data:${mediaType};base64,${data}`}
      alt="消息中的图片"
      // 长会话里图片可能很多：视口外的不解码，避免一次性解码大量 base64
      loading="lazy"
      data-testid="message-image"
    />
  )
}
