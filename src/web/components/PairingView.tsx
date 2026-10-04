// P2-16：设备配对视图。
//  - 新设备（无有效 token）：请求配对 → 显示 6 位配对码 → 轮询审批结果 → 获批后存 token 刷新。
//  - 已授权设备：轮询待审批列表 → 弹窗展示配对码与设备名 → 批准/拒绝。
import { css } from '@linaria/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SyncedInput } from '@/components/SyncedControls.js'
import { authAPI } from '@/services/auth.js'
import { storageSet } from '@/utils/storage.js'

/** 层容器：撑满视口并居中内容。遮罩（button）与面板（div）为兄弟节点，
 *  面板的点击天然不会落到遮罩上，无需 stopPropagation。 */
const layer = css`
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
`

/** 遮罩：整屏铺满的「关闭」按钮（点遮罩 = 点关闭，与其余弹层一致）。
 *  用真 button 而非 div+onClick：天生可聚焦、可回车/空格触发，无需 stopPropagation
 *  技巧（面板作为兄弟节点而非子节点，天然不冒泡到遮罩）。 */
const overlay = css`
  position: absolute;
  inset: 0;
  padding: 0;
  border: none;
  background: var(--haze-color-bg);
  cursor: pointer;
`

const card = css`
  position: relative;
  width: min(420px, 92vw);
  padding: 28px 24px;
  border: 1px solid var(--haze-color-border);
  border-radius: 10px;
  background: var(--haze-color-bg-subtle);
  display: flex;
  flex-direction: column;
  gap: 14px;
  text-align: center;
`

const title = css`
  font-size: 16px;
  font-weight: 600;
  color: var(--haze-color-text);
`

const desc = css`
  font-size: 13px;
  color: var(--haze-color-text-secondary);
  line-height: 1.6;
`

const code = css`
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 8px;
  color: var(--haze-color-primary);
  padding: 10px 0;
  font-variant-numeric: tabular-nums;
`

const btn = css`
  padding: 8px 16px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;
  font-size: 13px;
  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
`

const approveBtn = css`
  border-color: var(--haze-color-primary);
  color: var(--haze-color-primary);
`

const err = css`
  font-size: 12px;
  color: var(--haze-color-danger);
`

/** 新设备配对流程：请求配对码并轮询审批。 */
function PairingRequestFlow({ onDismiss }: { onDismiss: () => void }) {
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
          storageSet('c0de-auth-token', s.deviceToken)
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
    <div className={layer}>
      <button
        type="button"
        className={overlay}
        aria-label="关闭配对流程"
        onClick={onDismiss}
        data-testid="pairing-request-backdrop"
      />
      <div
        className={card}
        role="dialog"
        aria-modal="true"
        aria-label="新设备配对"
        style={{ maxHeight: 'calc(100dvh - 48px)', overflowY: 'auto' }}
      >
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
        {/* 未授权时页面本身已不可用，「关闭」只收起弹层，不清除 authRequired：
            用户可继续查看说明与配对码，不会因误点丢失当前流程。 */}
        <button
          type="button"
          className={btn}
          onClick={onDismiss}
          data-testid="pairing-request-dismiss"
        >
          关闭
        </button>
      </div>
    </div>
  )
}

/** 已授权设备：展示待审批配对并批准/拒绝。由 App 在收到配对列表后弹层。
 *  P2-9：批准需输入新设备屏幕显示的 6 位配对码——多请求并存时防看错行误批。 */
