import { css } from '@linaria/core'
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  showDetails: boolean
}

const container = css`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: 1;
  height: 100dvh;
  color: var(--text-secondary);
  font-size: 14px;
  padding: 24px;
  text-align: center;
`

const icon = css`
  font-size: 32px;
`

const title = css`
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
`

const reloadBtn = css`
  color: var(--primary);
  text-decoration: none;
  padding: 8px 16px;
  border: 1px solid var(--primary);
  border-radius: 6px;
  background: transparent;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
  &:hover {
    background: var(--primary);
    color: var(--bg, #fff);
  }
`

const detailsToggle = css`
  background: none;
  border: none;
  color: var(--primary);
  cursor: pointer;
  font-size: 13px;
  padding: 4px 8px;
  text-decoration: underline;
`

const details = css`
  max-width: 640px;
  width: 100%;
  text-align: left;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--danger, #e5484d);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  max-height: 40vh;
  overflow-y: auto;
`

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, showDetails: false }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary 捕获到渲染错误:', error, info)
  }

  handleReload = () => {
    window.location.reload()
  }

  toggleDetails = () => {
    this.setState((s) => ({ showDetails: !s.showDetails }))
  }

  render() {
    const { error, showDetails } = this.state
    if (!error) return this.props.children
    return (
      <div className={container}>
        <span className={icon}>⚠️</span>
        <span className={title}>页面渲染出错</span>
        <span>应用遇到了一个意外错误，请尝试重新加载页面。</span>
        <button type="button" className={reloadBtn} onClick={this.handleReload}>
          重新加载
        </button>
        <button type="button" className={detailsToggle} onClick={this.toggleDetails}>
          {showDetails ? '隐藏详情' : '查看详情'}
        </button>
        {showDetails && <pre className={details}>{error.stack ?? error.message}</pre>}
      </div>
    )
  }
}

export default ErrorBoundary
