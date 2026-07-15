import { memo, useEffect, useState } from 'react'
import { renderMarkdown } from '../utils/markdown.js'

const mdCache = new Map<string, string>()

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const [html, setHtml] = useState('')
  useEffect(() => {
    const cached = mdCache.get(content)
    if (cached !== undefined) {
      setHtml(cached)
      return
    }
    void renderMarkdown(content).then((rendered) => {
      mdCache.set(content, rendered)
      setHtml(rendered)
    })
  }, [content])
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown-rendered safe HTML */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </>
  )
})
