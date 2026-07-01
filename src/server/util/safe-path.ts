/**
 * safeResolve 已下沉到共享层（src/shared/utils/path.ts），供 tools / server 等
 * 所有层统一引用，避免 tools 层反向依赖 server 层。
 *
 * 本文件仅做 re-export，保持 server 层调用方（chat/files 路由）的对外 API 不变。
 */
export { safeResolve } from '../../shared/utils/path.js'
