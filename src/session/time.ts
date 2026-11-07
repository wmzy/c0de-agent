/** Convert a Date-like DB value to epoch milliseconds.
 *  timestamp 列经 drizzle 读出为 Date，但快照恢复/导入等路径可能落盘字符串或数字；
 *  统一在此转换，全仓库唯一的 Date-like → ms 口径。 */
export function toEpochMs(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  return new Date(value).getTime()
}
