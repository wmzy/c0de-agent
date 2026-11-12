import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 递归遍历目录树，对每个非目录条目回调 onFile（附完整路径与文件名，文件名供
 *  不含路径分隔符的 glob 模式按名匹配）。readdir 失败（权限/消失竞态）静默跳过
 *  该目录。目录是否下钻由 skipDir 判定（跳过名单见 shared/utils/path.ts 的
 *  IGNORED_DIR_NAMES）；回调抛错正常冒泡。
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

export { walkFiles }
