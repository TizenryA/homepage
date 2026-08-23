# homepage

渡鸦の小站 - GitHub Pages 首页。

## 页面

- 首页：`index.html`
- 实时模型监控：`monitor.html`
- AI 短剧指南：`comfyui-drama.html`
- 同源历史快照：`monitor.json`

## 模型监控

`monitor.html` 默认读取公开状态接口：

`https://play.tizenry.xyz/monitor-api/v1/public/status`

页面每 60 秒自动读取一次，也可以点击“立即刷新”重新 GET 该公开状态接口。按钮只负责读取最新状态，不会在公开页面触发全量探测；请求会使用 `cache: no-store`，并在重复点击、429 冷却和网络失败时保留明确状态。

当实时接口不可用或返回无法使用的数据时，页面会读取同源 `monitor.json`，并明确标注“历史快照”，不会伪装成实时数据。首页只保留轻量快照摘要与监控入口，不再渲染模型长列表。

真实探测由每 10 分钟调度任务运行，或由管理员认证接口触发；公开页面不调用探测/刷新接口。

不会写入用户、Token、API Key、渠道 ID、日志或余额等敏感信息。

`scripts/build-monitor.py` 用于生成同源历史快照；如果核心数据没变，不会仅因为更新时间变化而提交。

## 静态校验

```bash
python3 scripts/test-monitor-page.py
node scripts/test-monitor-behavior.js
```

校验脚本会检查首页旧长列表与 embed 外链已移除、入口和独立页面存在、公开状态接口地址、公开刷新不使用 POST、无新增 `px`、HTML 结构与内嵌 JavaScript 语法；Node 行为测试会覆盖实时监控页面的请求协调、失败回退、边界值和限流冷却。
