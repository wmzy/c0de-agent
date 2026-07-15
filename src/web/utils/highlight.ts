import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

// 细粒度 bundle：只加载 8 种高频语言 + 2 主题，避免 Shiki 默认打包全部 600+ 语言。
// 低频语言（rust/go/java/c/cpp/yaml/sql）未加载时由 highlightCode fallback 到 typescript。
// JS regex engine 免除 wasm 依赖（oniguruma），减小体积。
const LANGS = [
  () => import('@shikijs/langs/javascript'),
  () => import('@shikijs/langs/typescript'),
  () => import('@shikijs/langs/python'),
  () => import('@shikijs/langs/html'),
  () => import('@shikijs/langs/css'),
  () => import('@shikijs/langs/json'),
  () => import('@shikijs/langs/markdown'),
  () => import('@shikijs/langs/bash'),
]

const hlCache = new Map<string, string>()

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import('@shikijs/themes/github-dark'), import('@shikijs/themes/github-light')],
      langs: LANGS,
      engine: createJavaScriptRegexEngine(),
    })
  }
  return highlighterPromise
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  const key = `${lang}:${code}`
  const cached = hlCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const hl = await getHighlighter()
  const loaded = hl.getLoadedLanguages()
  const resolved = loaded.includes(lang) ? lang : 'typescript'
  const html = hl.codeToHtml(code, {
    lang: resolved,
    themes: { dark: 'github-dark', light: 'github-light' },
  })
  if (hlCache.size >= 200) {
    const firstKey = hlCache.keys().next().value
    if (firstKey !== undefined) {
      hlCache.delete(firstKey)
    }
  }
  hlCache.set(key, html)
  return html
}
