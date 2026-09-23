// 来源：终端 WS 控制消息与 PTY 输出共流，内容嗅探过宽会把真实输出当控制帧吞掉。
// 判定收敛到 parseTerminalControlMessage（纯函数）后可独立单测。

import { describe, expect, it } from 'vitest'
import { parseTerminalControlMessage } from '@/components/terminal-control.js'

describe('parseTerminalControlMessage', () => {
  it('识别服务端规范控制帧（JSON.stringify 直出形状）', () => {
    expect(parseTerminalControlMessage('{"type":"exit","exitCode":0}')).toEqual({
      type: 'exit',
      exitCode: 0,
    })
    expect(parseTerminalControlMessage('{"type":"exit","exitCode":137}')).toEqual({
      type: 'exit',
      exitCode: 137,
    })
    expect(parseTerminalControlMessage('{"type":"error","message":"Terminal not found"}')).toEqual({
      type: 'error',
      message: 'Terminal not found',
    })
  })

  it('普通终端输出（含 type 字段的 JSON）不再被误判为控制帧', () => {
    // 复现：此前 startsWith('{') + includes('"type"') + type 匹配即吞掉整条输出。
    // 这些是程序/工具的真实输出，必须原样写进终端。
    const outputs = [
      '{"type":"exit","exitCode":0,"payload":"user data"}', // 多字段
      '{"type":"exit","exitCode":"0"}', // exitCode 非数字
      '{"type":"exit"}', // 缺 exitCode
      '{ "type":"exit","exitCode":0 }', // 含空白（非服务端直出形状）
      '{"type":"exit","exitCode":0}\n', // 尾随换行（输出常带）
      '{"type": "error", "message": "boom"}', // 服务端不会带空格
      '{"type":"error","message":"x","stack":"y"}', // 多字段 error
      '{"type":"error","message":42}', // message 非字符串
      '{"type":"progress","percent":50}', // 其他 type
      '{"type":"exit","exitCode":0}{"more":1}', // 拼接内容
      '[{"type":"exit","exitCode":0}]', // 数组
      '{"type":"exit","exitCode":null}', // null 退出码
      // 键序变体：服务端控制帧由 JSON.stringify({type, ...}) 直出，type 恒为首键。
      // JSON.stringify(parsed) === data 的「逐字符相等」层对键序变体**不生效**——
      // JSON.stringify 保留解析出的键序，{"exitCode":0,"type":"exit"} 重序列化后
      // 与原文逐字符相等，能穿过校验被吞成假退出提示（程序打印一条恰好长这样的
      // JSON 输出即触发）。规范化判定必须钉住首键 = type。
      '{"exitCode":0,"type":"exit"}',
      '{"message":"boom","type":"error"}',
    ]
    for (const data of outputs) {
      expect(parseTerminalControlMessage(data), data).toBeNull()
    }
  })

  it('非 JSON / 非对象 / 空帧一律按输出处理', () => {
    for (const data of [
      '',
      'plain text',
      '{',
      '{"type":"exit"',
      '{"type":"exit","exitCode":0', // 截断 JSON
      '42',
      'null',
      '"{\\"type\\":\\"exit\\",\\"exitCode\\":0}"',
      '\u001b[33m{"type":"exit","exitCode":0}',
    ]) {
      expect(parseTerminalControlMessage(data), JSON.stringify(data)).toBeNull()
    }
  })
})
