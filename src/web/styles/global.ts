import { css } from '@linaria/core'

// linaria v5: 每个全局选择器单独用 :global(...)，不嵌套 :global() { block }。
// 设计令牌来自 haze-ui（--haze-color-* 等），由 main.tsx 挂载 spacing/typography/motion
// 静态类、ThemeContext 切换 haze-colors__lightTheme/darkTheme 颜色类。
//
// 原生控件基础样式只作用于非 haze 控件（:not([class*='haze-'])）：haze 的
// Input/Select/Textarea/Button 自带完整样式与焦点环，全局规则不再叠加。
// 保留原生外观的领域控件（ModelSelector/DirectoryPicker 自由输入、配对码、
// JsonConfigEditor 等）继续吃这套基础样式。
const NATIVE = ':not([class*="haze-"])'

export const globalStyle = css`
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  /**
   * 原生 <dialog> 靠 UA 默认样式表的 margin:auto 在 top layer 内水平+垂直居中；
   * 上面的 \`* { margin: 0 }\` 通配把它抹成 0，导致所有弹层（删除项目、添加项目、
   * 分段、提交审查等 8 个 Dialog 使用方）贴在视口左上角而非居中。显式还原。
   */
  :global(dialog:modal) {
    margin: auto;
  }
  :global(html),
  :global(body),
  :global(#root) {
    height: 100%;
  }
  :global(body) {
    /* CJK 后备栈显式声明：裸 sans-serif 在各平台的 CJK 回退不一致
     * （Linux 常落到 bitmap/宋体系字体），固定 pingfang/雅黑/Noto 的顺序。 */
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC',
      'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;
    /* reset 未定义 line-height，浏览器 normal 对 CJK 只有 ~1.2，界面文字拥挤 */
    line-height: 1.5;
    background: var(--haze-color-bg);
    color: var(--haze-color-text);
    -webkit-font-smoothing: antialiased;
  }
  /* 等宽栈：裸 monospace 会落到 Courier/点阵字体，质量不可控 */
  :global(code),
  :global(pre),
  :global(kbd),
  :global(samp) {
    font-family: ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas,
      'Liberation Mono', 'Noto Sans Mono CJK SC', monospace;
  }
  /* 选区颜色随主题：默认蓝/深色下原生选区与 token 配色冲突 */
  :global(::selection) {
    background: color-mix(in srgb, var(--haze-color-primary) 24%, transparent);
  }
  :global(button) {
    cursor: pointer;
    font: inherit;
  }
  /*
   * 表单控件全局基础样式：原生 input/select/textarea 回退到这里，
   * 用 CSS 变量随明暗主题切换，避免暗色模式下出现白底黑字。
   */
  :global(input${NATIVE}),
  :global(select${NATIVE}),
  :global(textarea${NATIVE}) {
    font: inherit;
    color: var(--haze-color-text);
    background: var(--haze-color-bg);
    border: 1px solid var(--haze-color-border);
    border-radius: 6px;
    padding: 8px 10px;
    min-height: 44px;
  }
  /* select 自定义箭头：原生箭头在暗色下不可见，统一用中性灰三角 */
  :global(select${NATIVE}) {
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='%238a8a8a' d='M6 8L2 4h8z'/></svg>");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 30px;
  }
  :global(textarea${NATIVE}) {
    resize: vertical;
  }
  :global(input${NATIVE}:focus),
  :global(select${NATIVE}:focus),
  :global(textarea${NATIVE}:focus) {
    outline: none;
    border-color: var(--haze-color-primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--haze-color-primary) 50%, transparent);
  }
  :global(input${NATIVE}::placeholder),
  :global(textarea${NATIVE}::placeholder) {
    color: var(--haze-color-text-secondary);
  }
  /* 细滚动条：暗色下系统默认粗滚动条刺眼且挤压内容宽度；thumb 用中性灰随主题切换 */
  :global(*) {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--haze-color-text-secondary) 45%, transparent) transparent;
  }
  :global(::-webkit-scrollbar) {
    width: 8px;
    height: 8px;
  }
  :global(::-webkit-scrollbar-thumb) {
    background: color-mix(in srgb, var(--haze-color-text-secondary) 45%, transparent);
    border-radius: 4px;
  }
  :global(::-webkit-scrollbar-thumb:hover) {
    background: color-mix(in srgb, var(--haze-color-text-secondary) 70%, transparent);
  }
  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }
  :global(::-webkit-scrollbar-corner) {
    background: transparent;
  }
  :global(input${NATIVE}:disabled),
  :global(select${NATIVE}:disabled),
  :global(textarea${NATIVE}:disabled) {
    opacity: 0.6;
    cursor: not-allowed;
  }
  /* 复选框/单选/范围条不套用统一尺寸，保留原生外观 */
  :global(input[type='checkbox']),
  :global(input[type='radio']) {
    min-height: 0;
    padding: 0;
    width: 18px;
    height: 18px;
    accent-color: var(--haze-color-primary);
  }
  :global(input[type='range']) {
    min-height: 0;
    padding: 0;
    accent-color: var(--haze-color-primary);
  }
  /*
   * 统一按钮基础：仅原生按钮（组件类按钮自持样式或走 haze Button）。
   *
   * 整条规则必须包在 :where() 里——:where() 内部的选择器特异度为 0，
   * 因此本规则只当「裸按钮的兜底底色」，任何组件自带的 linaria 类都能正常覆盖它。
   * 此前直接写 button:not([class*="haze-"])，其特异度为 (0,1,1)，
   * 高于任何单类 (0,1,0)：全站 11 个自绘按钮（segBtn/toolBtn/btn/dangerBtn/
   * actionBtn/linkBtn/btnSm…）的 padding、background、border、color 全被压掉。
   * 后果不是「样式不好看」而是语义丢失——
   *   - dangerBtn 声明的 background: var(--haze-color-danger) 被中性底色覆盖，
   *     「清空回收站」这类不可逆操作的确认按钮与「取消」渲染得完全一样；
   *   - segBtnActive 的 primary 底色同样被覆盖，分段控件的选中项与未选中项
   *     背景/文字色/字重全部一致，用户无法判断当前处于哪个视图。
   * :not([class*="haze-"]) 仍用于排除 haze 自带样式的控件（Input/Select/Button）。
   */
  :global(:where(button${NATIVE})) {
    color: var(--haze-color-text);
    background: var(--haze-color-bg-subtle);
    border: 1px solid var(--haze-color-border);
    border-radius: 6px;
    padding: 8px 12px;
    transition: background 0.15s, border-color 0.15s;
  }
  :global(:where(button${NATIVE}):hover:not(:disabled):not([aria-disabled='true'])) {
    background: color-mix(in srgb, var(--haze-color-bg-subtle) 80%, var(--haze-color-text) 8%);
  }
  /* 键盘可达性：Tab 聚焦时与输入控件同款焦点环（鼠标点击不触发） */
  :global(:where(button${NATIVE}):focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--haze-color-primary) 50%, transparent);
    border-color: var(--haze-color-primary);
  }
  /*
   * 禁用态全局语义：真实 disabled 与 aria-disabled 等同——文字降对比度、
   * 背景变浅、cursor:not-allowed，hover 已被上方 :not() 守卫排除。
   */
  :global(:where(button${NATIVE}):disabled),
  :global(:where(button${NATIVE})[aria-disabled='true']) {
    color: var(--haze-color-text-muted);
    background: var(--haze-color-bg-muted);
    cursor: not-allowed;
  }

  /*
   * Shiki 双主题切换：highlightCode 以 themes:{light,dark} 输出——内联样式固定
   * light 值、--shiki-dark* 变量携带 dark 值，需消费方按主题换读变量。
   * 主题判定锚点是 ThemeContext 写在 html 上的 data-theme（haze 主题类名不可
   * 被本文件静态引用），!important 用于压过内联样式。缺这组规则时暗色主题下
   * 代码块仍是亮色配色（深底黑字近乎不可读）。
   */
  :global(html[data-theme='dark'] .shiki),
  :global(html[data-theme='dark'] .shiki span) {
    color: var(--shiki-dark) !important;
    background-color: var(--shiki-dark-bg) !important;
    font-style: var(--shiki-dark-font-style) !important;
    font-weight: var(--shiki-dark-font-weight) !important;
    text-decoration: var(--shiki-dark-text-decoration) !important;
  }

  /*
   * light 态 warning token 覆写：haze 默认 oklch(0.769 0.165 70.1) 在白底
   * 对比度仅 2.1（AA 需 4.5），而该 token 被 15+ 处当正文色（警示条/pill/
   * git 状态/预算告警）。输出色保持琥珀色相、只压低明度；暗色不动
   * （dark 值 CR≈11）。实色用途（实心按钮底）随之变深反而更高对比。
   *
   * 明度由 0.55 再降到 0.53：warning 常被铺在自身 10% 淡底上
   * （color-mix(warning 10%)，实测合成底 #f6efe9 而非纯白），混合底
   * 比白底更暗、对比更差——0.55 在该底上只有 4.42，在权限条 pill
   * （warning 10% 底 + 边框）上更只有 4.15，均低于 AA 要求的 4.5。
   * 0.53 在两种底上分别为 4.83 / 4.7，白底上 5.5。
   */
  :global(html[data-theme='light']) {
    --haze-color-warning: oklch(0.53 0.12 55);
  }

  /*
   * primary-on-tinted：primary 蓝被铺在「自身色相的淡底」上时用。
   *
   * --haze-color-primary 面向白/浅底设计（light 值 oklch(0.563 0.241 260.8)
   * 在白底 4.83），但若把它放在 primary 10% / warning 10% 这类混合淡底上，
   * 合成底比白底更暗、对比更差：SetupBanner 的「去设置」CTA 铺在
   * warning 10% 底（#f6efe9）上时实测仅 4.24，低于 AA 要求的 4.5。
   *
   * 仅压低 light 态明度到 0.535（同色相同彩度，白底 5.47、淡底 4.81）；
   * dark 态不动，沿用 --haze-color-primary 本身——暗色主题下 primary 是
   * 亮蓝（#005cf5），本来就在深底上够亮，若沿用 light 的压暗值反而
   * 掉到 2.86。token 只在需要「蓝字压在淡底上」处用，其余场景继续用
   * --haze-color-primary。
   *
   * 实底色上的前景色（-on-solid）：primary/danger/success/warning 被当
   * **背景**铺满一个按钮时，文字色必须由这组 token 决定，而不是各处写死
   * color:#fff。haze 的语义色都是按「当文字色压在深底/白底上」调校的，
   * 本仓却大量把它们当实底用，于是同一个 token 在两个主题下承担两种角色，
   * 写死前景必然有一侧不达标。真实浏览器 axe-core 实测（修复前 → 修复后）：
   *
   *   primary   设置页分段选中态 / 提交按钮 / 发送 / 粘贴条
   *             dark 3.00:1 → 4.87（前景 oklch(0.28 0 0)）；light 4.84 不变
   *   　　　　　 悬停底色另走 --c0de-primary-hover-solid：
   *             --haze-color-primary-hover 的「base 减明度」对实底是反的
   *             （dark 4.07 / 3.58），改为暗色提亮（0.72 → 5.66）、
   *             亮色压暗（0.53 → 5.56），方向随前景色定
   *   danger    红字「删除」（tokens.btnDanger）dark 4.43 → 5.27
   *             （-on-surface，只抬明度、色相不变）
   *   　　　　　 实底确认（DangerConfirmDialog / 停止 / 提交失败）
   *             dark 3.76 → 5.16；light 4.83 不变
   *   success   提交成功态 dark 2.28 → 8.53；light 5.02 不变
   *   warning   「仍然提交」（CommitReviewDialog）dark 1.67 → 11.63；light 5.50 不变
   *
   * 均只调明度、不动色相与彩度，实心按钮在两侧仍是同一个蓝/红/绿/琥珀。
   */
  :global(html[data-theme='light']) {
    --c0de-primary-on-tint: oklch(0.535 0.241 260.8);
    /* danger 当文字色压在白/浅灰底上本就达标（4.55 / 4.5），沿用原值。 */
    --c0de-danger-on-surface: var(--haze-color-danger);
    --c0de-primary-on-solid: #fff;
    /* 亮色下前景是白字，悬停往暗走。 */
    --c0de-primary-hover-solid: oklch(0.53 0.241 260.8);
    /* light 的 danger/success/warning 实底上白字分别为 4.83 / 5.02 / 5.50，达标。 */
    --c0de-danger-on-solid: #fff;
    --c0de-success-on-solid: #fff;
    --c0de-warning-on-solid: #fff;
  }
  :global(html[data-theme='dark']) {
    --c0de-primary-on-tint: var(--haze-color-primary);
    /*
     * danger 当文字色压在 bg-subtle（≈#1e1e1e）上实测 4.43:1，差 AA 的 4.5
     * 一点点——红字「删除」几乎读不出来，而这恰恰是最需要被看清的一类控件。
     * 只抬明度到 0.68，三种底色分别为 5.96 / 5.31 / 4.57。
     */
    --c0de-danger-on-surface: oklch(0.68 0.208 25.3);
    /*
     * 暗色下实底是亮色系，前景一律取近黑；亮色下实底是深色系，前景取白。
     */
    --c0de-primary-on-solid: oklch(0.28 0 0);
    --c0de-primary-hover-solid: oklch(0.72 0.174 258.5);
    --c0de-danger-on-solid: oklch(0.16 0 0);
    --c0de-success-on-solid: oklch(0.16 0 0);
    --c0de-warning-on-solid: oklch(0.16 0 0);
  }

  /*
   * 锚点键盘焦点环：UA 的 outline:auto 在暗色主题解析为近黑色（跟随文字色），
   * 深色底上不可见——导航链接/品牌/外链此前键盘聚焦无任何可见反馈。
   */
  :global(a:focus-visible) {
    outline: 2px solid var(--haze-color-primary);
    outline-offset: 2px;
    border-radius: 2px;
  }

  /*
   * div[role=button] 键盘焦点环：同上一条的原因，且更严重——这些元素是
   * div 上挂 role/tabIndex，:where(button) 那条规则完全选不中，实测
   * ToolBlock 折叠头在暗色主题下聚焦后 outline 解析为 rgb(16,16,16)，
   * 压在 oklch(0.182 0 0)（≈ #020202）底上，对比度仅 1.09:1，等于没有焦点。
   *
   * 命中面：ToolBlock 折叠头、MessageItem 的 shake 块。二者都是 tabIndex=0
   * 且响应 Enter/Space 的真交互元素，键盘用户必须能看见自己在哪。
   * :focus-visible 而非 :focus——鼠标点击不显示焦点环，与 button/a 保持一致。
   */
  :global(:where([role='button']):focus-visible) {
    outline: 2px solid var(--haze-color-primary);
    outline-offset: 2px;
    border-radius: 4px;
  }

  /*
   * 动效降级（WCAG 2.3.3 Animation from Interactions / 2.2.2）。
   *
   * 本应用此前全站零 prefers-reduced-motion 处理，四处动画照常无限循环：
   * 提交按钮脉冲（CommitButton pulse 2s infinite）、骨架屏呼吸
   * （ChatView skeletonPulse 1.5s infinite）、工作流节点脉冲
   * （WorkflowGraph wf-pulse 1.2s infinite）、生成中进度点
   * （Chat wfProgressPulse 1.4s infinite）。前庭功能障碍用户开启系统
   * 「减少动态效果」后，这些循环仍持续播放——实测 emulated
   * prefers-color-scheme/media=reduce 下 animation-iteration-count 仍为 infinite。
   *
   * 收敛成一条全局规则而非逐个组件加媒体查询：动画定义分散在 4 个文件，
   * 漏一处就等于该处照旧播放；且 haze-ui 内部动画（tooltip 浮入等）本项目
   * 同样无法逐个改写。全局归零一次覆盖全部来源，新加动画自动受约束。
   *
   * 只归零 animation/transition 的时长与位移，不隐藏元素、不改 layout——
   * 骨架屏与进度点停在各自的静态终态（opacity 0.45 / 1、scale(1)），
   * 「正在加载」这一信息本身仍然可见。跳过 scroll-behavior：设置页 TOC
   * 分区跳转的平滑滚动是导航反馈而非装饰，且瞬时滚动会让人失去方位感。
   */
  @media (prefers-reduced-motion: reduce) {
    :global(*),
    :global(*::before),
    :global(*::after) {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
`
