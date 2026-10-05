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
   */
  :global(html[data-theme='light']) {
    --c0de-primary-on-tint: oklch(0.535 0.241 260.8);
  }
  :global(html[data-theme='dark']) {
    --c0de-primary-on-tint: var(--haze-color-primary);
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
`
