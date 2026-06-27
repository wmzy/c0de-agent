import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

// 细粒度 bundle：只加载 15 种常用语言 + 2 主题，避免 Shiki 默认打包全部 600+ 语言。
// JS regex engine 免除 wasm 依赖（oniguruma），减小体积。
const LANGS = [
  () => import('@shikijs/langs/javascript'),
  () => import('@shikijs/langs/typescript'),
  () => import('@shikijs/langs/python'),
  () => import('@shikijs/langs/rust'),
  () => import('@shikijs/langs/go'),
  () => import('@shikijs/langs/java'),
  () => import('@shikijs/langs/c'),
  () => import('@shikijs/langs/cpp'),
  () => import('@shikijs/langs/html'),
  () => import('@shikijs/langs/css'),
  () => import('@shikijs/langs/json'),
  () => import('@shikijs/langs/yaml'),
  () => import('@shikijs/langs/markdown'),
  () => import('@shikijs/langs/bash'),
  () => import('@shikijs/langs/sql'),
]

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
  const hl = await getHighlighter()
  const loaded = hl.getLoadedLanguages()
  const resolved = loaded.includes(lang) ? lang : 'typescript'
  return hl.codeToHtml(code, {
    lang: resolved,
    themes: { dark: 'github-dark', light: 'github-light' },
  })
}
