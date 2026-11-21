import { describe, expect, it } from 'vitest'
import { buildWorkflowNotice, WORKFLOW_NOTICE } from './workflow.js'

// workflowz 关键词检测测试已随实现迁至 magic-keywords.test.ts。

describe('WORKFLOW_NOTICE', () => {
  it('is a non-empty system notice', () => {
    expect(WORKFLOW_NOTICE.length).toBeGreaterThan(0)
  })

  it('references the task tool and batch fan-out', () => {
    expect(WORKFLOW_NOTICE).toContain('task')
    expect(WORKFLOW_NOTICE).toContain('tasks[]')
    expect(WORKFLOW_NOTICE).toContain('context')
  })

  it('mentions available subagent types', () => {
    expect(WORKFLOW_NOTICE).toContain('coder')
    expect(WORKFLOW_NOTICE).toContain('researcher')
    expect(WORKFLOW_NOTICE).toContain('reviewer')
    expect(WORKFLOW_NOTICE).toContain('general')
  })

  it('includes decomposition guidance', () => {
    expect(WORKFLOW_NOTICE).toContain('Decompose')
    expect(WORKFLOW_NOTICE).toContain('fan-out')
  })

  it('uses MUST language to enforce task tool usage', () => {
    expect(WORKFLOW_NOTICE).toContain('MUST')
    expect(WORKFLOW_NOTICE).toContain('task')
  })
})

describe('buildWorkflowNotice', () => {
  it('appends registered workflows section when workflows provided', () => {
    const notice = buildWorkflowNotice([
      { name: 'security-audit', description: '安全审计' },
      { name: 'code-review', description: '代码审查' },
    ])
    expect(notice).toContain('registered-workflows')
    expect(notice).toContain('security-audit')
    expect(notice).toContain('code-review')
  })

  it('shows empty-state message when workflows list is empty', () => {
    const notice = buildWorkflowNotice([])
    expect(notice).toContain('workflowz')
    expect(notice).toContain('registered-workflows')
    expect(notice).toContain('No saved workflow scripts yet')
  })
})
