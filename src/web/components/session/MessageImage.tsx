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
import { useState } from 'react'

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

// 失败三段式与 FilePreview 的媒体失败态同口径（原因 + 逃生口 + 重试）。
const errorWrap = css`
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: min(320px, 100%);
  padding: 8px 10px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg-subtle);
  color: var(--haze-color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
`

const errorTitle = css`
  font-weight: 600;
  color: var(--haze-color-text);
`

const retryBtn = css`
  align-self: flex-start;
  margin-top: 2px;
  padding: 4px 10px;
  min-height: 24px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  font: inherit;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: color-mix(in srgb, var(--haze-color-bg-subtle) 80%, var(--haze-color-text) 8%);
  }
  &:disabled {
    opacity: 0.6;
    cursor: default;
  }
`

export function MessageImage({ mediaType, data }: { mediaType: string; data: string }) {
  // 此前裸 <img> 没有任何失败信号：图片解不出来时（导入的历史消息里 base64 截断、
  // mediaType 是浏览器不支持的格式、超大图在移动端解码失败）用户只看到一个浏览器的
  // 破图占位符——装饰列照画图片图标、时间线文本照显示「(图片)」，看起来「我发过
  // 一张图」，却既没有原因也没有任何补救动作。与 FilePreview 的媒体失败态同口径。
  const [failed, setFailed] = useState(false)
  // data URL 没有「可变化的地址」：重试只能靠重挂载重新解码一次（大图在内存吃紧的
  // 设备上解码会失败，重新解码有机会成功）。key 变化才是真正的重试，光改 React 状态
  // 浏览器不会重新解码。
  const [reloadKey, setReloadKey] = useState(0)

  if (failed) {
    return (
      <div className={errorWrap} role="alert" data-testid="message-image-error">
        <span className={errorTitle}>图片无法显示</span>
        <span>
          这条消息里的图片数据无法解码（{mediaType}）——可能是导入的历史消息中图片已损坏，
          或当前浏览器不支持该格式。
        </span>
        <button
          type="button"
          className={retryBtn}
          onClick={() => {
            setFailed(false)
            setReloadKey((k) => k + 1)
          }}
          data-testid="message-image-retry"
        >
          重试
        </button>
      </div>
    )
  }

  return (
    <img
      key={reloadKey}
      className={thumb}
      src={`data:${mediaType};base64,${data}`}
      alt="消息中的图片"
      // 长会话里图片可能很多：视口外的不解码，避免一次性解码大量 base64
      loading="lazy"
      onError={() => setFailed(true)}
      data-testid="message-image"
    />
  )
}
