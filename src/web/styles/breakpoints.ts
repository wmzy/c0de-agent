/**
 * 移动端断点。
 *
 * 上界必须与 haze-ui Workbench 的容器查询边界**逐像素对齐**：
 * haze 内部用 `@container workbench (width <= 768px)`（含 768）决定侧栏/
 * 辅助列收成滑出覆盖层，本文件原来写 767，两者之间留出一整条 768px 的
 * 死宽度——实测 768px 时 sideNav 已是 `visibility:hidden` +
 * `translate(-768px)`，而唯一能打开它的 MobileNav 仍是 `display:none`，
 * 会话列表/文件树在平板竖屏与「窗口收窄到 768–783px」下彻底打不开，
 * 顶栏「会话」链接指回当前页也救不了。
 *
 * 现在 Workbench 进入覆盖层模式 ⟺ MobileNav 可见 ⟺ bottom gutter 生效，
 * 三个消费者共用同一上界。TABLET/DESKTOP 无消费者，已随死宽度一并删除。
 */
export const MOBILE = '@media (max-width: 768px)'
export const TOUCH = '@media (hover: none) and (pointer: coarse)'
