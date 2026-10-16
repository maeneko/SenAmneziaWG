import type { RoutingSettings } from './routingRules'

/**
 * Ready-made routing for the help window and docs/routing.md. A test parses every line, so an example cannot
 * go stale when the syntax changes.
 */
export interface RoutingExample {
  title: string
  note?: string
  routing: Pick<RoutingSettings, 'final' | 'proxy' | 'direct' | 'block'>
}

export const ROUTING_EXAMPLES: readonly RoutingExample[] = [
  {
    title: 'Через VPN только нужные сайты',
    note: 'Всё остальное идёт напрямую. Поддомены входят сами.',
    routing: { final: 'direct', proxy: 'suffix:youtube.com\nsuffix:googlevideo.com\nsuffix:ifconfig.me', direct: '', block: '' }
  },
  {
    title: 'Всё через VPN, кроме российских сайтов',
    note: 'Домены .ru, .su и .рф идут напрямую.',
    routing: { final: 'proxy', proxy: '', direct: 'regex:\\.(ru|su|xn--p1ai)$', block: '' }
  },
  {
    title: 'Ozon напрямую',
    note: 'У магазина служебные домены отдельно: картинки и скрипты лежат на ozone.ru, с адреса VPN они не отдаются.',
    routing: { final: 'proxy', proxy: '', direct: 'suffix:ozon.ru\nsuffix:ozone.ru', block: '' }
  },
  {
    title: 'Блокировка рекламы и слежки',
    routing: { final: 'proxy', proxy: '', direct: '', block: 'suffix:doubleclick.net\nkeyword:adservice\nsuffix:ads.example.com' }
  },
  {
    title: 'Приложения через VPN (Linux)',
    note: 'Только Linux. Остальное идёт напрямую.',
    routing: { final: 'direct', proxy: 'processName:spotify\nprocessName:Telegram\ndomain:nura.eco', direct: '', block: '' }
  },
  {
    title: 'Сети по адресам',
    routing: { final: 'proxy', proxy: '', direct: 'ip:192.168.0.0/16\nip:10.0.0.0/8', block: 'ip:203.0.113.0/24' }
  }
]
