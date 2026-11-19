/**
 * Terminal shared types — server PTY 管理器（pty-manager.ts）与 web terminal
 * service（以 TerminalInfo 名消费）共用的终端会话信息形状。此前九字段
 * （含注释）两侧手抄，收敛后本文件即正本。
 */

/** PTY 会话信息（返回给前端）。 */
export interface PTYInfo {
  id: string
  pid: number
  title: string
  cols: number
  rows: number
  cwd: string
  /** shell 程序路径。 */
  shell: string
  /** 所属项目 id（未归属时为 undefined）。 */
  projectId?: string
}
