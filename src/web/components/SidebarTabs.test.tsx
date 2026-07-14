import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SidebarTabs } from './SidebarTabs.js'

afterEach(cleanup)

describe('SidebarTabs', () => {
  it('渲染三个 tab 按钮', () => {
    render(
      <SidebarTabs
        activeTab="sessions"
        onSwitch={() => {}}
        sessions={<div data-testid="sessions-content">会话</div>}
        files={<div data-testid="files-content">文件</div>}
        tasks={<div data-testid="tasks-content">任务</div>}
      />,
    )
    expect(screen.getByText('💬会话')).toBeTruthy()
    expect(screen.getByText('📁文件')).toBeTruthy()
    expect(screen.getByText('📋任务')).toBeTruthy()
  })

  it('activeTab=sessions 渲染会话内容', () => {
    render(
      <SidebarTabs
        activeTab="sessions"
        onSwitch={() => {}}
        sessions={<div data-testid="sessions-content">会话</div>}
        files={<div data-testid="files-content">文件</div>}
        tasks={<div data-testid="tasks-content">任务</div>}
      />,
    )
    expect(screen.getByTestId('sessions-content')).toBeTruthy()
    expect(screen.queryByTestId('files-content')).toBeNull()
    expect(screen.queryByTestId('tasks-content')).toBeNull()
  })

  it('activeTab=files 渲染文件内容', () => {
    render(
      <SidebarTabs
        activeTab="files"
        onSwitch={() => {}}
        sessions={<div data-testid="sessions-content">会话</div>}
        files={<div data-testid="files-content">文件</div>}
        tasks={<div data-testid="tasks-content">任务</div>}
      />,
    )
    expect(screen.getByTestId('files-content')).toBeTruthy()
    expect(screen.queryByTestId('sessions-content')).toBeNull()
  })

  it('activeTab=tasks 渲染任务内容', () => {
    render(
      <SidebarTabs
        activeTab="tasks"
        onSwitch={() => {}}
        sessions={<div data-testid="sessions-content">会话</div>}
        files={<div data-testid="files-content">文件</div>}
        tasks={<div data-testid="tasks-content">任务</div>}
      />,
    )
    expect(screen.getByTestId('tasks-content')).toBeTruthy()
    expect(screen.queryByTestId('sessions-content')).toBeNull()
  })

  it('点击 tab 调用 onSwitch', () => {
    const onSwitch = vi.fn()
    render(
      <SidebarTabs
        activeTab="sessions"
        onSwitch={onSwitch}
        sessions={<div />}
        files={<div />}
        tasks={<div />}
      />,
    )
    fireEvent.click(screen.getByText('📁文件'))
    expect(onSwitch).toHaveBeenCalledWith('files')
  })
})
