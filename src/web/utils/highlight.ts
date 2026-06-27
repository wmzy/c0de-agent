import { createHighlighter } from 'shiki'

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [
        'javascript',
        'typescript',
        'python',
        'rust',
        'go',
        'java',
        'c',
        'cpp',
        'html',
        'css',
        'json',
        'yaml',
        'markdown',
        'bash',
        'sql',
      ],
    })
  }
  return highlighterPromise
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter()
  return hl.codeToHtml(code, {
    lang: lang || 'text',
    themes: { dark: 'github-dark', light: 'github-light' },
  })
}
