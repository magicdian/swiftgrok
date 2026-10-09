# swiftgrok

让 OpenGrok 的大文件浏览不再卡死 Safari。

swiftgrok 是一个放在 OpenGrok 前面的轻量反向代理（单二进制、零第三方依赖）。搜索、历史等所有请求字节级透传；只有超过行数阈值的 xref 文件页会被改写为「懒加载查看器」：浏览器首屏只收到几 KB 的页面骨架，代码行按需虚拟滚动渲染。行级 HTML 是 OpenGrok 原生生成的，语法着色、符号链接、主题完全复用，无需重新实现。

```
Safari → swiftgrok (127.0.0.1:8081) → OpenGrok (127.0.0.1:8080)
           ├─ /source/xref/**.html  行数 > 阈值 → 查看器 shell + lines API
           ├─ 其余一切请求          字节级透传
           └─ /source/swiftgrok/*   内嵌前端资产 / 行数据 API
```

实测（OpenGrok 1.13.25 / 1.5.10）：`ConnectivityService.java`（10,978 行）首屏 4.0MB → **7.4KB**；`ActivityManagerService.java`（17,697 行）6.9MB → **6.9KB**。

## 快速开始

```bash
make build
cp config.example.json config.json   # 按需修改
./swiftgrok -config config.json
```

然后浏览器访问 swiftgrok 的端口（如 `http://127.0.0.1:8081/source/xref/...`）而不是 OpenGrok 原端口。swiftgrok 不运行时直接访问原端口即可，互不影响。

## 配置

`config.json`，每个 OpenGrok 实例（源）一个本地端口：

```json
{
  "sources": [
    { "name": "local", "listen": "127.0.0.1:8081",
      "upstream": "http://127.0.0.1:8080", "context": "/source" },
    { "name": "android13", "listen": "127.0.0.1:8082",
      "upstream": "http://opengrok.example.com", "context": "/android13" }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 标识，显示在日志与工具栏 |
| `listen` | swiftgrok 本地监听地址，一个源一个端口 |
| `upstream` | OpenGrok 基地址（scheme://host[:port]） |
| `context` | webapp 上下文路径，如 `/source`、`/android13` |
| `thresholdLines` | 超过此行数的 xref 页启用查看器，默认 3000；小文件原样透传 |

需要登录的实例（如 HTTP auth）：直接在 swiftgrok 代理出来的页面上登录即可，Cookie 双向透传。注意：若登录是跳转到其他域名的 SSO，需要在登录后回到代理域名访问。

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
internal/config/        配置加载
internal/xref/          页面切分（span 平衡）+ LRU 缓存
internal/server/        代理、拦截改写、lines API、资产服务
web/                    查看器前端（embed 进二进制）
```

## 路线图

- [ ] 搜索结果高亮行跳转优化（hl 锚点）
- [ ] 代码折叠（fold-space）适配
- [ ] 主题定制（自定义 CSS 注入点）
- [ ] Safari Web Extension 设置面板 / 菜单栏 App
