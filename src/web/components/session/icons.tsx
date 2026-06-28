import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function base(props: IconProps) {
  const { size = 16, ...rest } = props
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    ...rest,
  }
}

export function UserIcon(p: IconProps) {
  return (
    <svg aria-hidden="true" {...base(p)}>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" />
    </svg>
  )
}

export function SparkleIcon(p: IconProps) {
  return (
    <svg aria-hidden="true" {...base(p)}>
      <path d="M8 2l1.5 4.5L14 8l-4.5 1.5L8 14l-1.5-4.5L2 8l4.5-1.5L8 2z" />
    </svg>
  )
}

export function BrainIcon(p: IconProps) {
  return (
    <svg aria-hidden="true" {...base(p)}>
      <path d="M8 3a2.5 2.5 0 00-2.5 2.5v5A2.5 2.5 0 0010 13V5.5" />
      <path d="M10.5 5.5A2.5 2.5 0 0113 8a2.5 2.5 0 01-1 2 2.5 2.5 0 01-1 2" />
    </svg>
  )
}

export function ReadIcon(p: IconProps) {
  return (
    <svg aria-hidden="true" {...base(p)}>
      <path d="M3 2.5h6l4 4v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-9a1 1 0 011-1z" />
      <path d="M9 2.5v4h4" />
    </svg>
  )
}

export function WriteIcon(p: IconProps) {
  return (
    <svg aria-hidden="true" {...base(p)}>
      <path d="M3 2.5h6l4 4v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-9a1 1 0 011-1z" />
      <path d="M9 2.5v4h4M5.5 10h5M5.5 12h3" />
    </svg>
  )
}

export function EditIcon(p: IconProps) {
  return (
    <svg aria-hidden="true" {...base(p)}>
      <path d="M11.5 2.5l2 2L6 12H4v-2l9.5-9.5z" />
    </svg>
  )
}

export function BashIcon(p: IconProps) {
  return (
    <svg aria-hidden="true" {...base(p)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 7l2 1.5L5 10M9 10h2.5" />
    </svg>
  )
}

export function GrepIcon(p: IconProps) {
  return (
    <svg aria-hidden="true" {...base(p)}>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </svg>
  )
}

export function GlobIcon(p: IconProps) {
  return (
    <svg aria-hidden="true" {...base(p)}>
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
      <circle cx="8" cy="8" r="6" />
    </svg>
  )
}

export function ToolIcon(p: IconProps) {
  return (
    <svg aria-hidden="true" {...base(p)}>
      <path d="M10.5 3.5a2 2 0 012.8 2.8L8 11.6 5 12.5 5.9 9.5l4.6-6z" />
    </svg>
  )
}
