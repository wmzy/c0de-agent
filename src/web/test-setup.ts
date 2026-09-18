import '@testing-library/jest-dom/vitest'

// happy-dom 的 Popover API 不完整：HTMLElement.prototype 上有 popover 属性
// （haze-ui 据此走原生浮层路径），却没有 showPopover/hidePopover/togglePopover
// 方法和 ToggleEvent。补齐最小实现：haze 的浮层引擎监听带 newState 的
// toggle 事件来驱动开合状态，方法本身不需要真实视觉行为。
if (typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover !== 'function') {
  const dispatchToggle = (el: HTMLElement, newState: 'open' | 'closed') => {
    const ev = new Event('toggle')
    Object.defineProperty(ev, 'newState', { value: newState })
    el.dispatchEvent(ev)
  }
  HTMLElement.prototype.showPopover = function (this: HTMLElement) {
    if (!this.hasAttribute('popover')) this.setAttribute('popover', 'auto')
    this.removeAttribute('hidden')
    dispatchToggle(this, 'open')
  }
  HTMLElement.prototype.hidePopover = function (this: HTMLElement) {
    this.setAttribute('hidden', '')
    dispatchToggle(this, 'closed')
  }
  HTMLElement.prototype.togglePopover = function (this: HTMLElement, force?: boolean) {
    const open = force ?? this.hasAttribute('hidden')
    if (open) this.showPopover()
    else this.hidePopover()
    return open
  }
}
