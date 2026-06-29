import type {
  ResolveResult,
  URLRegistry,
  URLResolveContext,
  URLResolver,
} from '../shared/types/tool.js'

/** Create an empty URL resolver registry. */
function createURLRegistry(): URLRegistry {
  return { resolvers: new Map() }
}

/** Register a resolver for its scheme. First registration for a scheme wins;
 *  later registrations are ignored (stable dispatch, no accidental overrides). */
function registerURLResolver(registry: URLRegistry, resolver: URLResolver): void {
  if (!registry.resolvers.has(resolver.scheme)) {
    registry.resolvers.set(resolver.scheme, resolver)
  }
}

/** Does `path` carry a `scheme://` prefix? Plain file paths return false. */
function isURLPath(path: string): boolean {
  return parseScheme(path) !== null
}

/** Extract the scheme from a `scheme://…` path, or null for plain file paths.
 *  Scheme is the run of [a-z0-9+.-] before the first `://`. */
function parseScheme(path: string): string | null {
  const idx = path.indexOf('://')
  if (idx <= 0) return null
  const scheme = path.slice(0, idx)
  // Schemes are ASCII alphanumeric plus +, -, . (RFC 3986).
  if (!/^[a-z0-9+.-]+$/i.test(scheme)) return null
  return scheme.toLowerCase()
}

/** Resolve a `scheme://…` URL via the registry.
 *  Returns { _tag: 'error' } for unregistered schemes. */
async function resolveURL(
  registry: URLRegistry,
  url: string,
  ctx: URLResolveContext,
): Promise<ResolveResult> {
  const scheme = parseScheme(url)
  if (scheme === null) {
    return { _tag: 'error', error: `Not a URL path: ${url}` }
  }
  const resolver = registry.resolvers.get(scheme)
  if (!resolver) {
    return { _tag: 'error', error: `No resolver registered for scheme "${scheme}://"` }
  }
  try {
    const content = await resolver.resolve(url, ctx)
    return { _tag: 'ok', content }
  } catch (e) {
    return { _tag: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

export { createURLRegistry, isURLPath, parseScheme, registerURLResolver, resolveURL }
