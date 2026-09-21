# CI/CD

Всё описано в `.github/workflows/ci.yml` (GitHub Actions).

| Когда | Что происходит |
|---|---|
| Любой push и pull request | typecheck, `vitest` и `go test` хелпера на macOS, `go test` хелпера на Windows, проверка, что хелпер собирается под Windows |
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
| `DEPLOY_SSH_KEY` | приватный ключ, только для деплоя (ниже — как его получить) |

Ключ сервера не закреплён: раннер каждый раз новый и принимает тот ключ, что ответит первым
(`StrictHostKeyChecking=accept-new`), а остальные подключения той же выгрузки обязаны увидеть его же.
Украсть ключ выгрузки самозванец так не сможет — подпись SSH привязана к сессии, — а установщики и так
публичные. Теряется одно: уверенность, что релиз лёг именно на ваш сервер. Вернуть закрепление — секрет
с выводом `ssh-keyscan` в `~/.ssh/known_hosts` и `StrictHostKeyChecking=yes`.

### Ключ для выгрузки

1. На своём компьютере: `ssh-keygen -t ed25519 -f ~/.ssh/senawg-deploy -N '' -C 'github-actions senawg'`.
   Получатся `senawg-deploy` (приватный → секрет `DEPLOY_SSH_KEY`) и `senawg-deploy.pub` (публичный → сервер).
2. На сервере: пользователь без sudo и папка для релизов —
   `sudo adduser --disabled-password --gecos '' senawg`,
   `sudo mkdir -p /var/www/updates && sudo chown senawg /var/www/updates`.
3. Туда же публичный ключ — строка из `senawg-deploy.pub` в `/home/senawg/.ssh/authorized_keys`
   (папка `700`, файл `600`, владелец `senawg`).
4. Проверка: `ssh -i ~/.ssh/senawg-deploy senawg@<сервер> 'echo ok'`.
5. `pbcopy < ~/.ssh/senawg-deploy` и вставить в `DEPLOY_SSH_KEY` целиком, со строками `BEGIN`/`END`.

## Чего пока нет

- **Подписи.** Сборки не подписаны (`identity: null` в `electron-builder.yml`): macOS покажет предупреждение Gatekeeper, Windows — SmartScreen.
- **DMG только под Apple Silicon** — раннер `macos-latest` arm64. `amneziawg-go` уже universal; для Intel-Mac нужен `--universal` у electron-builder.
- **Манифест обновлений.** Приложение пока ничего с сервера не читает (карточка «Обновления» — заглушка).
