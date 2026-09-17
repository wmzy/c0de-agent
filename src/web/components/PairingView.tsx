// P2-16：设备配对视图。
//  - 新设备（无有效 token）：请求配对 → 显示 6 位配对码 → 轮询审批结果 → 获批后存 token 刷新。
//  - 已授权设备：轮询待审批列表 → 弹窗展示配对码与设备名 → 批准/拒绝。
import { css } from '@linaria/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { authAPI } from '@/services/auth.js'

const overlay = css`
  position: fixed;
  inset: 0;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
`

const card = css`
  width: min(420px, 92vw);
  padding: 28px 24px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 14px;
  text-align: center;
`

const title = css`
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
`

const desc = css`
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
`

const code = css`
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 8px;
  color: var(--primary);
  padding: 10px 0;
  font-variant-numeric: tabular-nums;
`

const btn = css`
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: 13px;
  &:hover {
    border-color: var(--primary);
    color: var(--primary);
  }
`

const approveBtn = css`
  border-color: var(--primary);
  color: var(--primary);
`

const err = css`
  font-size: 12px;
  color: var(--error);
`

/** 新设备配对流程：请求配对码并轮询审批。 */
function PairingRequestFlow() {
  const [pairing, setPairing] = useState<{
    pairingId: string
    code: string
    /** L3：服务端当前是否有已授权设备；false = 无人可批准，展示恢复指引。 */
    hasAuthorizedDevices?: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [approved, setApproved] = useState(false)
  const started = useRef(false)

  const start = useCallback(() => {
    setError(null)
    authAPI
      .requestPairing('新设备 (Browser)')
      .then(setPairing)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        setError(`发起配对失败：${msg}`)
      })
  }, [])

  useEffect(() => {
    if (started.current) return
    started.current = true
    start()
  }, [start])

  useEffect(() => {
    if (!pairing) return
    // L3：零已授权设备时无人可批准，轮询无意义（用户按指引重启 serve 后
    // 点「重新检测」发起新请求再进入轮询）。
    if (pairing.hasAuthorizedDevices === false) return
    let cancelled = false
    const poll = async () => {
      try {
        const s = await authAPI.pairingStatus(pairing.pairingId)
        if (cancelled) return
        if (s.status === 'approved') {
          localStorage.setItem('c0de-auth-token', s.deviceToken)
          setApproved(true)
          setTimeout(() => window.location.reload(), 600)
          return
        }
        if (s.status === 'denied') {
          setError('配对请求被拒绝')
          return
        }
        // pending → 继续轮询
        timerRef.current = setTimeout(() => void poll(), 2000)
      } catch {
        if (!cancelled) timerRef.current = setTimeout(() => void poll(), 3000)
      }
    }
    const timerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null }
    timerRef.current = setTimeout(() => void poll(), 1000)
    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [pairing])

  return (
    <div className={card}>
      <div className={title}>新设备配对</div>
      <div className={desc}>
        本设备尚未获得访问授权。请在下方生成配对码，然后在<b>已授权的设备</b>上打开 c0de，
        在「设备配对」弹窗中核对与本页一致的配对码并批准。
      </div>
      {approved ? (
        <div className={desc}>已批准，正在进入…</div>
      ) : pairing && pairing.hasAuthorizedDevices === false ? (
        <div data-testid="pairing-deadend">
          <div className={desc}>
            当前服务尚无任何<b>已授权设备</b>，配对请求不可能被批准。请在运行{' '}
            <code>c0de serve</code> 的终端：1）重启服务（Ctrl+C 后重新运行）；2）打开启动日志中
            打印的带 <code>?token=</code> 的链接完成首次设备注册。
          </div>
          <div className={desc}>
            若唯一设备的浏览器数据已丢失，请先运行 <code>c0de auth reset</code> 清除设备记录，
            再重启服务。
          </div>
          {error && <div className={err}>{error}</div>}
          <button type="button" className={btn} onClick={start} data-testid="pairing-recheck">
            重新检测
          </button>
        </div>
      ) : pairing ? (
        <>
          <div className={code} data-testid="pairing-code">
            {pairing.code}
          </div>
          <div className={desc}>等待已授权设备审批（配对码 10 分钟内有效）…</div>
          {error && <div className={err}>{error}</div>}
        </>
      ) : (
        <>
          <div className={desc}>点击下方按钮生成配对码。</div>
          {error && <div className={err}>{error}</div>}
          <button type="button" className={btn} onClick={start} data-testid="pairing-start">
            生成配对码
          </button>
        </>
      )}
    </div>
  )
}

/** 已授权设备：展示待审批配对并批准/拒绝。由 App 在收到配对列表后弹层。
 *  P2-9：批准需输入新设备屏幕显示的 6 位配对码——多请求并存时防看错行误批。 */
export function PairingApproval({ onDone }: { onDone: () => void }) {
  const [items, setItems] = useState<
    { pairingId: string; deviceName: string; code: string; source: string }[]
  >([])
  const [error, setError] = useState<string | null>(null)
  const [codes, setCodes] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await authAPI.listPairings()
        if (!cancelled) setItems(res.pairings)
      } catch (e) {
        // 401 = 本设备未认证（新设备页）：静默停止，不显示错误
        if (!cancelled && (e as { status?: number }).status !== 401) {
          setError('获取配对请求失败')
        }
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (items.length === 0 && !error) return null

  const approve = (id: string, code: string) => {
    authAPI
      .approvePairing(id, code)
      .then(() => setItems((prev) => prev.filter((p) => p.pairingId !== id)))
      .catch((e) => {
        setError(
          (e as { code?: string }).code === 'PAIRING_CODE_MISMATCH'
            ? '配对码不匹配，请核对新设备屏幕显示的 6 位码'
            : '操作失败，请重试',
        )
      })
  }

  const deny = (id: string) => {
    authAPI
      .denyPairing(id)
      .then(() => setItems((prev) => prev.filter((p) => p.pairingId !== id)))
      .catch(() => setError('操作失败，请重试'))
  }

  return (
    <div className={overlay}>
      <div className={card}>
        <div className={title}>设备配对审批</div>
        <div className={desc}>
          以下设备请求访问 c0de。请与对方核对设备信息后，<b>输入对方屏幕上显示的 6 位配对码</b>
          再批准。 设备名由请求方自报，仅作参考。
        </div>
        {items.map((p) => (
          <div
            key={p.pairingId}
            style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center' }}
          >
            <span className={code} style={{ fontSize: 20, letterSpacing: 4 }}>
              {p.code}
            </span>
            <span className={desc}>
              {p.deviceName}
              <span
                style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)' }}
                title="请求来源（IP 等，尽力而为；设备名由请求方自报）"
              >
                来源：{p.source}
              </span>
            </span>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="输入 6 位码"
              value={codes[p.pairingId] ?? ''}
              onChange={(e) =>
                setCodes((prev) => ({ ...prev, [p.pairingId]: e.target.value.replace(/\D/g, '') }))
              }
              data-testid={`pairing-code-input-${p.pairingId}`}
            />
            <button
              type="button"
              className={`${btn} ${approveBtn}`}
              disabled={(codes[p.pairingId] ?? '').length !== 6}
              onClick={() => approve(p.pairingId, codes[p.pairingId] ?? '')}
              data-testid="pairing-approve"
            >
              批准
            </button>
            <button type="button" className={btn} onClick={() => deny(p.pairingId)}>
              拒绝
            </button>
          </div>
        ))}
        {error && <div className={err}>{error}</div>}
        <button type="button" className={btn} onClick={onDone}>
          关闭
        </button>
      </div>
    </div>
  )
}

export { PairingRequestFlow }
