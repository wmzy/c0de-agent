// P2-16：设备配对 API 服务。
import { apiRequest } from './api.js'

type PairingRequestResult = { pairingId: string; code: string }

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
}

const authAPI = {
  /** 新设备发起配对请求（公开端点）。 */
  requestPairing: (deviceName: string) =>
    apiRequest<PairingRequestResult>('/api/auth/pairing/request', {
      method: 'POST',
      body: JSON.stringify({ deviceName }),
    }),
  /** 新设备轮询审批结果（公开端点）。 */
  pairingStatus: (pairingId: string) =>
    apiRequest<PairingStatus>(
      `/api/auth/pairing/status?pairingId=${encodeURIComponent(pairingId)}`,
    ),
  /** 已授权设备：列出待审批配对。 */
  listPairings: () => apiRequest<{ pairings: PendingPairing[] }>('/api/auth/pairing'),
  /** 已授权设备：审批通过。 */
  approvePairing: (pairingId: string) =>
    apiRequest<{ ok: boolean }>('/api/auth/pairing/approve', {
      method: 'POST',
      body: JSON.stringify({ pairingId }),
    }),
  /** 已授权设备：拒绝配对。 */
  denyPairing: (pairingId: string) =>
    apiRequest<{ ok: boolean }>('/api/auth/pairing/deny', {
      method: 'POST',
      body: JSON.stringify({ pairingId }),
    }),
}

export type { PairingRequestResult, PairingStatus, PendingPairing }
export { authAPI }
