import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** glob/grep 工具遍历时固定跳过的目录：依赖与构建产物（点开头目录里只跳
 *  .git——workflows 侧的 walkTree 是「跳过全部点开头条目」的更严口径，勿混用）。 */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.turbo'])

/** 递归遍历目录树，对每个非目录条目回调 onFile（附完整路径与文件名，文件名供
 *  不含路径分隔符的 glob 模式按名匹配）。readdir 失败（权限/消失竞态）静默跳过
 *  该目录。目录是否下钻由 skipDir 判定；回调抛错正常冒泡。
 *  glob/grep（收集路径清单）与 workflows 的 walkTree（回调消费）共用此骨架。 */
async function walkFiles(
  dir: string,
  opts: { skipDir: (name: string) => boolean },
  onFile: (fullPath: string, name: string) => Promise<void> | void,
): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (opts.skipDir(entry.name)) continue
      await walkFiles(join(dir, entry.name), opts, onFile)
    } else {
      await onFile(join(dir, entry.name), entry.name)
    }
  }
}

export { IGNORE_DIRS, walkFiles }
