import { describe, expect, it } from 'vitest'
import { redactSecretText } from './secret-redact.js'

const NPM_TOKEN = `npm_${'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXy'.slice(0, 36)}`
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'

describe('redactSecretText', () => {
  it('redacts provider token shapes', () => {
    expect(redactSecretText(`token is ${NPM_TOKEN} ok`)).toBe('token is [REDACTED] ok')
    expect(redactSecretText(`id ${AWS_KEY}`)).toBe('id [REDACTED]')
    expect(redactSecretText('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe('[REDACTED]')
    expect(redactSecretText('xoxb-1234567890-abcdef')).toBe('[REDACTED]')
    expect(redactSecretText('secret_aB3dEfGh1JkLmN0pQ')).toBe('[REDACTED]')
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(24)}.${'b'.repeat(20)}`
    expect(redactSecretText(`bearer ${jwt} sent`)).toBe('bearer [REDACTED] sent')
    expect(redactSecretText('version 1.2.3 released')).toBe('version 1.2.3 released')
  })

  it('leaves ordinary identifiers alone', () => {
    for (const identifier of [
      'passwordAuthenticationMiddleware',
      'tokenizationStrategy',
      'keyboardInterruptHandler',
      'token_bucket_rate_limiter',
      'secret_manager_client',
      'password_authentication',
      'token_authorization',
      'key_configuration',
    ]) {
      expect(redactSecretText(`calls ${identifier} twice`), identifier).toBe(
        `calls ${identifier} twice`,
      )
    }
  })

  it('applies segment length thresholds at the boundary', () => {
    // 混合段下限 12：达标整段抹除（含关键字），差一位原样保留
    expect(redactSecretText('secret_a1b2c3d4e5f6 here')).toBe('[REDACTED] here')
    expect(redactSecretText('secret_a1b2c3d4e5f here')).toBe('secret_a1b2c3d4e5f here')
    // 纯字母段下限 16
    expect(redactSecretText('use password-abcdefghijklmnop now')).toBe('use [REDACTED] now')
    expect(redactSecretText('use password-abcdefghijklmno now')).toBe(
      'use password-abcdefghijklmno now',
    )
    expect(redactSecretText('use password-supersecretvalue here')).toBe('use [REDACTED] here')
    expect(redactSecretText('API token-abcdefghijklmnop leaked')).toBe('API [REDACTED] leaked')
    // 纯数字段与纯字母同阈值（16）：长数字串跟在关键字后同样可疑
    expect(redactSecretText('tok-1234567890123456 ok')).toBe('[REDACTED] ok')
  })

  it('requires all three JWT segments to reach 16 chars', () => {
    const ok = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(16)}.${'b'.repeat(16)}`
    expect(redactSecretText(ok)).toBe('[REDACTED]')
    const shortPayload = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(15)}.${'b'.repeat(16)}`
    expect(redactSecretText(shortPayload)).toBe(shortPayload)
    const shortSignature = `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(16)}.${'b'.repeat(15)}`
    expect(redactSecretText(shortSignature)).toBe(shortSignature)
  })

  it('redacts tokens embedded in URLs without mangling ordinary URLs', () => {
    // 路径段里的 `token_` 结构照常命中：URL 专用字符（/ . : ? =）都不是 token
    // 字符，恰好充当段界
    expect(redactSecretText('https://example.com/verify/token_aB3dEfGh1JkLmN0pQ/x')).toBe(
      'https://example.com/verify/[REDACTED]/x',
    )
    // 固定前缀 token 出现在 query 里也不漏
    expect(
      redactSecretText('https://ci.example.com/hook?token=ghp_abcdefghijklmnopqrstuvwxyz0123'),
    ).toBe('https://ci.example.com/hook?token=[REDACTED]')
    // 普通 URL（版本号、包路径、短段）不误伤
    const plain = 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz'
    expect(redactSecretText(plain)).toBe(plain)
  })

  it('treats CJK text as a natural boundary', () => {
    expect(redactSecretText('密钥是secret_aB3dEfGh1JkLmN0pQ，请保管好')).toBe(
      '密钥是[REDACTED]，请保管好',
    )
    expect(redactSecretText('数据库密码 password-abcdefghijklmnop 已泄露')).toBe(
      '数据库密码 [REDACTED] 已泄露',
    )
    const plain = '这是一段普通中文备注：包含「令牌」两个字，但没有密钥。'
    expect(redactSecretText(plain)).toBe(plain)
    // 中文紧贴标识符时，标识符仍作为一个完整区间参与扫描
    expect(redactSecretText('参见password_authentication的实现')).toBe(
      '参见password_authentication的实现',
    )
  })

  it('is idempotent: the marker itself never matches', () => {
    const once = redactSecretText(`leaked ${NPM_TOKEN} and secret_aB3dEfGh1JkLmN0pQ`)
    expect(once).toBe('leaked [REDACTED] and [REDACTED]')
    expect(redactSecretText(once)).toBe(once)
  })

  // 22 万字符的不间断区间：早先带尾部前瞻的正则形态在此输入上需 ~25s（逐候选
  // 重扫尾部），单遍扫描器毫秒级返回——本用例本身即性能回归防线（超时即失败）。
  it('scans a large unbroken run without rescanning its tail', () => {
    const input = 'token_aaaa-'.repeat(20000)
    expect(redactSecretText(input)).toBe(input)
  })
})
