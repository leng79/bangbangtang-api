# 棒棒堂书房登记后台

此文件夹用于发布到“微信云托管”的 Express 服务。

发布前在服务设置中保留已有的 `MYSQL_ADDRESS`、`MYSQL_USERNAME` 和 `MYSQL_PASSWORD`，并新增：

- `MYSQL_DATABASE=bangbangtang`
- `ADMIN_USER`：老师后台登录账号
- `ADMIN_PASSWORD`：老师后台登录密码

服务启动后：

- `GET /health`：检查服务是否正常。
- `POST /api/register`：保存家长登记资料。
- `GET /teacher`：老师查看登记资料，需要浏览器账号密码登录。

不要把数据库密码、老师后台密码写进代码或发在聊天里。
