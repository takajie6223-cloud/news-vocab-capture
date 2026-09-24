# 新闻取词生词本（Chrome 扩展）

**News Vocab Capture** — 在英文网页上单击 / 双击 / 划词，即时弹出中文释义气泡；一键收藏生词，侧栏复习（间隔重复）与导出。本地词库离线优先，查询过的词自动沉淀为个人词库，全部数据只存本机。

在英文网页读稿时：**单击 / 双击 / 划词**出中文释义气泡，一键 **★ 收藏**，侧栏复习与导出。

已覆盖主流英文新闻站点（路透、WSJ、NYT、经济学人、FT、卫报、Nikkei 等），以及 **X（Twitter）、GitHub、Hugging Face** 等社区/工具站。例如：nytimes.com、wsj.com、reuters.com、economist.com、x.com、github.com、huggingface.co…

设计说明见 [DESIGN.md](./DESIGN.md)。

## 功能

| 能力 | 说明 |
|---|---|
| 双击查词 | 弹出释义气泡：词性、中文、英文简释、音标 |
| 划词查词 | 短语/句可查；句子可整句翻译 |
| ★ 收藏 | 连同原句、文章标题、URL 入库 |
| 侧栏生词本 | 搜索、筛选、详情、跳回原文 |
| 间隔重复 | 1 / 2 / 4 / 7 / 15 天；「忘了 / 模糊 / 记得 / 太简单」 |
| 导出 | Anki CSV、Markdown |
| 设置 | 翻译源、字号、划词、整句翻译默认值、可选 LLM |
| 同步 | 设置 `chrome.storage.sync`；生词本 `chrome.storage.local` + 导出 |

## 安装（开发者模式加载）

1. 打开 Chrome，地址栏进入 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. **加载已解压的扩展程序** → 选择本仓库的 `extension/` 文件夹
4. 打开 <https://www.reuters.com/world/> 任意文章，**双击英文单词**即可

可选：在 `chrome://extensions/shortcuts` 确认或修改快捷键。

## 快捷键

| 键 | 作用 |
|---|---|
| `Alt+S` | 收藏当前气泡中的词 |
| `Alt+V` | 打开侧栏生词本 |
| `Alt+R` | 进入复习 |
| `Esc` | 关闭气泡 |
| 复习中 `空格` | 翻面 |
| 复习中 `Enter` | 「记得」 |

## 使用流程

1. 读 Reuters → 双击生词 → 看释义 → 点 **★ 收藏**
2. 右下角 `★ 今日 n` 或 `Alt+V` 打开侧栏
3. 侧栏 **开始复习** 或导出 Anki CSV / Markdown

导出文件会进入浏览器下载目录（Anki CSV / Markdown）。

## 目录

```
news-vocab-capture/
├── README.md
├── DESIGN.md
├── LICENSE
├── extension/                 ← 加载这个文件夹
│   ├── manifest.json
│   ├── icons/
│   └── src/
│       ├── lib/               存储 / 词典 / 翻译 / 记忆 / 导出
│       ├── content/           页面取词气泡
│       ├── background/        消息与快捷键
│       ├── sidepanel/         生词本侧栏
│       ├── options/           设置
│       └── popup/             扩展图标弹窗
└── test/                      自动化验收（Playwright + Node）
```

## 翻译源

按优先级：

1. **本地词表**（2664 词，`extension/src/lib/local-dict.js`）：命中则**离线秒回**，不联网
2. **词形还原**：says / warned / cancelled / officials 等变形词自动按原形再查一次词表（气泡音标行标「原形 xxx」）
3. **个人词库**（chrome.storage.local）：网络查询成功的单词自动沉淀，下次点同一个词本地秒回，重启浏览器依然有效；已收藏生词也直接命中
4. **Google 翻译公共接口**（词表没有时）
5. **MyMemory**（备用）
6. **可选 LLM**（设置里可开，一般不用）

`localOnly` 模式完全离线，只查本地词表 + 个人词库。

## 以后如何添加更多网站

只需改 **`extension/manifest.json`** 两处，然后重载扩展。

### 1. 在 `matches` 里加域名

找到 `content_scripts` → `matches`，追加两行（把 `example.com` 换成目标站）：

```json
"https://example.com/*",
"https://*.example.com/*",
```

### 2. 同样两行加进 `host_permissions`

```json
"host_permissions": [
  "...",
  "https://example.com/*",
  "https://*.example.com/*"
]
```

说明：

- `https://example.com/*`：主域名，**不能省**
- `https://*.example.com/*`：覆盖 `www.` 等子域名

### 3. 重载扩展（必须）

因为注入站点变了，不要只点刷新：

1. `chrome://extensions` → 扩展 **移除**
2. **加载已解压的扩展程序** → 仍选本仓库的 `extension/` 文件夹
3. 已打开的网页按 **`Cmd+R`** 刷新

### 示例：添加 BBC

在 `matches` 和 `host_permissions` 都加上：

```json
"https://bbc.com/*",
"https://*.bbc.com/*",
```

改完可把 `manifest.json` 里的 `version` 递增（如 `1.3.1` → `1.3.2`），便于确认是否已更新。

**小提示：** 若某站双击没反应，多半是还没重载扩展或页面未刷新；仍不行一般是站点拦截选择/点击，可改用划词。

## 修改与删除

- 改交互：`extension/src/content/content.js`、`content.css`
- 加词：`extension/src/lib/dict.js`
- 改翻译策略：`extension/src/lib/translate.js`
- 改记忆算法：`extension/src/lib/srs.js`
- 整项卸载：`chrome://extensions` 移除扩展，再删本文件夹即可

## 权限说明

仅访问 `manifest.json` 里已列入的网站，以及翻译/可选 LLM 接口；不采集无关浏览数据，生词本默认只存在本机。
