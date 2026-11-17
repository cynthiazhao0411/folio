# Folio

一个为手机设计的轻量电子书阅读器。纯前端实现，无需服务器、无需安装，添加到主屏幕即可像原生 App 一样使用，所有书籍与阅读数据只保存在本机。

A lightweight, mobile-first e-book reader built as a Progressive Web App. No backend, no build step — books and reading data never leave the device.

## 功能 Features

- **多格式导入**：结构化 HTML、普通 HTML（按标题自动分章）、TXT（自动分章，自动识别 UTF-8 / GBK 编码）
- **分页阅读**：基于 CSS 多栏的分页排版，支持点击、滑动翻页
- **仿真翻页**：手指拖动时纸张跟随，带纸背与折线阴影；全部使用 GPU 合成的 transform 动画
- **书架**：自动生成封面、阅读进度、长按删除、同书重新导入保留进度
- **阅读设置**：字号、三种底色（米白 / 护眼绿 / 夜间）、翻页方式，自动记忆
- **离线可用**：Service Worker 缓存，无网络也能打开
- **备份与恢复**：一键导出全部书籍和进度为 JSON 文件

## 技术实现 Technical notes

| 模块 | 说明 |
|---|---|
| `importer.js` | 文件解析：DOMParser 解析 HTML 结构；TextDecoder 识别编码；正则识别 TXT 章节 |
| `reader.js` | 排版与翻页：一次排一章，CSS `column-width` 切页，`translate3d` 定位；双缓冲 “两张纸” 轮换实现仿真翻页，空闲时预排下一章 |
| `db.js` | IndexedDB 封装，书籍信息与正文分表存储，书架页只读轻量元数据 |
| `app.js` | 书架、导入、设置、进度保存（防抖写入）、备份恢复 |
| `sw.js` | 网络优先 + 缓存兜底的离线策略，发布更新后重开即生效 |

纯 HTML / CSS / JavaScript，无框架、无依赖、无构建步骤。

## 本地运行 Run locally

```bash
python -m http.server 8000
```

浏览器打开 `http://localhost:8000`。手机与电脑在同一网络时，可用电脑的局域网 IP 访问。

## 部署 Deploy

推送到 GitHub 后在仓库 Settings → Pages 选择 `main` 分支根目录即可。
