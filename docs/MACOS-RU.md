# Openship для macOS — русская сборка

Русская desktop-сборка собирается в GitHub Actions. VS Code, Xcode и локальная сборка на Mac для обычной установки не нужны.

## Скачать готовый DMG

1. Открой репозиторий `AlexK420/openship` на GitHub.
2. Перейди во вкладку **Actions**.
3. Выбери workflow **Build macOS RU**.
4. Открой последний успешный запуск.
5. В разделе **Artifacts** скачай архив `Openship-RU-macOS`.
6. Внутри архива будут две сборки:
   - `Openship-RU-macOS-arm64.dmg` — Apple Silicon (M1, M2, M3, M4 и новее).
   - `Openship-RU-macOS-x64.dmg` — Intel Mac.
7. Открой подходящий `.dmg` и перенеси Openship в Applications.

## Если macOS блокирует первый запуск

Сборка из Actions может быть не подписана и не нотарифицирована Apple, если в репозитории не настроены Apple Developer secrets. В таком случае используй стандартный безопасный способ macOS: нажми приложение правой кнопкой → **Открыть**, либо разреши запуск в **System Settings → Privacy & Security**.

Не отключай Gatekeeper глобально.

## Обновления

Desktop updater этого форка смотрит только на GitHub Releases репозитория `AlexK420/openship`, а не на официальный `oblien/openship`. Это не позволяет русской fork-сборке случайно заменить себя официальным приложением без изменений форка.

Пока отдельные версии публикуются через Actions как artifacts, новую сборку можно получить повторным запуском **Build macOS RU** или автоматически после изменений desktop/dashboard в `main`. Для полностью автоматического in-app update нужен собственный GitHub Release с DMG-asset'ами стандартных имен `Openship-arm64.dmg` и `Openship-x64.dmg`.
