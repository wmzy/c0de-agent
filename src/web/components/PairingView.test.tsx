// PairingView 组件测试，对应 src/web/components/PairingView.tsx
//
// 核心回归：设备配对审批弹层此前「关闭」按钮无实现，叠加 z-index:2000
// 全屏遮罩 → 整应用被永久遮挡（唯一出路是批准/拒绝别人的请求）。
// 以下用例钉住三种关闭路径：关闭按钮、Escape、点击遮罩。
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PairingApproval, PairingRequestFlow } from '@/components/PairingView.js'
import { authAPI } from '@/services/auth.js'

vi.mock('@/services/auth.js', () => ({
  authAPI: {
    listPairings: vi.fn(),
    requestPairing: vi.fn(),
    pairingStatus: vi.fn(),
    approvePairing: vi.fn(),
    denyPairing: vi.fn(),
  },
}))

const PENDING = {
  pairingId: 'p1',
  deviceName: '新设备 (Browser)',
  code: '940440',
  source: 'local',
  createdAt: 1,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.mocked(authAPI.listPairings).mockResolvedValue({ pairings: [PENDING] })
  // 配对请求流挂载即发起 requestPairing；本组用例只关心呈现/关闭，
  // 固定为「有已授权设备 + 长期 pending」，避免轮询分支干扰断言。
  vi.mocked(authAPI.requestPairing).mockResolvedValue({
    pairingId: 'p1',
    code: '940440',
    hasAuthorizedDevices: true,
  })
  vi.mocked(authAPI.pairingStatus).mockResolvedValue({ status: 'pending' })
})

/** 弹层出现（首轮轮询是异步的）。 */
async function renderAndWait() {
  render(<PairingApproval />)
  await waitFor(() => {
    expect(screen.getByTestId('pairing-code-input-p1')).toBeTruthy()
  })
}

describe('PairingApproval 关闭路径', () => {
  it('点「关闭」隐藏弹层（不拒绝、不停止轮询）', async () => {
    await renderAndWait()
    fireEvent.click(screen.getByTestId('pairing-dismiss'))
    expect(screen.queryByTestId('pairing-code-input-p1')).toBeNull()
    // 关闭不是「拒绝」：未发起任何 deny 请求，请求仍在服务端待审批。
    expect(authAPI.denyPairing).not.toHaveBeenCalled()
  })

  it('Escape 关闭弹层', async () => {
    await renderAndWait()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('pairing-code-input-p1')).toBeNull()
  })

  it('点击遮罩关闭弹层', async () => {
    await renderAndWait()
    fireEvent.click(screen.getByTestId('pairing-backdrop'))
    expect(screen.queryByTestId('pairing-code-input-p1')).toBeNull()
  })

  it('点击弹层内部不关闭（避免误触）', async () => {
    await renderAndWait()
    // 面板与遮罩是兄弟节点：面板内的点击不会落到遮罩上。
    fireEvent.click(screen.getByText('设备配对审批'))
    expect(screen.getByTestId('pairing-code-input-p1')).toBeTruthy()
  })

  it('无待审批请求时不渲染弹层', () => {
    vi.mocked(authAPI.listPairings).mockResolvedValue({ pairings: [] })
    render(<PairingApproval />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('轮询失败时不渲染弹层（无请求可审批，不该遮挡整个应用）', async () => {
    // 认证关闭时 /api/auth/pairing 恒回 400：列表为空 + 轮询持续失败。
    // 此前 error 会点亮弹层，而三条关闭路径都只把空集合标记为已隐藏，
    // 状态无变化 → z-index:2000 全屏遮罩永久挡住应用。
    vi.mocked(authAPI.listPairings).mockRejectedValue(
      Object.assign(new Error('AUTH_DISABLED'), { status: 400 }),
    )
    render(<PairingApproval />)
    await waitFor(() => {
      expect(authAPI.listPairings).toHaveBeenCalled()
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('关闭后不因后续轮询失败被再次点亮', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let failNext = false
      vi.mocked(authAPI.listPairings).mockImplementation(async () => {
        if (failNext) {
          throw Object.assign(new Error('AUTH_DISABLED'), { status: 400 })
        }
        return { pairings: [PENDING] }
      })
      await renderAndWait()
      fireEvent.click(screen.getByTestId('pairing-dismiss'))
      expect(screen.queryByRole('dialog')).toBeNull()

      // 下一轮轮询失败：不该把用户刚关掉的弹层弹回来
      failNext = true
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('弹层具备 dialog 语义（role + aria-modal）', async () => {
    await renderAndWait()
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
  })
})

/**
 * 配对请求流（新设备侧）此前直接把 card 作为 appShell 的子节点渲染——
 * 没有 layer 包裹，卡片 position:static 落在 flex 列流首位，既不居中也没遮罩，
 * 还把下方 Workbench 从 top=77 挤到 top=354（视口 1440×900 实测）。
 * 以下用例钉住「居中弹层 + 可关闭」这两条用户可见契约。
 */
describe('PairingRequestFlow 呈现为居中弹层', () => {
  it('包裹在 layer 中（遮罩与面板互为兄弟节点），具备 dialog 语义', () => {
    render(<PairingRequestFlow onDismiss={vi.fn()} />)
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    // 遮罩存在 → 视觉上与应用其余部分分离，居中由 layer 的 flex 负责
    expect(screen.getByTestId('pairing-request-backdrop')).toBeTruthy()
  })

  it('遮罩的 aria-label 说明关闭动作，且遮罩是 button（天生可聚焦/回车触发）', () => {
    render(<PairingRequestFlow onDismiss={vi.fn()} />)
    const backdrop = screen.getByTestId('pairing-request-backdrop')
    expect(backdrop.tagName).toBe('BUTTON')
    expect(backdrop.getAttribute('aria-label')).toBe('关闭配对流程')
  })

  it('点「关闭」调用 onDismiss', () => {
    const onDismiss = vi.fn()
    render(<PairingRequestFlow onDismiss={onDismiss} />)
    fireEvent.click(screen.getByTestId('pairing-request-dismiss'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('点遮罩同样调用 onDismiss', () => {
    const onDismiss = vi.fn()
    render(<PairingRequestFlow onDismiss={onDismiss} />)
    fireEvent.click(screen.getByTestId('pairing-request-backdrop'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
