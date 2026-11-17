import { createHash } from 'node:crypto'

/** sha256 hex 摘要的单一实现（project/resolve·trust、server/auth-manager、
 *  session/snapshot、tools/hashline/patch 此前各自内联同款链式调用）。
 *  截长（slice 16/4 等）属各调用点的领域口径，留在调用点。 */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}
