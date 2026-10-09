# swiftgrok

让 OpenGrok 的大文件浏览不再卡死 Safari。

swiftgrok 是一个放在 OpenGrok 前面的轻量反向代理（单二进制、零第三方依赖）。搜索、历史等所有请求字节级透传；只有超过行数阈值的 xref 文件页会被改写为「懒加载查看器」：浏览器首屏只收到几 KB 的页面骨架，代码行按需虚拟滚动渲染。行级 HTML 是 OpenGrok 原生生成的，语法着色、符号链接、主题完全复用，无需重新实现。

```
Safari → swiftgrok (127.0.0.1:8081) ── 单一入口
           ├─ /                      站点选择门户（浅色主题 + 健康状态）
           ├─ /source/**             → 本地 OpenGrok (127.0.0.1:8080)
           │    └─ xref 大文件       → 查看器 shell + lines API
           └─ /android13/**               → 公司 OpenGrok (opengrok.example.com)
                └─ 其余一切请求      字节级透传
```

多个源在同一个监听端口上按上下文路径复用（与公司 nginx 门户同构），因此 OpenGrok 页面的绝对路径链接无需任何改写。

实测（OpenGrok 1.13.25 / 1.5.10）：`ConnectivityService.java`（10,978 行）首屏 4.0MB → **7.4KB**；`ActivityManagerService.java`（17,697 行）6.9MB → **6.9KB**。

## 快速开始

```bash
make build
cp config.example.json config.json   # 按需修改
./swiftgrok -config config.json
```

浏览器访问 `http://127.0.0.1:8081/`，从门户选择站点进入。swiftgrok 不运行时直接访问 OpenGrok 原地址即可，互不影响。

### Docker 部署

```bash
# config.json 的 listen 改为 "0.0.0.0:8081"
docker compose up -d --build
```

零第三方依赖、静态编译（`CGO_ENABLED=0`），镜像只包含一个二进制。

## 配置

`config.json`：单一监听地址 + 源列表，每个 OpenGrok 实例一个源：

```json
{
  "listen": "127.0.0.1:8081",
  "sources": [
    { "name": "local", "upstream": "http://127.0.0.1:8080", "context": "/source" },
    { "name": "android13",  "upstream": "http://opengrok.example.com",   "context": "/android13" }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `listen` | swiftgrok 监听地址；Docker 内用 `0.0.0.0:8081` |
| `name` | 标识，显示在门户与工具栏 |
| `repo` | 可选，门户卡片上显示的仓库名，如 `aosp-android13` |
| `upstream` | OpenGrok 基地址（scheme://host[:port]） |
| `context` | webapp 上下文路径，如 `/source`、`/android13`；**必须唯一**（这是单端口复用的前提），`/` 保留给门户 |
| `thresholdLines` | 超过此行数的 xref 页启用查看器。**0（默认）= 全部文件页都走 swiftgrok 渲染**；设为正数可让小文件原样透传 |

所有页面右上角都有返回 swiftgrok 主页的按钮（查看器在工具栏内，其余页面为悬浮胶囊），方便随时切换站点。

需要登录的实例：凭据与 Cookie 均双向透传，直接在 swiftgrok 代理出来的页面上登录即可。实测公司受限实例为 HTTP Basic 认证（nginx HTTP auth realm）——Safari 会在代理域名上弹原生登录框，同一 realm 登录一次即可覆盖全部受限实例；门户卡片的状态点会区分「可访问 / 需登录 / 不可达」。唯一不适用的形态是跳转到其他域名的跨域 SSO。

## 工作原理

OpenGrok 的 xref 页面里，每一行源码恰好是 HTML 中独立的一行，以 `<a class="l" name="N">` 开头。唯一的复杂点是跨行标签（块注释/字符串）。swiftgrok 做三件事：

1. **切分**：按换行符切出每行，用标签栈把跨行标签在行首重开、行尾补闭，使每行成为自包含、可独立渲染的 HTML（本地与公司两个版本、数千行注释全部验证平衡）。
2. **改写**：首屏只保留页面骨架（masthead、搜索框、脚本全部原样），`<pre>` 内替换为虚拟滚动容器，注入 viewer。
3. **供数**：`GET <context>/swiftgrok/api/lines?p=<path>` 返回行数组 JSON，服务端按上游 ETag 做条件请求缓存（Cookie 参与缓存 key，避免搜索高亮串色）。

前端为无构建的 ES module + vendored Vue 3（`go:embed` 内嵌），虚拟滚动只渲染可视区 ±30 行；支持 `#行号` 锚点跳转、行号点击、字号/行高设置（localStorage 持久化）。上游 302 到绝对 URL 时会改写 Location 指回代理。

页面结构不符合预期时（如 OpenGrok 未来改版）自动退回原样透传，不会白屏。

## 结构

```
cmd/swiftgrok/          入口
internal/config/        配置加载与校验（context 唯一性）
internal/xref/          页面切分（span 平衡）+ LRU 缓存
internal/server/        单监听器、门户、代理、拦截改写、lines API
web/                    门户与查看器前端（embed 进二进制）
```

## 查看器功能

- **文件内查找**：`⌘F` / `Ctrl+F` 接管原生查找（原生只能搜到已渲染行），Enter/Shift+Enter 在匹配间导航，Esc 关闭；高亮标注直接拼回 OpenGrok 原生行标记（跨标签、HTML 实体感知）
- **跨页选择复制**：选区保存在模型空间（与 cs.android.com 的 CodeMirror 同思路），拖动到边缘自动滚动继续选择，`⌘C` 从模型提取完整文本——选区和高亮只渲染可视区，但复制结果覆盖全部所选行
- **布局自适应**：动态测量 OpenGrok 固定头部的真实绘制底边，代码区与工具栏永不重叠；页面文档高度恒等于视口，不存在窗口级滚动

## 路线图

- [ ] 搜索结果高亮行跳转优化（hl 锚点）
- [ ] 代码折叠（fold-space）适配
- [ ] 双击选词、Shift+方向键扩展选区
- [ ] 主题定制（自定义 CSS 注入点）
- [ ] Safari Web Extension 设置面板 / 菜单栏 App
