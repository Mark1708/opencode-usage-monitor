# opencode-usage-monitor

> OpenCode TUI sidebar plugin, который показывает usage-квоты OpenAI и Z.AI / GLM, не раскрывая provider credentials в UI.

[![Package](https://img.shields.io/badge/npm-opencode--usage--monitor-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)](https://www.npmjs.com/package/opencode-usage-monitor)
![Runtime](https://img.shields.io/badge/runtime-Bun-111827?style=for-the-badge&logo=bun&logoColor=5b5ef4)
![Host](https://img.shields.io/badge/host-OpenCode-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)
![License](https://img.shields.io/badge/license-MIT-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)

[English version](README.md)

| Поле | Значение |
|---|---|
| Статус | Активно поддерживаемый персональный OpenCode tool/plugin |
| Тип | OpenCode TUI plugin / host extension |
| Host app | Документирован OpenCode `>= v1.14.49`; peer dependency `@opencode-ai/plugin >=1.4.0` |
| Package | `opencode-usage-monitor` `1.0.7`, опубликован в npm |
| Runtime | Bun `>= 1.1.0` документирован для локальной разработки |
| Проверки maintainer | `bun install && bun run build:all && bun test && bun run typecheck` |

## Скриншоты

Plugin отображается внутри sidebar терминального UI OpenCode.

![Collapsed sidebar view](assets/sidebar-collapsed.png)

![Provider expanded view](assets/provider-expanded.png)

![Fully expanded view](assets/fully-expanded.png)

## Сводка

- Показывает usage windows OpenAI ChatGPT, например 5h/week, со временем reset и опциональными деталями plan или credits.
- Показывает quota windows Z.AI и GLM 5h/day/month со временем reset и опциональными деталями plan.
- Находит credentials в OpenCode auth storage и поддерживаемых environment variables.
- Редактирует secrets из error messages перед выводом в TUI.
- Использует stale-data indicators и защищённые refresh-циклы, чтобы не запускать пересекающиеся API calls.
- Поддерживает двухуровневое collapse/expand поведение: весь panel и детализация по provider.

## Быстрый старт

```sh
# установить опубликованный OpenCode plugin глобально
opencode plugin opencode-usage-monitor@latest --global --force

# опционально: собрать из локального checkout для разработки
git clone https://github.com/Mark1708/opencode-usage-monitor.git
cd opencode-usage-monitor
bun install
bun run build:all
```

## Установка

### Установка OpenCode plugin

```sh
opencode plugin opencode-usage-monitor@latest --global --force
```

Это рекомендуемый путь для пользователей: plugin опубликован в npm, и OpenCode может установить его напрямую.

### Установка package для локальной разработки

```sh
bun add opencode-usage-monitor
```

Используйте этот вариант, если package нужен в локальном development workspace, а не глобально внутри OpenCode.

### Локальный checkout

```sh
git clone https://github.com/Mark1708/opencode-usage-monitor.git
cd opencode-usage-monitor
bun install
bun run build:all
```

Build создаёт plugin entry и TUI bundle в `dist/`.

## Совместимость

| Компонент | Поддерживаемая версия | Источник |
|---|---|---|
| Host app | OpenCode `>= v1.14.49` | README compatibility note |
| Plugin API | `@opencode-ai/plugin >=1.4.0` | `package.json` peer dependency |
| TUI runtime | `@opentui/solid >=0.1.0`, `solid-js >=1.8.0` | `package.json` peer dependencies |
| Local runtime | Bun `>=1.1.0` | README requirements; Bun-based scripts в `package.json` |
| TypeScript | `^5.5.0` | `package.json` dev dependency |

## Конфигурация

Plugin сначала читает отдельный config-файл:

```text
~/.config/opencode/usage-monitor.json
```

Минимальная полезная конфигурация:

```json
{
  "enabled": true,
  "show_openai": true,
  "show_zai": true
}
```

Полная документированная форма:

```json
{
  "enabled": true,
  "default_collapsed": false,
  "default_provider_collapsed": true,
  "debug": false,
  "refresh_ms": 60000,
  "request_timeout_ms": 15000,
  "show_openai": true,
  "show_zai": true,
  "show_details": true,
  "width": 34,
  "symbols": "unicode",
  "max_detail_lines": 4,
  "max_windows": 3,
  "max_model_lines": 1,
  "refresh_keybind": "<leader>q"
}
```

Альтернативно можно добавить секцию `usage_monitor` в `oh-my-openagent.json`. Значения из отдельного `usage-monitor.json` имеют приоритет.

## Credentials

### OpenAI

OpenAI organization usage endpoints требуют admin key:

```sh
export OPENAI_ADMIN_KEY="your-admin-key"
```

Plugin может обнаружить `OPENAI_API_KEY` или OpenCode `auth.json` entry для OpenAI, но non-admin credentials помечаются как unsupported для organization usage endpoints.

### Z.AI и GLM

Plugin поддерживает Z.AI и Zhipu / GLM credentials из OpenCode auth storage или environment variables:

```sh
export ZAI_API_KEY="your-zai-key"
export ZAI_CODING_PLAN_API_KEY="your-coding-plan-key"
export ZHIPU_API_KEY="your-zhipu-key"
export ZHIPUAI_API_KEY="your-zhipuai-key"
```

## Использование

- Нажмите на основной usage header, чтобы свернуть или раскрыть весь panel.
- Нажмите на строки providers, чтобы независимо переключать provider details.
- Используйте `/usage-refresh` или настроенный refresh keybind, по умолчанию `<leader>q`, для ручного refresh.
- Cache хранится в `~/.cache/opencode/usage-monitor.json`.
- Render errors перехватываются и отображаются внутри error boundary.

## Структура проекта

```text
.
├── assets/                    # Local screenshots для README
├── dist/                      # Собранный package output
├── src/
│   ├── auth.ts                # OpenCode auth и environment credential discovery
│   ├── cache.ts               # Usage cache persistence
│   ├── config.ts              # Parsing usage-monitor.json и oh-my-openagent config
│   ├── index.ts               # OpenCode plugin entry
│   ├── sanitize.ts            # Helpers для secret redaction
│   ├── tui.ts                 # TUI plugin module
│   ├── providers/             # OpenAI и Z.AI provider clients
│   └── views/                 # Helpers для TUI view rendering
├── package.json               # Package metadata, scripts, peer dependencies
├── tsconfig.json              # Strict TypeScript config
└── LICENSE
```

## Устранение неполадок

- Если OpenAI показывает `needs admin key`, задайте `OPENAI_ADMIN_KEY` с organization admin key.
- Если Z.AI показывает `auth missing`, настройте поддерживаемую Z.AI или Zhipu environment variable либо OpenCode auth entry.
- Если panel слишком широкий или узкий, измените `width` в `usage-monitor.json`.
- Если refresh выглядит устаревшим, уменьшите `refresh_ms` или проверьте provider API connectivity.
- Если build output отсутствует, выполните `bun run build:all` и проверьте наличие `dist/index.js` и `dist/tui.js`.
- Если cached data выглядит устаревшей, проверьте `~/.cache/opencode/usage-monitor.json`.

## Ограничения / безопасность

- Plugin читает локальные OpenCode auth metadata и поддерживаемые environment variables, но примеры в README используют только placeholders.
- Secrets редактируются из rendered error messages до попадания в TUI.
- Provider data зависит от доступности внешних API OpenAI, Z.AI и Zhipu, а также от credential permissions.
- Package является host extension; runtime-поведение зависит от совместимых OpenCode и OpenTUI API.

## Статус

Активно поддерживаемый персональный OpenCode tool/plugin. Public issues и improvements приветствуются, но проект в первую очередь поддерживается под workflow автора.

## Ссылки / лицензия

- Package: <https://www.npmjs.com/package/opencode-usage-monitor>
- Repository: <https://github.com/Mark1708/opencode-usage-monitor>
- Host app: <https://opencode.ai/>
- Включён в раздел Plugins курируемого каталога [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode).
- Лицензия: MIT, см. [`LICENSE`](LICENSE)
