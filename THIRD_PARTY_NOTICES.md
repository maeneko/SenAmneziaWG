# Сторонние компоненты

SenAWG распространяется под [GNU GPL v3.0](LICENSE). Вместе с ним распространяются компоненты других авторов;
их лицензии требуют сохранять уведомления об авторских правах и тексты лицензий — они ниже.
Этот файл и `LICENSE` кладутся в каждую сборку: `resources/licenses/` рядом с приложением (Windows),
`SenAWG.app/Contents/Resources/licenses/` (macOS).

| Компонент                                                                 | Версия | Где | Лицензия |
|---------------------------------------------------------------------------|---|---|---|
| [React](https://github.com/facebook/react), React DOM, Scheduler          | 19.3.0 / 0.28.0 | интерфейс | MIT |
| [Electron](https://github.com/electron/electron) (Chromium, Node.js и др.) | см. `package-lock.json` | оболочка приложения | MIT и др. — `LICENSE.electron.txt`, `LICENSES.chromium.html` в сборке |
| [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go)               | v3.1.20260828 | движок (macOS — `amneziawg-go`, Windows — внутри `awg-helper.exe`) | MIT |
| [amneziawg-windows](https://github.com/amnezia-vpn/amneziawg-windows)     | v3.1.20260814 | `awg-helper.exe` (Windows) | MIT |
| [golang.org/x/crypto, net, sys, text](https://cs.opensource.google/go/x)  | 0.42.0, 0.44.0, 0.36.0, 0.29.0 | `awg-helper.exe`, `amneziawg-go` | BSD-3-Clause |
| Стандартная библиотека и среда выполнения [Go](https://go.dev)            | см. `helper/go.mod` | `awg-helper.exe`, `amneziawg-go` | BSD-3-Clause |
| [golang.zx2c4.com/wintun](https://git.zx2c4.com/wintun-go)                | 0.0.0-20230126 | `awg-helper.exe` (Windows) | MIT |
| [Wintun](https://www.wintun.net)                                          | 0.14.1 | `wintun.dll` (Windows) | Prebuilt Binaries License (WireGuard LLC) |
| [github.com/vishvananda/netlink](https://github.com/vishvananda/netlink), [netns](https://github.com/vishvananda/netns) | 1.3.1, 0.0.5 | `awg-helper` (Linux) | Apache License 2.0 |

## React, React DOM, Scheduler

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## amneziawg-go

```text
Copyright (C) 2017-2025 WireGuard LLC. All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## amneziawg-windows

В модуле нет отдельного файла лицензии; исходники помечены `SPDX-License-Identifier: MIT` и
`Copyright (C) 2019-2021 WireGuard LLC. All Rights Reserved.`

```text
Copyright (C) 2019-2021 WireGuard LLC. All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Go и golang.org/x/crypto, net, sys, text

Один и тот же текст у стандартной библиотеки Go и у всех четырёх модулей.

```text
Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## golang.zx2c4.com/wintun

Исходники помечены `Copyright (C) 2017-2021 WireGuard LLC. All Rights Reserved.`

```text
Copyright (C) 2017-2021 WireGuard LLC. All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Wintun (wintun.dll)

`wintun.dll` распространяется без изменений, ровно тот файл из `wintun-0.14.1.zip` с wintun.net
(SHA-256 архива закреплён в `scripts/build-helper-win.mjs`), и используется только через API из `wintun.h`.

```text
Prebuilt Binaries License
-------------------------

1. DEFINITIONS. "Software" means the precise contents of the "wintun.dll"
   files that are included in the .zip file that contains this document as
   downloaded from wintun.net/builds.

2. LICENSE GRANT. WireGuard LLC grants to you a non-exclusive and
   non-transferable right to use Software for lawful purposes under certain
   obligations and limited rights as set forth in this agreement.

3. RESTRICTIONS. Software is owned and copyrighted by WireGuard LLC. It is
   licensed, not sold. Title to Software and all associated intellectual
   property rights are retained by WireGuard. You must not:
   a. reverse engineer, decompile, disassemble, extract from, or otherwise
      modify the Software;
   b. modify or create derivative work based upon Software in whole or in
      parts, except insofar as only the API interfaces of the "wintun.h" file
      distributed alongside the Software (the "Permitted API") are used;
   c. remove any proprietary notices, labels, or copyrights from the Software;
   d. resell, redistribute, lease, rent, transfer, sublicense, or otherwise
      transfer rights of the Software without the prior written consent of
      WireGuard LLC, except insofar as the Software is distributed alongside
      other software that uses the Software only via the Permitted API;
   e. use the name of WireGuard LLC, the WireGuard project, the Wintun
      project, or the names of its contributors to endorse or promote products
      derived from the Software without specific prior written consent.

4. LIMITED WARRANTY. THE SOFTWARE IS PROVIDED "AS IS" AND WITHOUT WARRANTY OF
   ANY KIND. WIREGUARD LLC HEREBY EXCLUDES AND DISCLAIMS ALL IMPLIED OR
   STATUTORY WARRANTIES, INCLUDING ANY WARRANTIES OF MERCHANTABILITY, FITNESS
   FOR A PARTICULAR PURPOSE, QUALITY, NON-INFRINGEMENT, TITLE, RESULTS,
   EFFORTS, OR QUIET ENJOYMENT. THERE IS NO WARRANTY THAT THE PRODUCT WILL BE
   ERROR-FREE OR WILL FUNCTION WITHOUT INTERRUPTION. YOU ASSUME THE ENTIRE
   RISK FOR THE RESULTS OBTAINED USING THE PRODUCT. TO THE EXTENT THAT
   WIREGUARD LLC MAY NOT DISCLAIM ANY WARRANTY AS A MATTER OF APPLICABLE LAW,
   THE SCOPE AND DURATION OF SUCH WARRANTY WILL BE THE MINIMUM PERMITTED UNDER
   SUCH LAW. ALL EXPRESS OR IMPLIED CONDITIONS, REPRESENTATIONS AND
   WARRANTIES, INCLUDING ANY IMPLIED WARRANTY OF MERCHANTABILITY, FITNESS FOR
   A PARTICULAR PURPOSE OR NON-INFRINGEMENT ARE DISCLAIMED, EXCEPT TO THE
   EXTENT THAT THESE DISCLAIMERS ARE HELD TO BE LEGALLY INVALID.

5. LIMITATION OF LIABILITY. To the extent not prohibited by law, in no event
   WireGuard LLC or any third-party-developer will be liable for any lost
   revenue, profit or data or for special, indirect, consequential, incidental
   or punitive damages, however caused regardless of the theory of liability,
   arising out of or related to the use of or inability to use Software, even
   if WireGuard LLC has been advised of the possibility of such damages.
   Solely you are responsible for determining the appropriateness of using
   Software and accept full responsibility for all risks associated with its
   exercise of rights under this agreement, including but not limited to the
   risks and costs of program errors, compliance with applicable laws, damage
   to or loss of data, programs or equipment, and unavailability or
   interruption of operations. The foregoing limitations will apply even if
   the above stated warranty fails of its essential purpose. You acknowledge,
   that it is in the nature of software that software is complex and not
   completely free of errors. In no event shall WireGuard LLC or any
   third-party-developer be liable to you under any theory for any damages
   suffered by you or any user of Software or for any special, incidental,
   indirect, consequential or similar damages (including without limitation
   damages for loss of business profits, business interruption, loss of
   business information or any other pecuniary loss) arising out of the use or
   inability to use Software, even if WireGuard LLC has been advised of the
   possibility of such damages and regardless of the legal or quitable theory
   (contract, tort, or otherwise) upon which the claim is based.

6. TERMINATION. This agreement is affected until terminated. You may
   terminate this agreement at any time. This agreement will terminate
   immediately without notice from WireGuard LLC if you fail to comply with
   the terms and conditions of this agreement. Upon termination, you must
   delete Software and all copies of Software and cease all forms of
   distribution of Software.

7. SEVERABILITY. If any provision of this agreement is held to be
   unenforceable, this agreement will remain in effect with the provision
   omitted, unless omission would frustrate the intent of the parties, in
   which case this agreement will immediately terminate.

8. RESERVATION OF RIGHTS. All rights not expressly granted in this agreement
   are reserved by WireGuard LLC. For example, WireGuard LLC reserves the
   right at any time to cease development of Software, to alter distribution
   details, features, specifications, capabilities, functions, licensing
   terms, release dates, APIs, ABIs, general availability, or other
   characteristics of the Software.
```

## Electron

Electron, Chromium, Node.js и их зависимости — под своими лицензиями, тексты которых идут с каждой сборкой:
`LICENSE.electron.txt` и `LICENSES.chromium.html` — рядом с `SenAWG.exe` (Windows, их кладёт electron-builder)
и в `SenAWG.app/Contents/Resources/licenses/` (macOS).

## netlink, netns

```text
Copyright 2014 Vishvananda Ishaya.
Copyright 2014 Docker, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Full text: https://www.apache.org/licenses/LICENSE-2.0
```
