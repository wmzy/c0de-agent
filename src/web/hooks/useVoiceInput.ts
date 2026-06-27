import { useCallback, useRef, useState } from 'react'

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((e: { results: { 0: { transcript: string } }[] }) => void) | null
  onerror: (() => void) | null
}

export function useVoiceInput(lang = 'zh-CN') {
  const [transcript, setTranscript] = useState('')
  const [listening, setListening] = useState(false)
  const recRef = useRef<SpeechRecognitionLike | null>(null)

  const start = useCallback(() => {
    const Ctor =
      (
        window as unknown as {
          SpeechRecognition?: never
          webkitSpeechRecognition?: new () => SpeechRecognitionLike
        }
      ).webkitSpeechRecognition ??
      (
        window as unknown as {
          SpeechRecognition?: new () => SpeechRecognitionLike
        }
      ).SpeechRecognition
    if (!Ctor) return
    const rec = new Ctor()
    rec.continuous = false
    rec.interimResults = true
    rec.lang = lang
    rec.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript ?? ''
      setTranscript(text)
    }
    rec.onerror = () => setListening(false)
    recRef.current = rec
    rec.start()
    setListening(true)
  }, [lang])

  const stop = useCallback(() => {
    recRef.current?.stop()
    setListening(false)
  }, [])

  return { transcript, listening, start, stop }
}
