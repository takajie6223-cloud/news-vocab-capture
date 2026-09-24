# Reuters 取词生词本 · Chrome 扩展 DESIGN

## 1. 目标

在 `reuters.com` 阅读英文新闻时：

1. **双击单词 / 划词** → 立刻弹出中文释义气泡
2. **一键 ★ 收藏** → 连同原句、文章标题、URL 入库
3. **侧栏生词本** → 检索、复习（间隔重复）、导出
4. **设置面板** → 翻译源、字号、是否默认整句翻译
5. **chrome.storage 同步** → 设置跨设备；生词本以 local 为主、可导出备份

## 2. 视觉方向

| 项 | 选择 |
|---|---|
| 锚点 | Apple 词典弹层 + Notion 侧栏工具感；克制、纸感、非营销站 |
| 背景 | 纸白 `#FAFAF8` / 气泡 `#FFFFFF` |
| 墨色 | 主文 `#1A1A18` / 次文 `#5C5C56` / 弱 `#8A8A82` |
| 强调 | 路透橙 `#FA6400`（★、主按钮、当前态） |
| 辅助 | 成功 `#2F9E44` / 危险 `#C92A2A` / 描边 `#E6E6E0` |
| 字体 | UI：`-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif` |
| 词条英文 | `Georgia, "Times New Roman", serif`（正文感，利于辨词） |
| 圆角 | 气泡/卡片 12px；按钮 8px |
| 阴影 | 气泡：`0 8px 28px rgba(26,26,24,.12)`；侧栏几乎无阴影 |

签名时刻：双击后气泡在 80ms 内淡入上浮；点 ★ 时星标点亮并轻微弹跳，侧栏计数 +1。

## 3. 信息架构

```
extension/
  manifest.json
  icons/
  src/
    lib/          storage · dict · translate · srs · export
    content/      取词气泡、浮动条（注入 Reuters）
    background/   快捷键、sidePanel、消息路由、安装初始化
    sidepanel/    生词本列表 / 复习卡片 / 搜索筛选
    options/      设置页
    popup/        点扩展图标的轻量入口（今日收藏、打开侧栏、设置）
生词本/           导出落盘目录（Anki CSV / Markdown）
```

## 4. 交互规格

### 4.1 取词气泡（content）

- 触发：双击英文单词；或选中 1–12 个词（可配置是否启用划词）
- 位置：选区右上，避开视口边缘
- 内容：
  - 单词（衬线大号）
  - 音标（有则显示）
  - 词性 + 中文释义（主）
  - 英文简释（有则显示，次）
  - 操作：★ 收藏 / 复制 / 整句翻译（若选中句子或点「句」）
- 选中**整句**（>12 词或含句末标点）且设置开启「默认整句翻译」→ 气泡直接展示中译；仍可点「只看单词」
- Esc / 点击空白 / 滚动 → 关闭
- 浮动小条（右下）：`★ 今日 n` → 打开侧栏

### 4.2 收藏数据模型

```js
{
  id: "w_<timestamp>_<rand>",
  word: "inflation",
  phonetic: "/ɪnˈfleɪʃn/",
  pos: "n.",
  meaning: "通货膨胀",
  defEn: "a general increase in prices",
  sentence: "原文句子…",
  title: "文章标题",
  url: "https://www.reuters.com/…",
  createdAt: 1710000000000,
  // SRS
  stage: 0,          // 0..4 → 间隔 1/2/4/7/15 天
  dueAt: 1710086400000,
  reviews: 0,
  lapses: 0
}
```

同一 `word`（小写归一）重复收藏时**更新上下文**并累加 `savedCount`，不丢历史句子（最多存 5 条例句）。

### 4.3 侧栏生词本（sidePanel）

- 顶栏：搜索框、筛选（全部 / 待复习 / 已掌握）、导出按钮、设置
- 列表：单词 · 释义 · 来源标题（截断）· 到期日；点开详情（原句、链接跳回原文）
- 复习模式：卡片正面英文 → 点击/空格翻面 →「模糊 / 记得」驱动 SRS
- 快捷键（commands）：
  - `Alt+S` 收藏当前气泡词
  - `Alt+V` 打开/聚焦侧栏
  - `Alt+R` 侧栏进入复习

### 4.4 设置（options + popup 快捷）

| 键 | 默认 | 说明 |
|---|---|---|
| `translateSource` | `auto` | `auto` / `google` / `mymemory` / `localOnly` |
| `enableLLM` | `false` | 可选：自定义 OpenAI 兼容接口做语境释义 |
| `llmBaseUrl` / `llmModel` / `llmApiKey` | 空 | 仅存 chrome.storage.sync（注意安全，本机使用） |
| `fontSize` | `15` | 气泡正文字号 12–20px |
| `sentenceDefault` | `true` | 划选句子时默认整句翻译 |
| `enableSelection` | `true` | 划词查词（双击始终可用） |
| `hotkeysHint` | `true` | 气泡内显示快捷键提示 |
| `domainAllowlist` | `reuters.com,www.reuters.com` | 域名白名单 |

## 5. 翻译源策略

1. **本地词表** `lib/dict.js`：新闻高频词，毫秒级，离线可用  
2. **Google 翻译公共接口**（`translate.googleapis.com`）：主在线源  
3. **MyMemory**：备用  
4. **可选 LLM**：结合原句给「新闻语境释义」（设置里开启）  
失败降级链：`auto` → 下一源 → 仅显示英文释义/词形，不阻塞收藏。

## 6. 存储与同步

| 数据 | 位置 | 原因 |
|---|---|---|
| 设置 | `chrome.storage.sync` | 跨设备、体积小 |
| 生词本 | `chrome.storage.local` | 条目多，sync 仅 100KB |
| 最近 50 条摘要 | `chrome.storage.sync`（`vocabSyncMeta`） | 弱同步提示；完整数据以 local + 导出为准 |
| 导出 | `生词本/` 目录（下载） | Anki CSV、Markdown |

## 7. 权限（manifest v3）

- `storage`、`sidePanel`、`activeTab`、`scripting`、`downloads`（导出）
- `host_permissions`: `https://www.reuters.com/*`, `https://reuters.com/*`, 翻译与可选 LLM 接口
- `content_scripts` 仅匹配 Reuters
- `commands` 全局快捷键

## 8. 范围边界

- 第一期域名聚焦 Reuters；架构用 allowlist，后续加 WSJ/BBC 只改设置  
- 不做账号系统；不同步服务端  
- 不注入广告、不采集无关浏览数据  

## 9. 里程碑（本次交付即 1–4）

1. 扩展骨架 + 图标 + manifest  
2. 双击/划词气泡 + 翻译 + ★ 收藏  
3. 侧栏生词本 + SRS 复习 + 导出  
4. 设置页 / popup / 快捷键  
5.（后续可选）LLM 语境释义打磨、更多站点  
