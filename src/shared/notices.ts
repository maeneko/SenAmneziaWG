import type { AppNotice } from './types'

/**
 * The one notice the main process sends so far, to try the window on; the lab starts with it too. Only
 * for those with a «Профиль» (a master key naming an MA7 login): the notices to come are about that account.
 * Closed once, it is gone for good (settings.json, dismissedNotices).
 */
export const BETA_NOTICE: AppNotice = {
  id: 'notices-beta',
  tone: 'warn',
  priority: 'normal',
  title: 'Это бета версия уведомлений :D',
  dismissible: true,
  at: 0
}
