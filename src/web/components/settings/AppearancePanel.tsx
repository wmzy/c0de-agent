import { useTheme } from '../../contexts/ThemeContext.js'
import { field, section, sectionTitle } from './styles.js'

interface AppearancePanelProps {
  locale: string
  onLocaleChange: (locale: string) => void
}

/** 外观配置：主题（由 ThemeContext 管理，存于 localStorage）与界面语言。 */
function AppearancePanel({ locale, onLocaleChange }: AppearancePanelProps) {
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
      <label className={field}>
        <span>语言</span>
        <select value={locale} onChange={(e) => onLocaleChange(e.target.value)}>
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </label>
    </div>
  )
}

export { AppearancePanel }
