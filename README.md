# 微博超话自动签到（Egern）

在 Safari 打开 m.weibo.cn 登录，Cookie 会被自动捕获保存，之后每天定时自动签到已关注超话。

## 功能

- 自动捕获微博网页 Cookie（m.weibo.cn）
- 每日定时签到已关注超话
- 签到结果通知（成功/部分失败/无 Cookie）

## 导入

Egern → 模块 → 右上角新建 → 粘贴订阅地址：

```
https://raw.githubusercontent.com/buleeee1111/egern-weibo-checkin/main/weibo-super-checkin.yaml
```

## 使用

1. 保持「自动获取 Cookie」开启
2. 用 Safari 打开 https://m.weibo.cn/ 并登录（已登录则刷新一下个人页）
3. 看到「Cookie 获取成功」通知即完成
4. 默认每天早上 8:30 自动签到，可在模块设置里调整开关

## 隐私

- Cookie 只存在 Egern 本地存储，不上传任何服务器
- 模块只做超话签到，不会发微博、点赞、评论、转发
