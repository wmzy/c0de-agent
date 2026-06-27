import readline from 'node:readline/promises'

type PromptInterface = {
  question: (q: string) => Promise<string>
  close: () => void
}

type ConfirmOptions = {
  defaultYes?: boolean
  /** 测试注入。 */
  rl?: PromptInterface
}

async function confirm(question: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const defaultYes = opts.defaultYes ?? false
  const hint = defaultYes ? '[Y/n]' : '[y/N]'
  const rl = opts.rl ?? readline.createInterface({ input: process.stdin, output: process.stdout })
  const own = !opts.rl
  try {
    const answer = (await rl.question(`${question} ${hint} `)).trim().toLowerCase()
    if (answer === '') return defaultYes
    return answer === 'y' || answer === 'yes'
  } finally {
    if (own) rl.close()
  }
}

export type { ConfirmOptions, PromptInterface }
export { confirm }
