# CI/CD

Всё описано в `.github/workflows/ci.yml` (GitHub Actions).

| Когда | Что происходит |
|---|---|
| Любой push и pull request | typecheck, `vitest` (Linux и macOS), `go test` хелпера (Linux и Windows), проверка, что хелпер собирается под Windows |
| Push в `master`/`main` | то же + сборка `SenAWG-<версия>-setup.exe` (Windows) и `.dmg` (macOS); файлы лежат в артефактах запуска 14 дней |
| Любой тег или опубликованный релиз GitHub | то же + загрузка установщиков на сервер |

## Выпуск версии

1. Поднять `version` в `package.json` (единственное место, где она задаётся) и закоммитить.
2. `git tag v0.5.2 && git push origin master v0.5.2` — или создать релиз во вкладке *Releases* на GitHub.

Папка на сервере называется по версии из `package.json`, а не по тегу. Если тег похож на версию (`v0.5.2`,
`0.5.2-beta`) и не совпадает с `package.json`, загрузка остановится с ошибкой: так забытое повышение версии не
перезапишет уже выпущенный релиз. Теги вроде `nightly` проходят и кладут сборку в папку текущей версии.

Релиз, созданный на GitHub вместе с новым тегом, запускает CI дважды (push тега и публикация релиза); второй запуск
отменяет первый, на сервер релиз попадает один раз.

## Сервер

На сервер попадает папка `<DEPLOY_PATH>/releases/<версия>/`:

```
SenAWG-0.5.2-setup.exe
SenAWG-0.5.2-arm64.dmg
SHA256SUMS
```

Файлы сначала загружаются в `<версия>.partial`, а потом папка переименовывается одной командой, поэтому недокачанный релиз никто не увидит. На сервере нужны `rsync` и доступ по SSH-ключу.

Секреты — в *Settings → Environments → release* репозитория (окружение `release` можно закрыть ручным подтверждением):

| Секрет | Пример |
|---|---|
| `DEPLOY_HOST` | `vps.example.com` |
| `DEPLOY_USER` | `senawg` — отдельный пользователь без sudo |
| `DEPLOY_PORT` | `22` (необязательно) |
| `DEPLOY_PATH` | `/var/www/updates` |
| `DEPLOY_SSH_KEY` | приватный ключ, только для деплоя: `ssh-keygen -t ed25519 -f deploy -N ''` |
| `DEPLOY_KNOWN_HOSTS` | вывод `ssh-keyscan -p 22 vps.example.com` — ключ сервера закреплён, чужой сервер не примут |

Публичный ключ `deploy.pub` добавить в `~senawg/.ssh/authorized_keys` на сервере.

## Чего пока нет

- **Подписи.** Сборки не подписаны (`identity: null` в `electron-builder.yml`): macOS покажет предупреждение Gatekeeper, Windows — SmartScreen.
- **DMG только под Apple Silicon** — раннер `macos-latest` arm64. `amneziawg-go` уже universal; для Intel-Mac нужен `--universal` у electron-builder.
- **Манифест обновлений.** Приложение пока ничего с сервера не читает (карточка «Обновления» — заглушка).
