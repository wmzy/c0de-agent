// 「确认类弹窗」家族（TrustRequiredDialog / SegmentBreakDialog /
// DangerConfirmDialog / CommitReviewDialog）的共享样式：正文说明、底部按钮行、
// 基础/主操作/危险操作按钮。此前各弹窗各持一份拷贝，DangerConfirmDialog 的
// 按钮内边距已漂移到 4px（其余为 6px 12px）——统一按 6px 12px 收敛。
import { css } from '@linaria/core'
import { disabledCss } from '@/styles/shared.js'

/** 弹窗正文说明文字。 */
export const confirmBodyText = css`
  color: var(--haze-color-text-secondary);
  font-size: 13px;
  line-height: 1.5;
`

/** 底部按钮行。 */
export const confirmActions = css`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
`

/*
 * 基础按钮声明，纯声明 CSS 文本片段（同 styles/shared.ts 的 ellipsisCss 模式）。
 * 组合的两条铁律（实测，勿破）：
 * 1. 不能插类名：类名插值进 css`` 模板是静默 no-op——产物里只剩本类自身
 *    声明（此前 `${confirmBtn};` 形态，基础 padding/border/cursor 全丢，
 *    TrustRequiredDialog 等单独消费变体类时按钮只剩 global.ts 的
 *    :where(button) 兜底）。
 * 2. 片段必须纯声明或纯嵌套：片段里「顶层声明 + &:hover{} 混排」会破坏
 *    解析——基声明、随后的 &:hover、${disabledCss} 全部丢失，还会产出
 *    `:disabled` 下重复顶层声明的畸形规则。因此 hover 块在各类模板里
 *    逐字写，不进片段。
 * 三个变体各自内插完整基础声明，单独消费（className={confirmPrimaryBtn}）
 * 即拿到 padding/border/cursor/font 全量。
 */
const confirmBtnBaseCss = `
  padding: 6px 12px;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: var(--haze-color-bg-subtle);
  color: var(--haze-color-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
`

/** 基础按钮（取消 / 次级动作）。 */
export const confirmBtn = css`
  ${confirmBtnBaseCss}

  &:hover {
    background: var(--haze-color-bg);
  }
`

/** 主操作按钮：主色实底，前景取面板背景色（浅色主题即白字）。hover 不自带
 *  实底保持/换底规则——模态主操作的悬停反馈交给基础按钮的换底口径（与
 *  confirmBtn 在 className 级并列使用时生效）；与 TodoPanel 内联「添加」键
 *  的 opacity 微降 hover 是不同场景的刻意分工，勿收敛。 */
export const confirmPrimaryBtn = css`
  ${confirmBtnBaseCss}
  border-color: var(--haze-color-primary, var(--haze-color-border));
  background: var(--haze-color-primary, var(--haze-color-bg-subtle));
  color: var(--haze-color-bg, #fff);
`

/*
 * 警告主操作按钮：warning 实底变体（CommitReviewDialog 的「加入 .gitignore
 * 再提交」——落库动作但非危险级）。对比度口径与 confirmDangerBtn 同源：
 * warning token 是按「当文字色用」调的，琥珀实底上白字仅 1.67:1（dark，
 * 全应用最差的一处），前景改走 --c0de-warning-on-solid（见 global.ts）。
 * 悬停保持 warning 实底（同 confirmDangerBtn 的口径）：前景是按实底调的
 * on-solid token，换成浅底两个主题的字都不可读。
 */
export const confirmWarningBtn = css`
  ${confirmBtnBaseCss}
  border-color: var(--haze-color-warning, var(--haze-color-border));
  background: var(--haze-color-warning, var(--haze-color-bg-subtle));
  color: var(--c0de-warning-on-solid, #fff);

  &:hover {
    background: var(--haze-color-warning, var(--haze-color-bg-subtle));
  }
`

/*
 * 危险确认按钮：danger 实底 + on-solid 前景。--haze-color-danger 同样是按
 * 「当文字色用」调的，当实底时白字在两个主题都不过线（实测 dark 3.76 /
 * light 4.82，13px 文字需 4.5）——dark 下这是全应用唯一的「不可恢复」确认
 * 入口，却最难读。改用 --c0de-danger-on-solid：light 沿用白字（4.82 达标），
 * dark 压到足够深的近黑（见 global.ts）。悬停保持 danger 实底（同特异性下
 * 后声明的 &:hover 覆盖基础按钮的换底；global.ts 的按钮 hover 规则整条包
 * 在 :where() 里、特异性为 0，压不过这里）：前景是按实底调的 on-solid
 * token，换成近白底两个主题的字都不可读。
 */
export const confirmDangerBtn = css`
  ${confirmBtnBaseCss}
  border-color: var(--haze-color-danger);
  background: var(--haze-color-danger);
  color: var(--haze-color-danger-on-solid, #fff);

  &:hover {
    background: var(--haze-color-danger);
  }

  ${disabledCss}
`
