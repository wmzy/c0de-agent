import { useEffect, useState } from 'react'

/** 解析逗号分隔的字符串数组（trim + 去空）。 */
function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * 逗号分隔列表输入。
 *
 * 内部维护原始文本缓冲，仅在「外部 value 解析结果与缓冲不一致」时同步，
 * 避免 value={array.join(', ')} + onChange=parseList 在每次按键时抹掉
 * 用户正在输入的分隔符：输入 "read," 会被 parse→join 还原成 "read"，
 * 导致逗号无法输入，最终保存时字段被清空（refresh 后恢复原值的根因）。
 */
function CommaListInput({
  value,
  onCommit,
  placeholder,
  className,
  type,
  id,
}: {
  value: string[]
  onCommit: (items: string[]) => void
  placeholder?: string
  className?: string
  type?: string
  id?: string
}) {
  const [text, setText] = useState(value.join(', '))
  const joined = value.join(', ')
  // 外部 value 变化（加载/导入/保存后刷新）时同步缓冲；
  // 解析结果一致则保留用户正在编辑的文本（含尾随分隔符）。
  useEffect(() => {
    setText((cur) => (splitList(cur).join(', ') === joined ? cur : joined))
  }, [joined])
  return (
    <input
      id={id}
      type={type}
      className={className}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        onCommit(splitList(e.target.value))
      }}
    />
  )
}

export { CommaListInput }
