<div align="center">

# swiftgrok

**以原生速度阅读 OpenGrok 的大文件。**

一个即插即用的反向代理，为 [OpenGrok](https://oracle.github.io/opengrok/) 提供快速的虚拟化代码查看器——完全不改动 OpenGrok 本身。

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.24%2B-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Docker-lightgrey)](#快速开始)

[English](../README.md) · **简体中文**

</div>

---

在 OpenGrok 上打开一个万行文件，意味着浏览器要解析、布局并绘制**数 MB 的预渲染 HTML**——数十万个 DOM 节点，足以卡死任何一个浏览器。这个问题[从 2020 年起就有人在上游报告](https://github.com/oracle/opengrok/issues/3032)，至今没有解决，因为修复需要重构 OpenGrok 那套 jQuery 时代的 Web UI。

**swiftgrok 从外部修好它。** 它是一个挂在 OpenGrok 实例前面的小型反向代理：所有请求字节级透传，文件页默认由内置的懒加载查看器渲染——swiftgrok 替换的是 OpenGrok 的渲染层，搜索、历史等其余部分保持原样：

| 文件 | 之前（DOM 载荷） | 之后 |
| --- | --- | --- |
| `ConnectivityService.java`（10,978 行） | 4.0 MB | **7.4 KB** |
| `ActivityManagerService.java`（17,697 行） | 6.9 MB | **6.9 KB** |

查看器里渲染的行级 HTML **就是 OpenGrok 原生生成的**——语法着色、符号链接、主题全部复用，不存在第二套需要维护的渲染器，也没有功能漂移。

## 功能

- **虚拟滚动**——DOM 中只有可视区（±30 行），首屏只有几 KB
- **文件内查找**——接管 `⌘F` / `Ctrl+F`（原生查找只能搜到已渲染行）；匹配高亮以标签感知、实体感知的方式拼回 OpenGrok 原生标记
- **跨页选择与复制**——选区保存在模型空间（与基于 CodeMirror 的查看器同一思路），可以拖选远超已渲染窗口的范围，`⌘C` 复制完整文本
- **多源门户**——多个 OpenGrok 实例共用一个端口，门户页选择站点，带健康状态点
- **认证透传**——HTTP Basic / 表单会话原样转发，在代理域名上登录一次即可
- **fail-open**——结构不符预期的页面原样透传；OpenGrok 升级最多让体验退化，绝不会坏
- **单二进制、零依赖**——纯 Go 标准库；前端内嵌（无需 Node 工具链）

## 快速开始

```bash
make build
cp config.example.json config.json   # 指向你的 OpenGrok
./swiftgrok -config config.json
```

打开 `http://127.0.0.1:8081/`，选择站点即可浏览。swiftgrok 不运行时照常用 OpenGrok，两者互不干扰。

### Docker

```bash
docker compose up -d --build
```

## 配置

```json
{
  "listen": "127.0.0.1:8081",
  "sources": [
    { "name": "local", "upstream": "http://127.0.0.1:8080", "context": "/source" },
    { "name": "android13", "upstream": "http://opengrok.example.com", "context": "/android13" }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `listen` | 唯一入口：门户 + 所有源。Docker 内用 `0.0.0.0:8081` |
| `name` | 门户与工具栏显示的名称 |
| `repo` | 可选，门户卡片上显示的仓库标识 |
| `upstream` | OpenGrok 基地址（`scheme://host[:port]`） |
| `context` | webapp 上下文路径（`/source`、`/android13`……）。必须唯一——各源在同一监听端口上按上下文路径复用，因此永远不需要改写页面链接。`/` 保留给门户 |
| `thresholdLines` | 低于该行数的文件页回退为 OpenGrok 原生渲染。`0`（默认，推荐）= 全部文件页都由 swiftgrok 渲染 |

## 工作原理

OpenGrok 的 xref 页面把**每行源码渲染为 HTML 中独立的一行**，都在单个 `<pre>` 里——这一约定自 0.12 版本以来跨版本稳定。swiftgrok：

1. **切分**页面：按行边界切开，把跨行标签（块注释、字符串）补平衡，得到每行自包含、可独立渲染的 HTML；
2. **供壳**：保留 OpenGrok 自己的 masthead、搜索框与脚本，代码区替换为微型虚拟滚动查看器；
3. **供数**：通过 `GET <context>/swiftgrok/api/lines?p=<path>` 提供行数据，按上游 `ETag` 条件缓存。

```
browser → swiftgrok :8081 ── /            门户（站点选择）
                          ├─ /source/**   → OpenGrok A（透传）
                          ├─ /android13/** → OpenGrok B（透传）
                          └─ 大 xref 页   → shell + 行数据 API + 查看器
```

## 兼容性

- 在 OpenGrok **1.5.10 与 1.13.25** 上实测（行级约定远早于此版本，任何无法识别的页面都原样透传）
- 任意现代浏览器均可受益——重的 DOM 工作在服务端完成
- HTTP 认证（Basic 或表单登录）实例可正常穿透；唯一不支持的场景是跳转到其他域名的跨域 SSO

## 路线图

- [ ] 搜索结果高亮行深链（`hl` 锚点）
- [ ] 代码折叠（`fold-space`）支持
- [ ] 双击选词、Shift + 方向键扩展选区
- [ ] 主题定制（自定义 CSS 注入点）

## Star History

<a href="https://star-history.com/#magicdian/swiftgrok&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=magicdian/swiftgrok&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=magicdian/swiftgrok&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=magicdian/swiftgrok&type=Date" />
 </picture>
</a>
