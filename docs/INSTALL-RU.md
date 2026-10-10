# Установка Openship с русским интерфейсом

Эта установка собирает Openship из ветки `main` репозитория `AlexK420/openship` и использует русскую локализацию из этого форка.

## Установка одной командой

```sh
curl -fsSL https://raw.githubusercontent.com/AlexK420/openship/main/scripts/install-ru.sh | sh
```

После установки доступны обычные команды:

```sh
openship
openship up
openship --help
```

## Обновление

```sh
openship update
```

Установщик создаёт `~/.openship/source-install.json`, поэтому `openship update` проверяет `AlexK420/openship`, подтягивает выбранную ветку и пересобирает CLI и dashboard из исходников. Он не переключает такую установку обратно на опубликованный upstream-релиз.

По умолчанию используются:

- репозиторий: `https://github.com/AlexK420/openship.git`
- ветка: `main`
- данные Openship: `~/.openship`
- исходники: `~/.openship/source`

Существующие данные в `~/.openship` сохраняются. Установщик заменяет launcher `openship` и маркер способа установки, но не удаляет данные проектов/настроек Openship.

## Зафиксировать ветку, тег или commit

Например:

```sh
curl -fsSL https://raw.githubusercontent.com/AlexK420/openship/main/scripts/install-ru.sh | OPENSHIP_REF=main sh
```

Можно также переопределить источник и каталоги:

```sh
OPENSHIP_REPO=https://github.com/AlexK420/openship.git \
OPENSHIP_REF=main \
OPENSHIP_HOME="$HOME/.openship" \
OPENSHIP_SRC_DIR="$HOME/.openship/source" \
sh -c "$(curl -fsSL https://raw.githubusercontent.com/AlexK420/openship/main/scripts/install-ru.sh)"
```

## Требования

Нужны `curl` и `git`. Для source-сборки используется Bun; если Bun отсутствует, установщик устанавливает его автоматически. Сборка dashboard требует заметно больше памяти и CPU, чем установка готового релизного архива.

Это source-сборка из форка, а не подписанный релизный бинарник upstream.