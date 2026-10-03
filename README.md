# Claude Code Mods

我為自己的開發流程寫的三個 [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview)。Mod 是跑在 Claude Code 裡面的 TypeScript 事件處理函式，可以攔截工具呼叫、改寫 prompt，或在介面上畫出自己的區塊。

| Mod | 做什麼 | 指令 |
| --- | --- | --- |
| [ding-dong](./ding-dong) | 回合跑超過一分鐘才結束時，發一則系統通知叫你回來 | `/ding` 預覽通知 |
| [ship-it](./ship-it) | 依序執行專案的階段（檢查、測試、打包、部署），在 pane 裡用像素吉祥物顯示進度 | `/ship`、`/ship demo`、`/ship init` |
| [secret-guard](./secret-guard) | 遮蔽 prompt 與工具輸出裡的金鑰，擋下讀寫 `.env` 與私鑰 | `/guard`、`/guard on`、`/guard off` |

## 需求

- Claude Code 2.1.287 以上
- `ding-dong` 的系統通知只支援 macOS，其他平台會改用 Claude Code 內的 toast

## 安裝

把這個 repo 加成 marketplace，再安裝想要的 mod：

```bash
claude plugin marketplace add builtbyjia/claude-code-mods
```

```bash
claude plugin install ship-it@builtbyjia-mods
```

只想試用一次的話，clone 下來後用 `--plugin-dir` 載入，只在那個 session 生效：

```bash
claude --plugin-dir ./ship-it
```

> Mod 會用你的權限執行，可以讀寫檔案、執行指令。安裝任何人的 mod 之前（包括這裡的），建議先用 `claude plugin validate <資料夾>` 看它掛了哪些事件、呼叫了哪些 API，並讀過原始碼。

## ding-dong

回合依時長分成四種語氣（一到三分鐘、三到十分鐘、十分鐘以上、出錯），每種隨機抽一句文案，副標題顯示專案資料夾、耗時與工具次數。你自己中斷的回合不會通知。

通知預設由系統的 `osascript` 發出。想讓通知圖示變成橘色像素吉祥物，執行一次：

```bash
./ding-dong/notifier/build.sh
```

它會在本機編譯出 `DingDong.app`，之後通知就由這個小程式發出。文案與門檻秒數都在 [`ding-dong/hooks/register.ts`](./ding-dong/hooks/register.ts) 最上方。

## ship-it

`/ship` 會開一個 pane，吉祥物沿著軌道走向正在執行的階段，每個階段顯示耗時；失敗時流程停下，並列出最後幾行錯誤輸出。

階段的來源依序是：

1. 專案裡的 `.claude/ship.json`
2. `package.json` 裡的 `lint`、`test`、`build`、`deploy` 這四個 script

用 `/ship init` 可以產生設定檔，格式如下：

```json
{
  "stages": [
    { "name": "跑測試", "run": "npm test" },
    { "name": "打包", "run": "npm run build" },
    { "name": "部署", "run": "npm run deploy" }
  ]
}
```

`run` 會交給 `bash -c` 執行，所以只在你信任的專案裡使用 `/ship`。`/ship demo` 用 `sleep` 模擬五個階段，不會動到專案。

## secret-guard

三層防護：

1. **Prompt**：送出前把 API key、token、私鑰換成 `[已遮蔽:GitHub token]` 這類標記。
2. **工具輸出**：檔案內容或指令輸出裡的金鑰，在送給模型之前遮蔽。
3. **敏感檔案**：擋下讀寫 `.env`、私鑰、`.npmrc` 等檔案，以及 `cat .env`、`printenv` 這類指令；`.env.example` 這類範本檔放行。

已知限制：

- 靠格式比對，認不出格式的密碼不會被遮蔽。
- Shell 指令的檢查是字面比對，可以被繞過，不能當作唯一的防線。
- 模型看到的是標記，所以它無法修改被遮蔽的那一行。
- 圖片與 PDF 的內容不在遮蔽範圍內。

## 開發

每個 mod 是一個獨立的 plugin 資料夾：

```text
<mod>/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── hooks.json
│   └── register.ts
└── tests/
```

檢查 Claude Code 會從 mod 讀到什麼：

```bash
claude plugin validate ./secret-guard
```

在 mod 的資料夾裡執行測試，不需要開 session：

```bash
claude plugin test
```

用 `--plugin-dir` 載入時，存檔就會自動重新載入。

## 關於吉祥物

通知圖示與 `ship-it` 裡的像素小生物是我自己畫的，靈感來自 Claude 的橘色吉祥物，不是 Anthropic 的官方素材。這個專案與 Anthropic 沒有從屬關係。

## 授權

以 MIT 授權釋出，詳見 [LICENSE](./LICENSE)。
