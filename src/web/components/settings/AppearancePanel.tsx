import { useTheme } from '../../contexts/ThemeContext.js'
import { field, section, sectionTitle } from './styles.js'

/** 外观配置：主题（由 ThemeContext 管理，存于 localStorage）。
 *  P2-11：语言切换已下架（UI 未实现 i18n，切换无实际效果，避免假功能）。 */
function AppearancePanel() {
  const { mode, setMode } = useTheme()

  return (
    <div className={section}>
      <h2 className={sectionTitle}>外观</h2>
      <label className={field}>
        <span>主题</span>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as 'light' | 'dark' | 'system')}
        >
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
      </label>
    </div>
  )
}

export { AppearancePanel }
