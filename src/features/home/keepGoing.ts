import { useNavigate } from 'react-router-dom'
import { useAppState } from '../../app/state'
import { keepGoing } from '../../data/repo'
import { requestSync } from '../../data/sync'
import { playLink } from './HomePage'

/** Start the next item of today's plan, adding a bonus round first when everything is done. */
export function useKeepGoing() {
  const { exercises, settings } = useAppState()
  const navigate = useNavigate()
  return async (replace = false) => {
    const next = await keepGoing(exercises, settings.speed)
    requestSync()
    navigate(next ? playLink(next.item, next.plan) : '/practice', { replace })
  }
}
