import { discoverWorkflows } from './discovery.js'
import type { WorkflowRegistry } from './registry.js'
import type { WorkflowEntry } from './types.js'

/**
 * 统一工作流解析：按「项目（已信任）> 用户 > 内置」优先级查找同名工作流。
 *
 * 此前各消费方口径分裂：列表（GET /、/workflow list）项目级覆盖注册表，
 * 而运行/查看（REST GET /:name、POST /:name/run、chat 斜杠、slash resolveEntry）
 * 是注册表优先——项目级同名工作流被用户级/内置条目遮蔽，UI 显示项目版、
 * 实际执行另一份。全部调用点必须经此函数收敛。
 *
 * 项目级发现受信任门禁：discoverWorkflows 会 dynamic import 仓库代码
 * （模块顶层即刻执行），未信任/漂移的项目绝不发现（fail-closed，回退注册表）。
 */
async function resolveWorkflow(opts: {
  name: string
  registry?: WorkflowRegistry | null
  /** 项目目录（agent cwd / 项目 worktree）；缺省不发现项目级工作流。 */
  projectDir?: string
  /** 项目当前是否可信（trustedAt + 指纹一致）。false/缺省 → 跳过项目级发现。 */
  projectTrusted?: boolean
}): Promise<WorkflowEntry | undefined> {
  const { name, registry, projectDir, projectTrusted } = opts
  if (projectDir && projectTrusted) {
    const discovered = await discoverWorkflows(projectDir)
    const projectEntry = discovered.find((w) => w.meta.name === name)
    if (projectEntry) return projectEntry
  }
  return registry?.get(name)
}

export { resolveWorkflow }
