import { useEffect, useState } from 'react'
import { renderMarkdown } from '../utils/markdown.js'

export function Markdown({ content }: { content: string }) {
  const [html, setHtml] = useState('')
  useEffect(() => {
    void renderMarkdown(content).then(setHtml)
  }, [content])
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Markdown-rendered safe HTML */}
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </>
  )
}
