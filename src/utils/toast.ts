import { useToast } from 'haze-ui'

let _toast: ReturnType<typeof useToast> | null = null

export function setToastHandler(t: ReturnType<typeof useToast>) {
  _toast = t
}

export const toast = {
  success(msg: string) {
    _toast?.(msg, { variant: 'success' })
  },
  error(msg: string) {
    _toast?.(msg, { variant: 'danger' })
  },
  warning(msg: string) {
    _toast?.(msg, { variant: 'warning' })
  },
  info(msg: string) {
    _toast?.(msg, { variant: 'info' })
  },
}
