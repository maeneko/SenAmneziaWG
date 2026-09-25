# SenAWG
Простой VPN клиент [AmneziaWG](https://github.com/amnezia-vpn/amneziawg-go) для проекта [SenAmnesia](https://amnesia.ma7neko.ru/)

- Конфиги всех поколений: обычный WireGuard, AmneziaWG legacy, 2.0, 3.0 и 3.1.
- Несколько серверов, переключение одной кнопкой, статистика и журнал туннеля.
- При полном туннеле на Windows весь трафик и DNS мимо VPN блокируются (WFP).
- Linux — см. [docs/linux.md](docs/linux.md): реализовано, но ещё не проверялось на настоящей машине.
- VPN живёт ровно столько, сколько приложение: закрыли окно, упало, сняли процесс — туннель, маршруты и DNS
  возвращаются как было, фоновых служб не остаётся.
- Автозапуск, подключение к последнему серверу, удаление программы прямо из настроек.

## Сборка

Нужны Node 24 и Go (версия — в `helper/go.mod`).

```bash
npm install          # заодно собирает движок под текущую систему (если есть Go)
npm run dev          # приложение в режиме разработки
npm test             # тесты (vitest)
npm run typecheck
(cd helper && go test ./...)

npm run build:mac    # dist/SenAWG-<версия>-<arch>.dmg      — только на macOS
npm run build:win    # dist/SenAWG-<версия>-setup.exe (x64) — на Windows или macOS, wine не нужен
npm run build:linux  # dist/SenAWG-<версия>-linux-x64.run — на Linux или macOS
```
## Лицензия

[GNU GPL v3.0](LICENSE). Сторонние компоненты и их лицензии — [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
