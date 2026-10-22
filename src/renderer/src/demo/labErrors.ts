/*
 * The error catalog (src/shared/errorCatalog.ts) as the lab plays it: with «Коды ошибок» on in the panel, the made-up
 * main process answers «КОД: текст», the page shows the code after the text (components/ErrorText.tsx), and the
 * journal gets «[КОД] текст».
 */
import { ERRORS, errorMessage, logMessage, codedMessage, type ErrorCode } from '@shared/errorCatalog'

/** Sample values for the catalog's parameters, so that every code reads as a finished sentence. */
const PARAMS: Partial<Record<ErrorCode, Record<string, string>>> = {
  'LNK-04': { kind: 'sen://' },
  'CFG-02': { field: 'адреса сервера (Endpoint)' },
  'CFG-03': { key: 'Приватный ключ' },
  'CFG-08': { param: 'Jc' },
  'CFG-09': { param: 'I6' },
  'MA7-06': { reason: 'Промокод уже использован' },
  'REP-03': { max: '4000' },
  'UPD-09': { version: '0.9.0' },
  'UPD-19': { package: 'zstd' },
  'UPD-28': { folder: '/Applications' },
  'TUN-14': { action: 'запустила' },
  'NET-02': { host: 'vpn.example.com' },
  'NET-10': { target: '1.1.1.1:443' },
  'NET-11': { target: '1.1.1.1:443' },
  'NET-12': { server: '1.1.1.1' },
  'RTE-01': { prefix: 'host', allowed: 'domain, suffix, keyword, regex, ip, ruleset, processName, processPath' },
  'RTE-11': { min: '8' },
  'RTE-13': { rule: 'processName:spotify', reason: 'правила по программам работают только в Linux' },
  'RTE-16': { address: '127.0.0.1:53' },
  'SVC-13': { package: 'polkit' },
  'SVC-14': { action: 'сохранить' },
  'PRM-02': { action: 'подключиться' },
  'STO-01': { store: 'Secret Service' },
  'INS-01': { folder: '/home/user/SenAWG', hint: 'папку, которую меняет только администратор, например /opt/SenAWG' },
  'INS-04': { folder: 'C:\\Program Files\\SenAWG' },
  'INS-13': { folders: 'C:\\Program Files\\SenAWG\\resources' }
}

export const ALL_CODES = Object.keys(ERRORS) as ErrorCode[]
/** What an action can end with: not the hints under fields, not SenAWG's own bugs, not the journal-only lines. */
export const SHOWN_CODES = ALL_CODES.filter((code) => !('kind' in ERRORS[code]))

export const labText = (code: ErrorCode): string => errorMessage(code, PARAMS[code])
export const labCoded = (code: ErrorCode): string => codedMessage(code, PARAMS[code])
export const labLogged = (code: ErrorCode): string => logMessage(code, labText(code))
