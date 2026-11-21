// 离线测试用假 LSP 服务器：读 Content-Length 帧、回 initialize capabilities、
// 按方法返回固定结果、didOpen/didChange 后 publishDiagnostics。行为由环境变量
// 控制（测试经 createLspClient 的 env 选项注入）：
//   FAKE_LSP_DIAG_VERSION = 'echo'（默认，回显 version）| 'omit'（不回显 → 客户端走 settle 窗口）
//   FAKE_LSP_ASK_CONFIG   = '1'（initialize 响应前先向客户端发 workspace/configuration，
//                              并把应答放进 initialize 结果的 configEcho——验证配置拉取路径）
// references 有状态：第一次请求返回 []（触发工具层重试），之后返回 1 个位置。
import { Buffer } from 'node:buffer'

const diagEchoVersion = process.env.FAKE_LSP_DIAG_VERSION !== 'omit'
const referencesCalls = new Map()
/** 客户端对 workspace/configuration 拉取的应答（FAKE_LSP_ASK_CONFIG=1 时存在）。 */
let configEchoResult

function send(msg) {
  const json = JSON.stringify(msg)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`)
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function publishDiagnostics(uri, version) {
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      ...(diagEchoVersion ? { version } : {}),
      diagnostics: [
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
          severity: 1,
          message: 'fake error',
        },
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          severity: 2,
          source: 'fake',
          message: 'fake warning',
        },
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
          severity: 1,
          message: 'fake error',
        },
      ],
    },
  })
}

function handleRequest(msg) {
  const { id, method } = msg
  if (id === undefined || method === undefined) return
  const params = msg.params ?? {}

  switch (method) {
    case 'initialize': {
      const finish = () =>
        respond(id, {
          capabilities: {
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            documentSymbolProvider: true,
            renameProvider: true,
          },
          serverInfo: { name: 'fake-lsp' },
          ...(configEchoResult !== undefined ? { configEcho: configEchoResult } : {}),
        })
      if (process.env.FAKE_LSP_ASK_CONFIG === '1') {
        configEchoResult = null
        send({
          jsonrpc: '2.0',
          id: 'cfg-1',
          method: 'workspace/configuration',
          params: { items: [{ section: 'fake.one' }, { section: 'fake.missing' }] },
        })
        configFinishers.set('cfg-1', finish)
      } else {
        finish()
      }
      break
    }
    case 'shutdown':
      respond(id, null)
      break
    case 'textDocument/hover':
      respond(id, {
        contents: [{ language: 'ts', value: 'const foo: number' }, 'also plain text'],
      })
      break
    case 'textDocument/definition':
    case 'textDocument/typeDefinition': {
      const uri = params.textDocument?.uri ?? ''
      respond(id, [
        {
          originSelectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
          targetUri: uri,
          targetRange: {
            start: { line: 2, character: 0 },
            end: { line: 2, character: 7 },
          },
          targetSelectionRange: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 7 },
          },
        },
      ])
      break
    }
    case 'textDocument/references': {
      const uri = params.textDocument?.uri ?? ''
      const calls = (referencesCalls.get(uri) ?? 0) + 1
      referencesCalls.set(uri, calls)
      respond(
        id,
        calls === 1
          ? []
          : [{ uri, range: { start: { line: 3, character: 2 }, end: { line: 3, character: 5 } } }],
      )
      break
    }
    case 'textDocument/documentSymbol':
      respond(id, [
        {
          name: 'alpha',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
          children: [
            {
              name: 'beta',
              kind: 6,
              range: { start: { line: 1, character: 2 }, end: { line: 2, character: 3 } },
              selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } },
            },
          ],
        },
        {
          name: 'gamma',
          kind: 13,
          location: {
            uri: params.textDocument?.uri ?? '',
            range: { start: { line: 4, character: 0 }, end: { line: 4, character: 5 } },
          },
        },
      ])
      break
    case 'textDocument/rename':
      respond(id, {
        changes: {
          [params.textDocument?.uri ?? '']: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: params.newName ?? 'renamed',
            },
          ],
        },
      })
      break
    case 'test/hang':
      // 故意不响应：pending 超时 / failAll 测试用。
      break
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

const configFinishers = new Map()

function handleNotification(msg) {
  const { method } = msg
  if (method === undefined) return
  const params = msg.params ?? {}
  switch (method) {
    case 'textDocument/didOpen':
      publishDiagnostics(params.textDocument?.uri ?? '', params.textDocument?.version ?? 1)
      break
    case 'textDocument/didChange':
      publishDiagnostics(params.textDocument?.uri ?? '', params.textDocument?.version ?? 1)
      break
    case 'exit':
      process.exit(0)
      break
    case 'test/exit':
      process.exit(1)
      break
    default:
      break
  }
}

function handleMessage(msg) {
  if (msg.method !== undefined) {
    if (msg.id !== undefined) handleRequest(msg)
    else handleNotification(msg)
    return
  }
  if (msg.id !== undefined && configFinishers.has(msg.id)) {
    const finish = configFinishers.get(msg.id)
    configFinishers.delete(msg.id)
    configEchoResult = msg.result ?? null
    finish?.()
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const header = buffer.subarray(0, headerEnd).toString('ascii')
    const m = /content-length:\s*(\d+)/i.exec(header)
    if (!m) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const len = Number(m[1])
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + len) break
    const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf8')
    buffer = buffer.subarray(bodyStart + len)
    try {
      handleMessage(JSON.parse(body))
    } catch {
      // 坏帧忽略
    }
  }
})
