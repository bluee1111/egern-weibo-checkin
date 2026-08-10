# Egern 微博超话自动签到

适用于 Egern 的微博超话签到模块。打开微博后自动获取本机 Cookie，每天定时遍历并签到当前账号关注的全部超话。

## 功能

- 自动获取 `m.weibo.cn` 登录 Cookie
- 自动识别当前微博账号，可保存多个账号
- 获取全部已关注超话，支持分页
- 跳过当天已经签到的超话
- 每个超话间随机等待，降低请求过快风险
- `st` 验签失效时自动刷新一次并重试
- 签到结束后发送 Egern 本地通知
- 支持桌面组件查看今日状态
- 支持组件按钮或本地 URL 手动立即签到
- Cookie 仅保存在 Egern 本地 `ctx.storage`，不会上传到 GitHub或其他服务器

## 导入模块

在 Egern 中添加以下模块链接：

```text
https://raw.githubusercontent.com/buleeee1111/egern-weibo-checkin/main/weibo-checkin.yaml
```

## 第一次使用

1. 在 Egern 中导入并启用模块。
2. 在 Egern 中安装并信任 MITM 证书。
3. 确保模块里的 `m.weibo.cn` MITM 已开启。
4. 打开 Safari 访问 `https://m.weibo.cn/` 并确认已经登录。
5. 浏览个人页、超话页或刷新页面。
6. 看到“Cookie 获取成功，已开启自动签到”的 Egern 通知后，抓取完成。

如果微博 App 的请求没有经过 `m.weibo.cn`，用 Safari 打开 `https://m.weibo.cn/` 最稳。

## 签到时间

默认每天 08:30：

```text
30 8 * * *
```

导入模块时可修改 `CronExp`。Egern 使用本机时区。

## 在 Egern 中添加模块后，最稳的手动方式是添加“微博超话自动签到”小组件，点击组件里的“立即签到”或“重新签到”。

也可以在 Safari 打开以下本地触发地址：

```text
http://weibo-checkin.local/run
```

这个地址不是公网网站，只会在 Egern 模块已启用且规则已加载时被接管。若 Safari 显示打不开，优先用小组件按钮；不要把它当普通网页访问。


## 状态说明

签到通知包含：

- 账号数量
- 关注超话数量
- 成功/已签数量
- 失败数量
- 最多 6 条失败原因

若提示 Cookie 失效，重新打开 `m.weibo.cn` 登录并刷新页面即可自动更新。

## 接口

模块采用微博移动 H5 接口：

```text
GET https://m.weibo.cn/api/config
GET https://m.weibo.cn/api/container/getIndex?containerid=100803_-_followsuper
GET <超话按钮返回的签到 scheme>&st=<动态 st>
```

没有硬编码超话 ID，会从当前账号关注列表动态获取。

## 注意

- 微博接口可能随时调整；失效时请提交 Issue，并附脱敏后的错误信息。
- 高频请求可能触发微博风控，脚本默认在各超话之间随机等待 1.5 到 4 秒。
- 本项目只做签到，不发微博、不点赞、不评论、不转发。
- Cookie 属于敏感凭证，不要贴到 Issue、截图或公开配置中。

## 参考

接口行为参考了以下开源项目，并针对 Egern `ctx` API 重写：

- [200-design/Weibo-Super-Topic-Auto-Check-in](https://github.com/200-design/Weibo-Super-Topic-Auto-Check-in)
- [imhuimie/WeiBo](https://github.com/imhuimie/WeiBo)
- [DeraDream/egern-modules](https://github.com/DeraDream/egern-modules)

## License

MIT
