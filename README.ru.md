# opencode-usage-monitor

[English version](README.md)

> OpenCode TUI sidebar plugin, который показывает квоты и баланс OpenAI, Z.AI / GLM, DeepSeek и OpenCode Go без раскрытия provider credentials в UI.

[![Package](https://img.shields.io/badge/npm-opencode--usage--monitor-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)](https://www.npmjs.com/package/opencode-usage-monitor)
![Runtime](https://img.shields.io/badge/runtime-Bun-111827?style=for-the-badge&logo=bun&logoColor=5b5ef4)
![Host](https://img.shields.io/badge/host-OpenCode-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)
![License](https://img.shields.io/badge/license-MIT-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)

| Поле | Значение |
|---|---|
| Статус | Активно поддерживаемый персональный OpenCode tool/plugin |
| Тип | OpenCode TUI plugin / host extension |
| Host app | OpenCode `>=2.0.32`; release smoke также проверен на текущей `2.1.2` |
| Package | `opencode-usage-monitor` `3.1.0` |
| Runtime | Bun `>= 1.3.0` для локальной разработки |
| Проверки maintainer | `bun install --frozen-lockfile && bun run typecheck && bun run typecheck:host && bun test && bun run build:all && bun run verify:package` |

## Скриншоты

Plugin отображается внутри sidebar терминального UI OpenCode.

![Collapsed sidebar view](assets/sidebar-collapsed.png)

![Provider expanded view](assets/provider-expanded.png)

![Fully expanded view](assets/fully-expanded.png)

## Сводка

- Показывает usage windows OpenAI ChatGPT, число доступных Codex reset credits и опционально ближайший срок их истечения.
- Показывает quota windows Z.AI и GLM 5h/week/month со временем reset и опциональными деталями plan. Поддерживает enterprise/org coding plans через organization и project scoping.
- Показывает баланс аккаунта DeepSeek в CNY с опциональной детализацией granted/topped-up.
- Показывает usage windows OpenCode Go 5h/week/month со временем reset.
- Стандартизирует provider output как explicit usage windows плюс typed provider-owned details; баланс DeepSeek отображается как balance detail, а не как fake reset window.
- Находит credentials в OpenCode auth storage и поддерживаемых environment variables.
- Редактирует secrets из error messages перед выводом в TUI.
- Отклоняет raw provider attribute dumps в runtime snapshots; providers должны мапить safe attributes в ordered details.
- Использует stale-data indicators и guarded refreshes, чтобы не запускать пересекающиеся API calls.
- Поддерживает двухуровневое collapse/expand поведение: весь panel и детализация по provider.

## Быстрый старт

```sh
opencode plugin add opencode-usage-monitor@3.1.0
```

## Установка

### OpenCode v2

Установите release через v2 plugin manager:

```sh
opencode plugin add opencode-usage-monitor@3.1.0
```

Эквивалентная ручная конфигурация:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-usage-monitor@3.1.0"]
}
```

Команда устанавливает package и добавляет его npm spec в `plugins` глобального
файла `~/.config/opencode/opencode.json`. Для установки только в проекте
добавьте ту же запись в `opencode.json(c)` в корне проекта. Package экспортирует
отдельные v2 server и TUI definitions.

Этот major не поддерживает OpenCode v1. Пользователям v1 нужно закрепить
`opencode-usage-monitor@2.0.1`; dual-runtime compatibility shim отсутствует.

### Package для локальной разработки

```sh
bun add opencode-usage-monitor@3.1.0
```

### Локальный checkout

```sh
git clone https://github.com/Mark1708/opencode-usage-monitor.git
cd opencode-usage-monitor
bun install --frozen-lockfile
bun run build:all
bun run verify:package
```

Build создаёт server definition и TUI bundle в `dist/`; package verifier
записывает release candidate в `.artifacts/package.tgz`. Root shims в
репозитории намеренно отсутствуют.

## Совместимость

| Компонент | Поддерживаемая версия | Источник |
|---|---|---|
| Host app | OpenCode `>=2.0.32` (smoke на `2.0.32` и `2.1.2`) | Release smoke contract |
| Plugin API | `@opencode/plugin 2.0.32` | dependency в `package.json` |
| Theme API | `@opencode/theme 2.0.32` | peer dependency в `package.json` |
| TUI runtime | `@opentui/core >=0.5.17`, `@opentui/solid >=0.5.17`, `solid-js 1.9.12` | peer dependencies в `package.json` |
| Local runtime | Bun `>=1.3.0` | engine в `package.json` |
| TypeScript | `^5.5.0` | dev dependency в `package.json` |


## Конфигурация

Version 2.0 поддерживает только versioned configuration contract. Legacy flat fields вроде `show_openai`, `show_zai`, `show_deepseek` и `refresh_ms` отклоняются с actionable configuration error в TUI вместо fallback-интерпретации.

Plugin сначала читает отдельный config-файл:

```text
~/.config/opencode/usage-monitor.json
```

Минимальная полезная конфигурация:

```json
{
  "version": 2,
  "providers": {
    "openai": {},
    "zai": {},
    "deepseek": {},
    "opencode-go": {}
  }
}
```

Полная документированная форма:

```json
{
  "version": 2,
  "enabled": true,
  "keybindings": {
    "refresh_all": "<leader>q",
    "refresh_provider": null
  },
  "ui": {
    "width": 34,
    "symbols": "unicode",
    "panel_initial_state": "expanded",
    "provider_initial_state": "collapsed"
  },
  "refresh": {
    "mode": "automatic",
    "interval_ms": 300000,
    "timeout_ms": 15000,
    "stale_after_ms": 600000
  },
  "diagnostics": {
    "debug": false
  },
  "providers": {
    "openai": {
      "credential": { "source": "opencode", "entry": "openai" },
      "options": {
        "show_resets": true,
        "show_reset_expiry": false
      }
    },
    "zai": {
      "credential": { "source": "opencode", "entry": "zai-coding-plan" },
      "options": { "plan": "personal" }
    },
    "deepseek": {
      "credential": { "source": "opencode", "entry": "deepseek" }
    },
    "opencode-go": {
      "credential": { "source": "opencode", "entry": "opencode-go" }
    }
  }
}
```

Объект `providers` управляет provider activation. Наличие provider включает его; отсутствие отключает и предотвращает credential, cache и network work для этого provider. Provider-specific refresh policies намеренно не поддерживаются.

Альтернативно можно добавить секцию `usage_monitor` в `oh-my-openagent.json`. Значения из отдельного `usage-monitor.json` имеют приоритет.

## Credentials

### OpenAI

OpenAI показывает ChatGPT/Codex subscription quota windows из активного
OpenCode OAuth credential, а не из OpenAI Platform API keys. Plugin вызывает
v2 credential client и сохраняет только нормализованную проекцию access token,
expiry и `metadata.accountID`/`metadata.accountId`, необходимую provider.

Plugin никогда не читает `auth.json`, не использует inactive credentials и не
сохраняет refresh tokens, labels, произвольные metadata или raw host credential
records. `OPENAI_API_KEY` и `OPENAI_ADMIN_KEY` не используются для subscription
quota.

Число доступных Codex reset credits по умолчанию берётся из основного usage
response. Чтобы скрыть его, задайте `show_resets: false` в
`providers.openai.options`. Опция `show_reset_expiry: true` включает условный
дополнительный request и показывает ближайший срок истечения доступного credit.
Этот request выполняется только когда resets отображаются и доступен хотя бы
один credit; при его ошибке usage windows и число resets остаются видимыми без
expiry.

### Z.AI и GLM

Plugin поддерживает Z.AI и Zhipu / GLM credentials из OpenCode auth storage или environment variables:

```sh
export ZAI_API_KEY="your-zai-key"
export ZAI_CODING_PLAN_API_KEY="your-coding-plan-key"
export ZHIPU_API_KEY="your-zhipu-key"
export ZHIPUAI_API_KEY="your-zhipuai-key"
```

#### Enterprise / organization coding plan

Enterprise (organization-scoped) GLM coding plans требуют organization id и project id. Когда оба значения заданы, plugin запрашивает `{baseUrl}/api/monitor/usage/quota/limit?type=2` с headers `Bigmodel-Organization` и `Bigmodel-Project`; иначе используется personal plan endpoint.

Настройка в `usage-monitor.json`:

```json
{
  "version": 2,
  "providers": {
    "zai": {
      "options": {
        "plan": "enterprise",
        "organization_id": "your-org-id",
        "project_id": "your-project-id"
      }
    }
  }
}
```

Или через environment variables, если provider options не заданы:

```sh
export ZHIPU_ORGANIZATION_ID="your-org-id"
export ZHIPU_PROJECT_ID="your-project-id"
```

### DeepSeek

Plugin показывает баланс аккаунта DeepSeek в CNY из balance endpoint. Настройте API key через OpenCode auth storage или:

```sh
export DEEPSEEK_API_KEY="your-deepseek-key"
```

Balance row показывает общий CNY amount; раскрытие provider показывает granted (promotional) и topped-up (paid) breakdown.

### OpenCode Go

OpenCode Go показывает rolling 5h, weekly и monthly usage через `GET https://opencode.ai/zen/go/v1/usage`. Сначала используется сохранённый OpenCode credential `opencode-go`. Для явного environment fallback задайте:

```sh
export OPENCODE_GO_API_KEY="your-opencode-go-key"
```

Endpoint read-only и используется клиентами OpenCode Go, но пока не документирован как стабильный public API. Изменение response contract может потребовать обновления plugin.


## Использование

- Нажмите на основной usage header, чтобы свернуть или раскрыть весь panel.
- Нажмите на строки providers, чтобы независимо переключать provider details.
- Используйте `/usage-refresh` или настроенный refresh keybind, по умолчанию `<leader>q`, для ручного refresh.
- Runtime refreshes используют account-safe provider cache в `/tmp/opencode-usage-monitor-v2/`.
- Render errors перехватываются и отображаются внутри error boundary.

## Структура проекта

```text
.
├── assets/                    # Local screenshots для README
├── dist/                      # Собранный package output
├── src/
│   ├── auth.ts                # OpenCode auth и environment credential discovery
│   ├── provider-cache.ts      # Account-safe provider cache
│   ├── runtime-config.ts      # Versioned runtime config parsing and validation
│   ├── credentials.ts         # Credential resolver for provider registrations
│   ├── index.ts               # OpenCode plugin entry
│   ├── refresh*.ts            # Runtime refresh coordinator modules
│   ├── sanitize.ts            # Helpers для secret redaction
│   ├── snapshot-validation.ts # Snapshot validation before publication/cache
│   ├── tui.ts                 # TUI plugin module
│   ├── providers/             # OpenAI, Z.AI / GLM, DeepSeek и OpenCode Go clients
│   └── views/                 # Helpers для TUI view rendering
├── package.json               # Package metadata, scripts, peer dependencies
├── tsconfig.json              # Strict TypeScript config
└── LICENSE
```

## Устранение неполадок

- Если OpenAI показывает `auth missing`, `oauth missing`, `oauth expired` или `account id missing`, выполните `opencode providers login` для OpenAI и проверьте, что OpenCode auth entry содержит non-expired OAuth `openai.access`, `openai.accountId`, `openai.expires` и `openai.type: "oauth"`.
- Если Z.AI показывает `auth missing`, настройте поддерживаемую Z.AI или Zhipu environment variable либо OpenCode auth entry.
- Если Z.AI показывает `partial` на enterprise/org account, задайте `providers.zai.options.organization_id` и `providers.zai.options.project_id` или `ZHIPU_ORGANIZATION_ID` / `ZHIPU_PROJECT_ID`, чтобы использовался endpoint `?type=2`.
- Если DeepSeek показывает `auth missing`, задайте `DEEPSEEK_API_KEY` или активируйте DeepSeek credential в OpenCode.
- Если OpenCode Go показывает `auth missing`, выполните `/connect`, выберите OpenCode Go и введите его API key либо задайте `OPENCODE_GO_API_KEY`.
- Если panel показывает `config` error, мигрируйте `usage-monitor.json` на `version: 2` shape и задайте хотя бы один provider в `providers`.
- Если panel слишком широкий или узкий, измените `ui.width` в `usage-monitor.json`.
- Если refresh выглядит устаревшим, уменьшите `refresh.interval_ms` или проверьте provider API connectivity.
- Если build output отсутствует, выполните `bun run build:all` и проверьте наличие `dist/index.js` и `dist/tui.js`.
- Если cached data выглядит устаревшей, проверьте `/tmp/opencode-usage-monitor-v2/`.

## Ограничения / безопасность

- Plugin читает локальные OpenCode auth metadata и поддерживаемые environment variables, но примеры в README используют только placeholders.
- Secrets редактируются из rendered error messages до попадания в TUI.
- Provider data зависит от доступности внешних API OpenAI, Z.AI, Zhipu, DeepSeek и OpenCode Go, а также от credential permissions.
- Package является host extension; runtime-поведение зависит от совместимых OpenCode и OpenTUI APIs.

## Статус

Активно поддерживаемый персональный OpenCode tool/plugin. Public issues и improvements приветствуются, но проект в первую очередь поддерживается под workflow автора.

## Ссылки / лицензия

- Package: <https://www.npmjs.com/package/opencode-usage-monitor>
- Repository: <https://github.com/Mark1708/opencode-usage-monitor>
- Host app: <https://opencode.ai/>
- Включён в раздел Plugins курируемого каталога [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode).
- Лицензия: MIT, см. [`LICENSE`](LICENSE)
