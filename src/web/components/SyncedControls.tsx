// 受控控件统一模式（haze-ui ControlOrValue 协议的 prop 驱动形态）。
//
// haze 控件的 value 若传普通值只是「初始值」（内部 useState 自持状态，外部改值不可见）；
// 传 react-use-control 的 Control<T> 才是受控（组件直接读写上游 state 对）。
// 本文件三个包装把「外部值 → 内部 control」的同步封装成单一形态：
//   const [, setV, ctrl] = useControl(value)  // value 作初始种子
//   useEffect(() => setV(value), [value])      // 外部变化 → 内部同步
//   <Input value={ctrl} ... />                  // 用户输入 → 内部状态 + onChange 上抛
// 比 key={value} 重挂载更稳：不丢焦点、不重挂子树；列表行 index-key 复用实例时
// 也靠 effect 同步校正。

import type { InputProps, SelectProps, TextareaProps } from 'haze-ui'
import { Input, Select, Textarea } from 'haze-ui'
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { useControl } from 'react-use-control'

type SyncedInputProps = Omit<InputProps, 'value' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
}

export function SyncedInput({ value, onChange, ...rest }: SyncedInputProps) {
  const [, setV, ctrl] = useControl(value)
  useEffect(() => {
    setV(value)
  }, [value, setV])
  return <Input value={ctrl} onChange={(e) => onChange(e.target.value)} {...rest} />
}

type SyncedSelectProps = Omit<SelectProps, 'value' | 'onChange' | 'onValuesChange'> & {
  value: string
  onValuesChange: (value: string) => void
  children: ReactNode
}

export function SyncedSelect({ value, onValuesChange, children, ...rest }: SyncedSelectProps) {
  const [, setV, ctrl] = useControl(value)
  useEffect(() => {
    setV(value)
  }, [value, setV])
  return (
    <Select value={ctrl} onValuesChange={(next) => onValuesChange(next as string)} {...rest}>
      {children}
    </Select>
  )
}

type SyncedTextareaProps = Omit<TextareaProps, 'value' | 'onChange'> & {
  value: string
  onChange: (value: string) => void
}

export function SyncedTextarea({ value, onChange, ...rest }: SyncedTextareaProps) {
  const [, setV, ctrl] = useControl(value)
  useEffect(() => {
    setV(value)
  }, [value, setV])
  return <Textarea value={ctrl} onChange={(e) => onChange(e.target.value)} {...rest} />
}
