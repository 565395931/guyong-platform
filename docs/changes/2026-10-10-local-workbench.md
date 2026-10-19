# 本地工作台：备注、会话隔离与重新配对

日期：2026-10-10。记录本次已经实施的改动，不将历史测试或待办当作当前状态。

## 已完成

- 本地聊天头部新增“备注”，通过现有授权接口更新本地会话显示名称。稳定客户 ID 不变，不写远端；清空备注后显示渠道用户 ID。保存失败保留草稿，取消未保存修改需确认。
- 归档会话不显示释放、转 AI、再次归档等生命周期动作，仅提供“复活”；归档状态禁止发送，复活后进入待人工。
- 切换渠道、账号或离开工作台时清空旧会话；过期加载结果不能恢复其他渠道的对话，回复草稿按会话隔离。
- 远端移除客户备注入口；旧备注修改接口返回 410。新的消息适配不继承远端测试备注，保留客户稳定标识、卡片与图片能力。
- 远端保留“连接本地工作台”配对按钮，本地保留“连接远端”。继续使用现有 Element Plus 界面，不引入新视觉体系。

本地备注沿用 conversations.user_name，并不是更改微信昵称或新增微信头像获取能力。保留本地记录时，同一店铺的后续消息沿用本地名称；删除本地数据后不会保留该名称。

## 指定数据清理

用户明确授权删除“成长资料铺”本地接入及聊天记录。实际操作先检查店铺身份与关联范围，撤销远端连接凭证，再加密备份并事务删除：

- 本地渠道账号 1 个、会话 1 个、消息 8 条。
- 会话池日志 6 条、该账号客户身份关联 1 条。
- 没有删除其他店铺、订单、客户主档、远端店铺登记或远端原始消息。

加密备份：Rag/logs/growth-shop-delete-1791555049203.enc。恢复需要原本机凭证加密密钥；不能把备份或密钥提交到仓库。删除后正常接口确认连接列表、该渠道消息与会话统计为空。

远端历史备注数据没有物理清空，但功能已经停用，不再由新接入继承；这与用户要求“移除功能”一致。

## 部署及服务

仅部署独立远端后台四个文件并重启其服务：shopGatewayAdapter.js、cloudMessagingService.js、controlPlaneServer.js、cloud-console/public/assets/cloud.js。

部署前代码/数据备份位于 /opt/lonely-warrior/backups/local-remarks-20261009-2213/。没有改 Nginx、企业官网、企微回调进程或小店客服模式，也没有开启小店自动回复。

后续发现本机 Docker 未运行，按此前授权启动现有 MySQL/Redis 容器及本地服务；没有重建或清空数据库，没有启动 WAHA。确认工作台登录页返回 200，后端连接 MySQL/Redis 成功。

## 验证与限制

- 前端 176 项、后端 603 项、网关 108 项测试通过，前端构建通过。
- UI 严格静态审计零问题；公网资源确认配对按钮存在、远端备注按钮不存在；远端服务 active。
- 用户已确认之前真实双向收发测试成功。这不代表本轮新备注/归档/切换交互已经做过真实浏览器验收。
- 本轮浏览器停在登录页，未注入登录状态；最新界面完整点击和视觉验收待用户登录验证。

## 手动重新连接

1. 远端后台进入微信小店，找到成长资料铺，点击“连接本地工作台”获取一次性配对码。
2. 本地客服账号管理选择微信小店，点击“连接远端”填写配对码。
3. 刷新工作台，使用测试账号验证文字、图片、人工回复，以及本地备注、归档复活和渠道切换。

重新配对会同步远端保留的历史消息，这是正常重放，不表示本地删除失败。

## 相关模块

- Rag/platform-web/src/components/Conversation/CustomerRemarkDialog.vue
- Rag/platform-web/src/components/Chat/ChatWindow.vue
- Rag/platform-web/src/modules/conversations/channelScope.js、conversationActions.js
- Rag/platform-web/src/views/Workbench/WorkbenchView.vue、views/PlatformMessages/PlatformMessagesView.vue
- Rag/rag-server/src/routes/conversations.js
- wehook/src/saas/shopGatewayAdapter.js、cloudMessagingService.js、controlPlaneServer.js
- [接入契约](../../wehook/docs/local-workbench-pairing.md)、[界面行为契约](../../Rag/platform-web/UX-CONTRACT.md)
