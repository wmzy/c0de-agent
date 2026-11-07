// 项目信任门禁 + 受门禁的工作流条目解析（chat 路由与 workflows 路由共享）。
//
// 此前 chat.ts（会话门禁）与 workflows.ts（运行门禁）各持一份 409
// TRUST_REQUIRED 内联块，文案与载荷已漂移；工作流条目「项目 > 用户 > 内置」
// 解析同样在 POST run / GET /:name / chat 斜杠通道三处复制，斜杠通道还
// 硬编码 projectTrusted:true 依赖外层聊天门禁。收敛到本模块：信任态查询、
// 门禁评估、条目解析各一个单点，两路由共用。
import type { Context } from 'hono'
import { loadConfigScopes } from '../../core/config.js'
import { resolveWorkflow } from '../../core/workflows/index.js'
import type { WorkflowRegistry } from '../../core/workflows/registry.js'
import type { WorkflowEntry } from '../../core/workflows/types.js'
import { getProject, type Project } from '../../project/project.js'
import {
  enrichProjectRiskWithGlobal,
  projectTrustCurrent,
  projectTrustNeeded,
} from '../../project/trust.js'
import { apiError } from '../middleware/error.js'
import type { ServerContext } from '../types.js'

/** 项目信任状态：项目存在且 trustedAt 非空、风险指纹未漂移。
 *  项目级工作流是仓库自带的任意代码执行面（dynamic import 即执行），发现前
 *  必须校验——与 .c0de/plugins 的加载门禁同口径。 */
async function projectTrustState(
  ctx: ServerContext,
  projectId: string,
): Promise<{ project: Project | null; trusted: boolean }> {
  const project = await getProject(ctx.db, projectId)
  if (!project) return { project: null, trusted: false }
  const trusted =
    project.trustedAt != null &&
    projectTrustCurrent(
      loadConfigScopes(project.worktree).project,
      project.trustedAt,
      project.riskFingerprint,
      project.worktree,
    )
  return { project, trusted }
}

/** 信任门禁：projectTrustNeeded 评估出需用户确认的风险项时返回 409
 *  TRUST_REQUIRED Response（前端弹窗明示风险，用户显式信任后重发）；
 *  放行返回 undefined。信任非永久：trustedAt 落盘时附带风险指纹，其后仓库
 *  git pull 新增风险键（指纹漂移）同样重新触发门禁。
 *  riskSurfaces 为文案点名的配置风险面：工作流入口含 .c0de/workflows
 *  （'.c0de/config.json 或 .c0de/workflows'），聊天入口仅 .c0de/config.json。 */
function trustGateResponse(
  c: Context,
  project: Project,
  opts?: { riskSurfaces?: string },
): Response | undefined {
  const scopes = loadConfigScopes(project.worktree)
  const risks = projectTrustNeeded(
    scopes.project,
    scopes.global,
    project.trustedAt,
    project.riskFingerprint,
    project.worktree,
  )
  if (risks.length === 0) return undefined
  // 并入全局配置的权限风险上下文（不改变门禁触发条件）：用户做信任决策时
  // 能看到完整生效的权限状态（如全局已 auto），避免「信任了项目却困惑于
  // 权限为何仍自动放行」。
  const items = enrichProjectRiskWithGlobal(risks, scopes.global)
  return apiError(
    c,
    409,
    'TRUST_REQUIRED',
    `项目「${project.name ?? project.worktree}」的项目配置（${opts?.riskSurfaces ?? '.c0de/config.json'}）包含需要你确认的风险项`,
    { projectId: project.id, projectName: project.name ?? project.worktree, items },
  )
}

/** 工作流条目解析（「项目 > 用户 > 内置」单点）：按 projectId 查项目并实时
 *  复检信任态，未信任/项目不存在时回退注册表（不 import 仓库代码）。
 *  返回条目与项目/信任态（调用方的门禁、agentCwd/session 解析复用）。 */
async function resolveWorkflowEntry(
  ctx: ServerContext,
  opts: { name: string; registry: WorkflowRegistry; projectId: string | null | undefined },
): Promise<{ entry: WorkflowEntry | undefined; project: Project | null; trusted: boolean }> {
  let project: Project | null = null
  let trusted = false
  if (opts.projectId) {
    const st = await projectTrustState(ctx, opts.projectId)
    project = st.project
    trusted = st.trusted
  }
  const entry = await resolveWorkflow({
    name: opts.name,
    registry: opts.registry,
    projectDir: project?.worktree,
    projectTrusted: trusted,
  })
  return { entry, project, trusted }
}

export { projectTrustState, resolveWorkflowEntry, trustGateResponse }
