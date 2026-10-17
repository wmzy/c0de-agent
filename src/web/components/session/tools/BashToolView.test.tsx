import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BashToolView } from '@/components/session/tools/BashToolView.js'

describe('BashToolView', () => {
  afterEach(cleanup)

  it('渲染命令', () => {
    render(<BashToolView input={{ command: 'ls -la' }} status="running" />)
    expect(screen.getByTestId('bash-command')).toBeInTheDocument()
  })

  it('成功时渲染输出与 exit code', () => {
    render(
      <BashToolView
        input={{ command: 'echo hi' }}
        status="completed"
        output={{ _tag: 'success', output: 'hi', metadata: { exitCode: 0 } }}
      />,
    )
    expect(screen.getByTestId('bash-output')).toHaveTextContent('hi')
    expect(screen.getByTestId('bash-exit')).toHaveTextContent('0')
    expect(screen.queryByTestId('tool-error')).toBeNull()
  })
})
