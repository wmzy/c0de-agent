import { css } from '@linaria/core'
import { memo, useEffect, useState } from 'react'
import { renderMarkdownCached } from '@/utils/markdown.js'

/**
 * Markdown 内容的排版样式（「prose」作用域）。
 *
 * 背景：全局 reset（* margin/padding: 0）清掉了全部元素间距，marked 输出
 * 的 h1-h6/p/ul/table/blockquote 此前零样式——段落互相紧贴、表格塌缩无边框、
 * 行内 code 与正文无从区分。本类是 Markdown 的唯一渲染容器，样式收敛于此。
 *
 * 尺寸一律用 em：本组件同时承载会话消息（14px 上下文）与文件预览（16px），
 * 相对尺寸在两个上下文中保持相同比例。
 */
const prose = css`
  max-width: 76ch; /* 行长约束（measure）：过长的行显著降低中文阅读速度 */

  /* 块级纵向节奏：相邻兄弟间距，首个子元素不带上边距（容器本身已留白） */
  & > * + * {
    margin-top: 0.65em;
  }

  & h1,
  & h2,
  & h3,
  & h4,
  & h5,
  & h6 {
    line-height: 1.35;
    font-weight: 600;
    margin-top: 1em;
    margin-bottom: 0; /* 节奏交给 * + * 与下一段落的间距接管 */
    color: var(--haze-color-text);
  }
  & > h1:first-child,
  & > h2:first-child,
  & > h3:first-child,
  & > h4:first-child,
  & > h5:first-child,
  & > h6:first-child {
    margin-top: 0;
  }
  & h1 {
    font-size: 1.45em;
  }
  & h2 {
    font-size: 1.25em;
    padding-bottom: 0.2em;
    border-bottom: 1px solid var(--haze-color-border);
  }
  & h3 {
    font-size: 1.1em;
  }

  & p {
    line-height: 1.7; /* CJK 正文需要比拉丁更松的行高 */
  }

  /* 列表：恢复 reset 清掉的缩进；条目间留出可读间隙 */
  & ul,
  & ol {
    padding-inline-start: 1.6em;
  }
  & ul > li,
  & ol > li {
    padding-inline-start: 0.2em;
  }
  & li + li {
    margin-top: 0.3em;
  }
  & li > ul,
  & li > ol {
    margin-top: 0.3em;
  }
  /* 任务列表：checkbox 自身带 margin，与文字基线对齐 */
  & li > input[type='checkbox'] {
    width: 0.95em;
    height: 0.95em;
    min-height: 0;
    margin-right: 0.4em;
    vertical-align: -0.08em;
  }

  /* 行内 code：胶囊底色与正文区分；pre 内的 code 由代码块样式接管 */
  & code {
    font-family: ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas,
      'Liberation Mono', monospace;
    font-size: 0.86em;
  }
  & :not(pre) > code {
    background: var(--haze-color-bg-muted);
    border: 1px solid var(--haze-color-border);
    border-radius: 4px;
    padding: 0.1em 0.35em;
  }

  /* 代码块：reset 清掉了 padding，代码此前紧贴容器边缘 */
  & pre {
    padding: 0.75em 0.9em;
    border: 1px solid var(--haze-color-border);
    border-radius: 6px;
    overflow-x: auto;
    line-height: 1.55;
  }

  /* 表格：边框 + 表头底色 + 单元格内边距；超宽时横向滚动而非溢出正文 */
  & table {
    display: block;
    border-collapse: collapse;
    max-width: 100%;
    overflow-x: auto;
  }
  & th,
  & td {
    border: 1px solid var(--haze-color-border);
    padding: 0.35em 0.7em;
    text-align: left;
  }
  & thead th {
    background: var(--haze-color-bg-subtle);
    font-weight: 600;
  }
  & tbody tr:nth-child(even) {
    background: color-mix(in srgb, var(--haze-color-bg-subtle) 45%, transparent);
  }

  /* 引用：左边线 + 次级色，与正文体区分 */
  & blockquote {
    border-left: 3px solid var(--haze-color-border);
    padding-left: 0.9em;
    color: var(--haze-color-text-secondary);
  }
  & blockquote > * + * {
    margin-top: 0.4em;
  }

  & hr {
    border: none;
    border-top: 1px solid var(--haze-color-border);
    margin-top: 1em;
    margin-bottom: 1em;
  }

  & img {
    max-width: 100%;
  }

  /* 纯文本链接：主题色 + 悬停下划线；带 class 的链接（CodeReference 药丸等）
   * 自持样式，不覆盖（同特异性下源序不可控，用 :not([class]) 精确排除）。 */
  & a:not([class]) {
    color: var(--haze-color-primary);
    text-decoration: none;
  }
  & a:not([class]):hover {
    text-decoration: underline;
  }
`

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
      <div className={prose} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  )
})
