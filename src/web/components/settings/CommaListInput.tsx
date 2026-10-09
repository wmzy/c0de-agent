import { useEffect, useState } from 'react'
import { SyncedInput } from '@/components/SyncedControls.js'

/** 解析分隔符连接的字符串数组（trim + 去空）。空格分隔时按任意空白切分。 */
function splitList(s: string, separator: string): string[] {
  return s
    .split(separator === ' ' ? /\s+/ : separator)
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * 分隔符列表输入（默认逗号，separator=" " 用于空格分隔的命令行参数）。
 *
 * 内部维护原始文本缓冲，仅在「外部 value 解析结果与缓冲不一致」时同步，
 * 避免 value={array.join(sep)} + onChange=parseList 在每次按键时抹掉
 * 用户正在输入的分隔符：输入 "read," 会被 parse→join 还原成 "read"，
 * 导致逗号无法输入，最终保存时字段被清空（refresh 后恢复原值的根因）。
 * 空格分隔时同理：输入 "npx -y " 的尾随空格会被还原，第二个参数根本输不进去。
 */
function CommaListInput({
  value,
  onCommit,
  separator = ',',
  placeholder,
  className,
  id,
  ariaLabel,
  disabled,
}: {
  value: string[]
  onCommit: (items: string[]) => void
  /** 元素分隔符；' ' 表示按空白切分并以空格回填。 */
  separator?: string
  placeholder?: string
  className?: string
  id?: string
  /** 可访问名称：读屏需要一个稳定的字段名（placeholder 只是视觉提示）。 */
  ariaLabel?: string
  disabled?: boolean
}) {
  const [text, setText] = useState(value.join(separator))
  const joined = value.join(separator)
  // 外部 value 变化（加载/导入/保存后刷新）时同步缓冲；
  // 解析结果一致则保留用户正在编辑的文本（含尾随分隔符）。
  useEffect(() => {
    setText((cur) => (splitList(cur, separator).join(separator) === joined ? cur : joined))
  }, [joined, separator])
  return (
    <SyncedInput
      id={id}
      aria-label={ariaLabel}
      className={className}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(v) => {
        setText(v)
        onCommit(splitList(v, separator))
      }}
    />
  )
}

export { CommaListInput }
