import { playClip } from '../../audio/engine'
import { wordAudioUrl } from '../../data/words'

/** The device's English voice, slightly slow. */
export function speak(word: string, onEnd?: () => void): void {
  if (!('speechSynthesis' in window)) return onEnd?.()
  const u = new SpeechSynthesisUtterance(word)
  u.lang = 'en-GB'
  u.rate = 0.85
  if (onEnd) u.onend = u.onerror = () => onEnd()
  speechSynthesis.cancel()
  speechSynthesis.speak(u)
}

/** Say a study word: its recording, or the device's English voice when that can't play. */
export function sayWord(word: string, onEnd?: () => void): void {
  void playClip(wordAudioUrl(word), onEnd).then((ok) => {
    if (!ok) speak(word, onEnd)
  })
}

/** The first part of speech's first two meanings: "adj. 有效率的；能幹的 ／ n. …" → "有效率的；能幹的". */
export function shortZh(zh: string): string {
  return zh
    .split(' ／ ')[0]
    .replace(/^[a-z]+\.\s*/, '')
    .split('；')
    .slice(0, 2)
    .join('；')
}

/** The main part of speech's meanings, keeping its label: "adj. 有效率的；能幹的". */
export function mainZh(zh: string): string {
  return zh.split(' ／ ')[0]
}
