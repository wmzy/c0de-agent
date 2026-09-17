import { del, get, post } from '@/services/api.js'

// P2-16：设备配对 API 服务。

type PairingRequestResult = {
  pairingId: string
  code: string
  /** L3：服务端当前是否存在已授权设备。false = 无人可批准配对，UI 展示恢复指引。 */
  hasAuthorizedDevices?: boolean
}

type PairingStatus =
  | { status: 'pending' }
  | { status: 'approved'; deviceToken: string }
  | { status: 'denied' }
  | { status: 'not_found' }

type PendingPairing = {
  pairingId: string
  deviceName: string
  code: string
  createdAt: number
  /** 请求来源（IP，尽力而为）；设备名由请求方自报，来源仅供辅助判断。 */
  source: string
}

/** 已授权设备（GET /api/auth/devices）。 */
type AuthorizedDevice = {
  id: string
  name: string
  createdAt: number
}

const authAPI = {
  /** 新设备发起配对请求（公开端点）。 */
  requestPairing: (deviceName: string) =>
    post<PairingRequestResult>('/api/auth/pairing/request', { deviceName }),
  /** 新设备轮询审批结果（公开端点）。 */
  pairingStatus: (pairingId: string) =>
    get<PairingStatus>(`/api/auth/pairing/status?pairingId=${encodeURIComponent(pairingId)}`),
  /** 已授权设备：列出待审批配对。 */
  listPairings: () => get<{ pairings: PendingPairing[] }>('/api/auth/pairing'),
  /** 已授权设备：审批通过（携带审批方输入的 6 位配对码，服务端核对防误批）。 */
  approvePairing: (pairingId: string, code: string) =>
    post<{ ok: boolean }>('/api/auth/pairing/approve', { pairingId, code }),
  /** 已授权设备：拒绝配对。 */
  denyPairing: (pairingId: string) =>
    post<{ ok: boolean }>('/api/auth/pairing/deny', { pairingId }),
  /** 已授权设备列表（设置页设备管理）。 */
  listDevices: () => get<{ devices: AuthorizedDevice[] }>('/api/auth/devices'),
  /** 撤销设备（立即生效）。 */
  revokeDevice: (id: string) => del<{ ok: boolean }>(`/api/auth/devices/${encodeURIComponent(id)}`),
}

export type { AuthorizedDevice, PairingRequestResult, PairingStatus, PendingPairing }
export { authAPI }
