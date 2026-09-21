# SenAWG

Десктопный клиент [AmneziaWG](https://github.com/amnezia-vpn/amneziawg-go) для Windows и macOS.
Вставляете ключ `vpn://` — получаете подключение, без ручной правки конфигов.

- Конфиги всех поколений: обычный WireGuard, AmneziaWG legacy, 2.0, 3.0 и 3.1.
- Несколько серверов, переключение одной кнопкой, статистика и журнал туннеля.
- При полном туннеле на Windows весь трафик и DNS мимо VPN блокируются (WFP).
- VPN живёт ровно столько, сколько приложение: закрыли окно, упало, сняли процесс — туннель, маршруты и DNS
  возвращаются как было, фоновых служб не остаётся.
- Автозапуск, подключение к последнему серверу, удаление программы прямо из настроек.

## Как устроено

Окно всегда работает с обычными правами. Всё, что требует администратора, делает отдельный процесс:

| | Windows | macOS |
|---|---|---|
| Привилегированная часть | служба `SenAWGHelper` (`helper/`, Go) | скрипт `resources/scripts/awg.sh` от root |
| Движок | `amneziawg-windows` внутри `awg-helper.exe` + Wintun | `amneziawg-go` (universal, закреплён по коммиту) |
| Права администратора | один раз, при установке | при подключении — системный запрос пароля |
| Установщик | `SenAWG-<версия>-setup.exe`: само приложение в режиме установки | `.dmg` |

Подробно: [docs/windows.md](docs/windows.md), [docs/installer.md](docs/installer.md).

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
```

Версия задаётся в одном месте — `version` в `package.json`. Сборки пока не подписаны.

На Windows для `npm run dev` нужна зарегистрированная служба — см. «Разработка на Windows» в
[docs/windows.md](docs/windows.md).

### Экраны без настоящей системы

В режиме разработки (в собранном приложении не действуют):

```bash
AWG_UPDATE_SIMULATE=available|latest|network|revoked|unsupported npm run dev   # карточка «Обновления»
AWG_UNINSTALL_SIMULATE=ok|fail|cancel npm run dev                              # экран удаления
```

## CI/CD

GitHub Actions: тесты на каждый push, установщики для Windows и macOS на push в `master`, загрузка на свой
сервер по любому тегу или релизу. Секреты и порядок выпуска — [docs/ci.md](docs/ci.md).

## Структура

```
src/main/        главный процесс Electron: туннели, настройки, установка, удаление, обновления
src/preload/     мост window.awg
src/renderer/    интерфейс (React); installer/ — экран установки
src/shared/      типы и настройки, общие для всех процессов
helper/          awg-helper.exe — служба Windows (Go)
resources/       awg.sh для macOS; сюда же собираются движки (bin/, win/ — не в git)
scripts/         сборка amneziawg-go, awg-helper.exe и wintun.dll
tests/           тесты vitest
docs/            документация
```

## Лицензия

[GNU GPL v3.0](LICENSE). Используемые компоненты — под своими лицензиями: `amneziawg-go` и
`amneziawg-windows` — MIT, `wintun.dll` — лицензия WireGuard LLC на распространение готовых сборок.
