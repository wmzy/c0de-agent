// P2-16：设备配对视图。
//  - 新设备（无有效 token）：请求配对 → 显示 6 位配对码 → 轮询审批结果 → 获批后存 token 刷新。
//  - 已授权设备：轮询待审批列表 → 弹窗展示配对码与设备名 → 批准/拒绝。
import { css } from '@linaria/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { authAPI } from '../services/auth.js'

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
  const [pairing, setPairing] = useState<{ pairingId: string; code: string } | null>(null)
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
        在「设备配对」弹窗中输入该码并批准。
      </div>
      {approved ? (
        <div className={desc}>已批准，正在进入…</div>
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

/** 已授权设备：展示待审批配对并批准/拒绝。由 App 在收到配对列表后弹层。 */
export function PairingApproval({ onDone }: { onDone: () => void }) {
  const [items, setItems] = useState<{ pairingId: string; deviceName: string; code: string }[]>([])
  const [error, setError] = useState<string | null>(null)

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

  const act = (id: string, approve: boolean) => {
    const fn = approve ? authAPI.approvePairing : authAPI.denyPairing
    fn(id)
      .then(() => setItems((prev) => prev.filter((p) => p.pairingId !== id)))
      .catch(() => setError('操作失败，请重试'))
  }

  return (
    <div className={overlay}>
      <div className={card}>
        <div className={title}>设备配对审批</div>
        <div className={desc}>
          以下设备请求访问 c0de。请核对对方屏幕上显示的配对码，确认后批准。
        </div>
        {items.map((p) => (
          <div
            key={p.pairingId}
            style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center' }}
          >
            <span className={code} style={{ fontSize: 20, letterSpacing: 4 }}>
              {p.code}
            </span>
            <span className={desc}>{p.deviceName}</span>
            <button
              type="button"
              className={`${btn} ${approveBtn}`}
              onClick={() => act(p.pairingId, true)}
              data-testid="pairing-approve"
            >
              批准
            </button>
            <button type="button" className={btn} onClick={() => act(p.pairingId, false)}>
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