export function PairingApproval() {
  const [items, setItems] = useState<
    { pairingId: string; deviceName: string; code: string; source: string }[]
  >([])
  const [error, setError] = useState<string | null>(null)
  const [codes, setCodes] = useState<Record<string, string>>({})
  /**
   * 用户点「关闭」时已隐藏的 pairingId 集合。此前关闭按钮无实现，叠加
   * z-index:2000 全屏遮罩 → 整应用被永久遮挡，唯一出路是批准/拒绝别人的请求。
   * 关闭改为「按请求逐条隐藏」：轮询不中断，新设备发起的新请求仍会重新弹窗，
   * 不丢审批可见性。
   */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())

  /** 未被关闭的请求——为 0 时整块不渲染。 */
  const visible = useMemo(
    () => items.filter((p) => !dismissed.has(p.pairingId)),
    [items, dismissed],
  )

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

  /**
   * 关闭：把当前所有待审批请求逐条标记为已隐藏（不拒绝、不影响轮询），
   * 并清掉错误。
   *
   * 清错误保证「关闭」是确定性的：只标记 dismissed 时，关闭后弹层不渲染，
   * 但 error 仍留在 state 里，下一轮轮询失败又把它点亮，用户刚关掉的弹层
   * 5 秒后自己弹回来。轮询本身不中断 —— 新设备发起的配对请求仍会重新弹窗，
   * 不丢审批可见性。
   *
   * 用 ref 持有最新闭包，使 Escape 监听只需绑定一次（不随 items 重建）。
   */
  const dismissAllRef = useRef<() => void>(() => {})
  dismissAllRef.current = () => {
    setError(null)
    setDismissed((prev) => {
      const next = new Set(prev)
      for (const p of items) next.add(p.pairingId)
      return next
    })
  }

  // Esc 等价于「关闭」：模态必须可被键盘用户关掉（此前仅有关闭按钮，且无实现）。
  // 必须置于下方 `if (visible.length === 0) return null` 之前——
  // 条件 return 在 Hook 之后会让 Hook 数量随渲染变化（React 直接抛错）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissAllRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const deny = (id: string) => {
    authAPI
      .denyPairing(id)
      .then(() => setItems((prev) => prev.filter((p) => p.pairingId !== id)))
      .catch(() => setError('操作失败，请重试'))
  }

  // 所有 Hook 之后才可提前返回。
  //
  // 必须以 visible 为唯一门槛（此前是 `visible.length === 0 && !error`）：
  // 审批弹层是 z-index:2000 的全屏遮罩，只有存在待审批请求时才该出现。
  // 只要轮询失败（如 security.authEnabled=false 时 /api/auth/pairing 恒回
  // 400 AUTH_DISABLED，每 5s 一次）就会点亮 error，弹层在没有任何待审批请求时
  // 照常渲染；而此时 items 为空，「关闭」/Escape/点遮罩三条关闭路径都只是把
  // 空 Set 标记为已隐藏 —— 状态无变化，React 跳过重渲染，遮罩无法移除，
  // 整个应用被永久挡住。
  //
  // 改成只认 visible 后：无请求即不渲染，与错误无关；关闭也顺带清掉 error，
  // 避免关闭后弹层再被下一次轮询失败点亮。
  if (visible.length === 0) return null

  return (
    <div className={layer}>
      <button
        type="button"
        className={overlay}
        aria-label="关闭设备配对审批"
        onClick={() => dismissAllRef.current()}
        data-testid="pairing-backdrop"
      />
      <div className={card} role="dialog" aria-modal="true" aria-label="设备配对审批">
        <div className={title}>设备配对审批</div>
        <div className={desc}>
          以下设备请求访问 c0de。请与对方核对设备信息后，<b>输入对方屏幕上显示的 6 位配对码</b>
          再批准。 设备名由请求方自报，仅作参考。
        </div>
        {visible.map((p) => (
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
                style={{
                  display: 'block',
                  fontSize: 11,
                  color: 'var(--haze-color-text-secondary)',
                }}
                title="请求来源（IP 等，尽力而为；设备名由请求方自报）"
              >
                来源：{p.source}
              </span>
            </span>
            <SyncedInput
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="输入 6 位码"
              value={codes[p.pairingId] ?? ''}
              onChange={(v) =>
                setCodes((prev) => ({ ...prev, [p.pairingId]: v.replace(/\D/g, '') }))
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
        <button
          type="button"
          className={btn}
          onClick={() => dismissAllRef.current()}
          data-testid="pairing-dismiss"
        >
          关闭
        </button>
      </div>
    </div>
  )
}

export { PairingRequestFlow }
