import { motion, spacing, typography } from 'haze-ui/tokens'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'haze-ui/styles.css'
import { App } from '@/App.js'
import '@/styles/global.js'

// haze-ui 令牌激活：颜色类由 ThemeContext 按明暗切换（haze-colors__*Theme），
// 间距/字体/动效为静态类，挂载一次即可。
document.documentElement.classList.add(spacing, typography, motion)

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
