import { describe, expect, it } from 'vitest'
import { buildWorkflowNotice, containsWorkflow, WORKFLOW_NOTICE } from './workflow.js'

describe('containsWorkflow — keyword detection', () => {
  it('matches the standalone lowercase trigger word', () => {
    expect(containsWorkflow('workflowz')).toBe(true)
    expect(containsWorkflow('please workflowz this rollout')).toBe(true)
    expect(containsWorkflow('design the workflowz')).toBe(true)
  })

  it('ignores old triggers, casing, inflections, and path-embedded forms', () => {
    expect(containsWorkflow('workflow')).toBe(false)
    expect(containsWorkflow('workflows')).toBe(false)
    expect(containsWorkflow('Workflowz')).toBe(false)
    expect(containsWorkflow('WORKFLOWZ')).toBe(false)
    expect(containsWorkflow('workflowzed the build')).toBe(false)
    expect(containsWorkflow('reworkflowz everything')).toBe(false)
    expect(containsWorkflow('packages/coding-agent/test/modes/workflowz.test.ts')).toBe(false)
    expect(containsWorkflow('nothing to see here')).toBe(false)
  })

  it('ignores keyword inside code blocks', () => {
    expect(containsWorkflow('```\nworkflowz\n```')).toBe(false)
    expect(containsWorkflow('Some text\n```ts\nconst x = "workflowz"\n```')).toBe(false)
  })

  it('ignores keyword inside inline code', () => {
    expect(containsWorkflow('use `workflowz` keyword')).toBe(false)
    expect(containsWorkflow('check `workflowz.ts`')).toBe(false)
  })

  it('detects keyword in prose alongside code blocks', () => {
    expect(
      containsWorkflow('Here is some code:\n```ts\nconst x = 1\n```\n\nNow workflowz this.'),
    ).toBe(true)
  })

  it('matches in CJK prose without ASCII spaces (中文无词间空格)', () => {
    expect(containsWorkflow('请workflowz，部署')).toBe(true)
    expect(containsWorkflow('workflowz。')).toBe(true)
    expect(containsWorkflow('用workflowz方式来')).toBe(true)
    expect(containsWorkflow('（workflowz）')).toBe(true)
    expect(containsWorkflow('帮我workflowz这个功能')).toBe(true)
  })

  it('matches when followed by ASCII punctuation (sentence end)', () => {
    expect(containsWorkflow('do this workflowz, then report')).toBe(true)
  })

  it('handles empty string', () => {
    expect(containsWorkflow('')).toBe(false)
  })
})

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
