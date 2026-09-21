import { memo, useEffect, useState } from 'react'
import { renderMarkdownCached } from '@/utils/markdown.js'

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const [html, setHtml] = useState('')
  useEffect(() => {
    // 竞态防护：流式渲染时 content 快速变化，旧渲染的 then 回调不得覆盖
    // 新内容——cleanup 置 cancelled 丢弃过期结果。缓存走 renderMarkdownCached
    // 的有界缓存（流式中间版本只保留最近 200 条，不再无界常驻）。
    let cancelled = false
    void renderMarkdownCached(content).then((rendered) => {
      if (!cancelled) setHtml(rendered)
    })
    return () => {
      cancelled = true
    }
  }, [content])
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown-rendered safe HTML */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </>
  )
})
