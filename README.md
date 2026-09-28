# SenAWG
Простой VPN клиент [AmneziaWG](https://github.com/amnezia-vpn/amneziawg-go) для проекта [SenAmnesia](https://amnesia.ma7neko.ru/)

- Конфиги всех поколений: обычный WireGuard, AmneziaWG legacy, 2.0, 3.0 и 3.1.
- Несколько серверов, переключение одной кнопкой, статистика и журнал туннеля.
- При полном туннеле на Windows весь трафик и DNS мимо VPN блокируются (WFP).
- Linux — см. [docs/linux.md](docs/linux.md): реализовано, на настоящей машине пока проверялось только на
  Artix с Hyprland. Что нужно в системе — [ниже](#linux-что-нужно-в-системе).
- VPN живёт ровно столько, сколько приложение: закрыли окно, упало, сняли процесс — туннель, маршруты и DNS
  возвращаются как было, фоновых служб не остаётся.
- Автозапуск, подключение к последнему серверу, удаление программы прямо из настроек.

## Linux: что нужно в системе

Только x86_64. Ядро VPN (`amneziawg-go`) и служба (`awg-helper`) лежат внутри `.run` и собраны статически —
им от системы ничего не нужно, модуль ядра AmneziaWG и `wireguard-tools` тоже не нужны. Всё, что ниже, —
для самого приложения (Electron) и для прав администратора.

**Обязательно:**

| Что | Зачем |
|---|---|
| glibc 2.25 или новее (не musl) | Electron; Alpine и Void musl не подходят |
| `zstd` | `.run` распаковывается им — и при установке, и при каждом обновлении |
| polkit (`pkexec`) | права администратора: установка, обновление, запуск службы |
| библиотеки Electron — gtk3, nss, alsa, mesa (gbm), cups, at-spi2, libxkbcommon, X11 и др. | окно приложения; на любой системе с рабочим столом обычно уже стоят |

`.run` сам проверяет glibc и библиотеки до запуска приложения и, если чего-то нет, говорит, какой командой
это поставить. Приложение так же подсказывает пакет, если не находит `pkexec` или `zstd`.

Всё обязательное одной командой:

```bash
# Arch, Manjaro, EndeavourOS
sudo pacman -S --needed polkit zstd glib2 nspr nss at-spi2-core libcups dbus cairo gtk3 pango \
  libx11 libxcomposite libxdamage libxext libxfixes libxrandr mesa expat libxcb libxkbcommon \
  systemd-libs alsa-lib gcc-libs

# Artix — то же, но libudev вместо systemd-libs
sudo pacman -S --needed polkit zstd glib2 nspr nss at-spi2-core libcups dbus cairo gtk3 pango \
  libx11 libxcomposite libxdamage libxext libxfixes libxrandr mesa expat libxcb libxkbcommon \
  libudev alsa-lib gcc-libs

# Debian 13, Ubuntu 24.04 и новее
sudo apt install pkexec zstd libglib2.0-0t64 libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libatspi2.0-0t64 libcups2t64 libdbus-1-3 libcairo2 libgtk-3-0t64 libpango-1.0-0 libx11-6 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libexpat1 libxcb1 libxkbcommon0 \
  libudev1 libasound2t64 libgcc-s1

# Debian 12, Ubuntu 22.04
sudo apt install pkexec zstd libglib2.0-0 libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libatspi2.0-0 libcups2 libdbus-1-3 libcairo2 libgtk-3-0 libpango-1.0-0 libx11-6 \
  libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libexpat1 libxcb1 libxkbcommon0 \
  libudev1 libasound2 libgcc-s1

# Fedora, RHEL/Alma/Rocky 8+
sudo dnf install polkit zstd glib2 nspr nss nss-util atk at-spi2-atk at-spi2-core cups-libs dbus-libs \
  cairo gtk3 pango libX11 libXcomposite libXdamage libXext libXfixes libXrandr mesa-libgbm expat libxcb \
  libxkbcommon systemd-libs alsa-lib libgcc

# openSUSE
sudo zypper install polkit zstd libglib-2_0-0 libgobject-2_0-0 libgio-2_0-0 mozilla-nspr mozilla-nss \
  libatk-1_0-0 libatk-bridge-2_0-0 libatspi0 libcups2 libdbus-1-3 libcairo2 libgtk-3-0 libpango-1_0-0 \
  libX11-6 libXcomposite1 libXdamage1 libXext6 libXfixes3 libXrandr2 libgbm1 libexpat1 libxcb1 \
  libxkbcommon0 libudev1 libasound2 libgcc_s1
```

**Необязательно** — без этого всё работает, но хуже:

| Что | Что будет без него |
|---|---|
| агент polkit (polkit-gnome, hyprpolkitagent, lxpolkit…) | пароль администратора спросит сам SenAWG, в своём окне |
| `resolvectl` (systemd-resolved) или `resolvconf` | DNS пишется прямо в `/etc/resolv.conf` и возвращается при отключении |
| трей: KDE, Cinnamon, waybar с `tray`; в GNOME — расширение AppIndicator | значка в трее нет; окно снова открывается повторным запуском или из меню |
| хранилище ключей: gnome-keyring или KWallet | ключи конфигов хранит служба SenAWG в `/var/lib/senawg`, доступные только root |
| `gtk-update-icon-cache` | иконка в меню может появиться не сразу |

## Сборка

Нужны Node 24 и Go (версия — в `helper/go.mod`).

```bash
npm install          # заодно собирает движок под текущую систему (если есть Go)
npm run dev          # приложение в режиме разработки
npm run demo         # только интерфейс, в браузере: лаборатория состояний (/demo/lab.html)
npm test             # тесты (vitest)
npm run typecheck
(cd helper && go test ./...)

npm run build:mac    # dist/SenAWG-<версия>-<arch>.dmg      — только на macOS
npm run build:win    # dist/SenAWG-<версия>-setup.exe (x64) — на Windows или macOS, wine не нужен
npm run build:linux  # dist/SenAWG-<версия>-linux-x64.run — на Linux или macOS
```
## Лицензия

[GNU GPL v3.0](LICENSE). Сторонние компоненты и их лицензии — [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
