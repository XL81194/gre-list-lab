# GRE List Lab 云同步配置

## 1. 创建免费项目

在 Supabase 新建 Free 项目。项目创建完成后，只需要记录：

- Project URL，例如 `https://xxxx.supabase.co`
- Publishable key，以 `sb_publishable_` 开头

不要把数据库密码、Secret key 或 `service_role` key 写进网页或发给任何人。

## 2. 建表并开启访问控制

打开 Supabase Dashboard → SQL Editor → New query，把 `schema.sql` 的全部内容粘贴进去并运行一次。

脚本会创建：

- `user_progress`：登录用户只能读写自己的学习进度
- `feedback`：访客只能提交，不能读取任何人的反馈

## 3. 设置邮箱登录回跳地址

打开 Authentication → URL Configuration：

- Site URL：`https://xl81194.github.io/gre-list-lab/`
- Redirect URLs：加入 `https://xl81194.github.io/gre-list-lab/`

## 4. 接入网页

编辑根目录的 `supabase-config.js`：

```js
window.GRE_SYNC_CONFIG = {
    enabled: true,
    supabaseUrl: "https://xxxx.supabase.co",
    supabasePublishableKey: "sb_publishable_xxxx",
    appVersion: "2026.08-cloud-beta",
};
```

Publishable key 本来就是供浏览器公开使用的；真正的数据保护依赖 `schema.sql` 中启用的 RLS 权限规则。

## 5. 上线前验证

1. 在旧设备打开网页，确认原进度仍在。
2. 用邮箱登录，并在当前学习所用的同一浏览器中打开收到的最新一次性链接，看到“云端已同步”。
3. 在另一台设备重新申请一条登录链接并使用同一邮箱登录；不要转发或重复使用第一台设备的链接。确认进度合并出现。
4. 两台设备各完成一个词，再点“立即同步”，确认两边记录都保留。
5. 退出登录，确认本机进度仍在。
6. 提交一条测试反馈，在 Supabase Table Editor 的 `feedback` 表中确认收到。
