# Kivora для Linux

Мессенджер со сквозным шифрованием. Один статический бинарник, внутри уже лежит
веб-клиент. Зависимостей нет — cgo не используется, так что запустится на любом
дистрибутиве, включая musl-based.

## Запуск

```sh
./kivora
```

На ARM (Raspberry Pi, Ampere, Graviton):

```sh
./kivora-arm64
```

Откройте `http://localhost:8080`. Первый созданный аккаунт становится
администратором.

## Где лежат данные

В каталоге `data` рядом с бинарником. Чтобы положить в другое место:

```sh
KIVORA_DATA_DIR=~/.local/share/kivora ./kivora
```

Этот каталог и есть резервная копия. Файл `secret.key` в нём обязателен: без
него все сессии станут недействительными.

## Автозапуск для одного пользователя

```sh
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/kivora.service <<'UNIT'
[Unit]
Description=Kivora

[Service]
ExecStart=%h/bin/kivora
Environment=KIVORA_DATA_DIR=%h/.local/share/kivora
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
systemctl --user enable --now kivora
```

Для установки на сервер, с системной службой, TLS и конфигами для Caddy и
nginx, возьмите поставку `kivora-server` — там это одна команда.

## Настольное приложение

Этот бинарник — сервер со встроенным веб-клиентом; интерфейс открывается в
браузере. Отдельное окно приложения (Tauri) собирается из исходников:

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf \
                 build-essential curl wget file libssl-dev libdbus-1-dev pkg-config
./build.sh desktop
```

Получатся `.deb` и `.AppImage`.

**Честная оговорка про звонки в настольном приложении под Linux:** WebKitGTK не
выдаёт разрешение на микрофон и камеру из встроенного окна, поэтому звонки там
не работают. Не потому, что не реализованы — движок окна не пускает. В браузере
на том же Linux всё работает; это и есть обходной путь.

## Админ-консоль

Отдельная страница по адресу `/admin`. Содержимого переписки там нет и быть не
может — на сервере сообщения зашифрованы.

## Лицензия

Apache 2.0, см. `LICENSE`.
