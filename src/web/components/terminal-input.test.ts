// 终端命令块输入跟踪（纯函数）。
// 回归：onTermData 逐字符累积此前把 DEL(0x7f) 当可打印字符直接拼进命令文本、
// 退格(0x08)被忽略不删字符、方向键等转义序列的可见片段（如 ↑ 的 "[A"）也被
// 累积——Add to Chat 的命令标签混入控制垃圾且编辑后的命令失真。

import { describe, expect, it } from 'vitest'
import { trackCommandInput } from '@/components/terminal-input.js'

describe('trackCommandInput', () => {
  it('累积可打印字符', () => {
    expect(trackCommandInput('', 'npm i')).toEqual({ text: 'npm i', commands: [] })
    expect(trackCommandInput('npm ', 'i')).toEqual({ text: 'npm i', commands: [] })
  })

  it('\\r 提交当前输入并清空', () => {
    expect(trackCommandInput('ab', '\r')).toEqual({ text: '', commands: ['ab'] })
    expect(trackCommandInput('', 'a\rb')).toEqual({ text: 'b', commands: ['a'] })
  })

  it('多行粘贴：每个 \\r 提交一段（与旧逐字符语义一致）', () => {
    expect(trackCommandInput('', 'a\rb\r')).toEqual({ text: '', commands: ['a', 'b'] })
  })

  it('DEL(0x7f) 删除光标前字符——此前被当可打印字符拼进文本', () => {
    expect(trackCommandInput('npm instal', '\x7f')).toEqual({ text: 'npm insta', commands: [] })
    // 删除后重打正确字符：结果不残留被删字符也不带 DEL 控制码
    expect(trackCommandInput('npm insta', 'l')).toEqual({ text: 'npm instal', commands: [] })
  })

  it('BS(0x08) 同样删除光标前字符——此前被静默忽略导致命令失真', () => {
    expect(trackCommandInput('ab', '\b')).toEqual({ text: 'a', commands: [] })
    expect(trackCommandInput('a', '\bc')).toEqual({ text: 'c', commands: [] })
  })

  it('方向键转义序列整体跳过——此前 ↑ 的 "[A" 片段被拼进命令', () => {
    expect(trackCommandInput('npm i', '\x1b[D\x1b[C')).toEqual({ text: 'npm i', commands: [] })
    // SS3 形式（↑ = ESC O A）
    expect(trackCommandInput('npm i', '\x1bOA\x1bOB')).toEqual({ text: 'npm i', commands: [] })
  })

  it('OSC 序列（标题设置等）整体跳过', () => {
    expect(trackCommandInput('ls', '\x1b]0;some-title\x07')).toEqual({
      text: 'ls',
      commands: [],
    })
  })

  it('孤立 ESC 与字符集切换序列跳过', () => {
    expect(trackCommandInput('a', '\x1b')).toEqual({ text: 'a', commands: [] })
    expect(trackCommandInput('a', '\x1b(B')).toEqual({ text: 'a', commands: [] })
  })

  it('其他控制字符（Tab/Ctrl）忽略', () => {
    expect(trackCommandInput('a', '\t\x01\x02')).toEqual({ text: 'a', commands: [] })
  })

  it('转义序列内的 \\r 不算提交', () => {
    expect(trackCommandInput('a', '\x1b[2J\r')).toEqual({ text: '', commands: ['a'] })
  })
})
