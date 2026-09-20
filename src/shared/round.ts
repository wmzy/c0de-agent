/**
 * 按十进制语义舍入到指定小数位（half-up）。
 *
 * `x.toFixed(n)` 直接作用于二进制浮点近似值：1.005 在内存中是 1.004999…，
 * toFixed 舍入为 "1.00"——少一分钱（0.015→"0.01"、2.675→"2.67" 同类）。
 * Intl.NumberFormat 按最短十进制表示舍入，消除该系统性偏差；返回值仍为
 * number（无分组符），调用方再以 toFixed 输出显示字符串。
 *
 * 无 node 依赖：web（vite tsconfig 无 node types）与服务端均可引用。
 */
function roundTo(value: number, digits: number): number {
  return Number(
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    }).format(value),
  )
}

export { roundTo }
