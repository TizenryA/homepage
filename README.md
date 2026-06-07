# homepage

渡鸦の小站 - GitHub Pages 首页。

## 页面

- 首页：`index.html`
- AI 短剧指南：`comfyui-drama.html`
- 公开监控快照：`monitor.json`

## 模型监控

首页不会在浏览器里直接跨域请求 NewAPI。`scripts/build-monitor.py` 会抓取公开聚合接口，生成只包含模型数量、24h 成功率、延迟、TPS、健康榜的 `monitor.json`。

不会写入用户、Token、渠道 ID、日志或余额等敏感信息。

定时任务每 30 分钟运行一次；如果核心数据没变，不会仅因为更新时间变化而提交。
