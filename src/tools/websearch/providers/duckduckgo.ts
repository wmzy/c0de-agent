import type {
  WebSearchParams,
  WebSearchProvider,
  WebSearchResponse,
  WebSearchSource,
} from '../types.js'

const DUCKDUCKGO_SEARCH_URL = 'https://api.duckduckgo.com/'
const AGENT_TOKEN = 'c0de-agent'

/** DuckDuckGo Instant Answer API 响应形状（仅取用到的字段）。 */
interface DuckDuckGoTopic {
  FirstURL?: string | null
  Text?: string | null
  Topics?: DuckDuckGoTopic[] | null
}
interface DuckDuckGoResponse {
  AbstractText?: string | null
  AbstractURL?: string | null
  Heading?: string | null
  Answer?: string | null
  Definition?: string | null
  Results?: DuckDuckGoTopic[] | null
  RelatedTopics?: DuckDuckGoTopic[] | null
}

function cleanText(value: string | null | undefined): string | undefined {
  const cleaned = value
    ?.replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? cleaned : undefined
}

function addSource(sources: WebSearchSource[], source: WebSearchSource): void {
  if (!source.url || sources.some((s) => s.url === source.url)) return
  sources.push(source)
}

function addTopicSource(sources: WebSearchSource[], topic: DuckDuckGoTopic): void {
  const url = topic.FirstURL?.trim()
  if (!url) return
  const text = cleanText(topic.Text)
  addSource(sources, { title: text ?? url, url, snippet: text })
}

function collectTopicSources(
  sources: WebSearchSource[],
  topics: readonly DuckDuckGoTopic[] | null | undefined,
): void {
  if (!topics) return
  for (const topic of topics) {
    addTopicSource(sources, topic)
    collectTopicSources(sources, topic.Topics)
  }
}

async function callDuckDuckGoSearch(params: WebSearchParams): Promise<DuckDuckGoResponse> {
  const fetchImpl = params.fetchImpl ?? fetch
  const query = new URLSearchParams({
    q: params.query,
    format: 'json',
    no_redirect: '1',
    no_html: '1',
    skip_disambig: '1',
    t: AGENT_TOKEN,
  })
  const response = await fetchImpl(`${DUCKDUCKGO_SEARCH_URL}?${query.toString()}`, {
    method: 'GET',
    signal: params.signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText)
    throw new Error(`DuckDuckGo API error (${response.status}): ${text}`)
  }
  return (await response.json()) as DuckDuckGoResponse
}

/** DuckDuckGo Instant Answer 后端（零 key，恒可用）。recency 不支持，忽略。 */
export const duckduckgoProvider: WebSearchProvider = {
  id: 'duckduckgo',
  isAvailable: () => true,
  search: async (params: WebSearchParams): Promise<WebSearchResponse> => {
    const data = await callDuckDuckGoSearch(params)
    const answer =
      cleanText(data.AbstractText) ?? cleanText(data.Answer) ?? cleanText(data.Definition)
    const sources: WebSearchSource[] = []
    // AbstractURL 作为首个来源（若无 RelatedTopics 填充）
    if (data.AbstractURL) {
      addSource(sources, {
        title: cleanText(data.Heading) ?? data.AbstractURL,
        url: data.AbstractURL,
      })
    }
    collectTopicSources(sources, data.Results)
    collectTopicSources(sources, data.RelatedTopics)
    return { provider: 'duckduckgo', answer, sources }
  },
}
