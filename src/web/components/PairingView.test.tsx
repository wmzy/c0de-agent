// PairingView 组件测试，对应 src/web/components/PairingView.tsx
//
// 核心回归：设备配对审批弹层此前「关闭」按钮无实现，叠加 z-index:2000
// 全屏遮罩 → 整应用被永久遮挡（唯一出路是批准/拒绝别人的请求）。
// 以下用例钉住三种关闭路径：关闭按钮、Escape、点击遮罩。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PairingApproval } from '@/components/PairingView.js'
import { authAPI } from '@/services/auth.js'

vi.mock('@/services/auth.js', () => ({
  authAPI: {
    listPairings: vi.fn(),
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

  it('弹层具备 dialog 语义（role + aria-modal）', async () => {
    await renderAndWait()
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
  })
})
