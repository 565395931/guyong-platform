# 微信小店转人工、发送回执与图片聊天框

## 原因与处理

- 截图会话在2026-10-10 10:44:33 UTC被遗留负面情绪判断转到待人工；此前另有客户关键词和JSON manual_operation转人工。正式AI移除独立情绪检测与回复文案二次转人工，正常reply/clarify继续回答，客户主动人工与JSON handoff保留。AI/待人工未认领均可继续AI，认领后停止。
- 截图两条发送失败均由微信小店明确返回10190010，官方定义为消息命中风控，未返回成功编号。无法由此确定具体触发内容；链接、联系方式只是可能因素。加入小店渠道提示，优先当前聊天内咨询，不主动站外引流，不承诺无工具的自动发附件。
- 失败原因写入消息JSON，界面显示具体原因。unknown和发送中不算成功，不提供盲目重试。迟到accepted/HTTP响应不能覆盖最终回执。对截图两条已确认失败且无平台编号的记录补充原因，没有重发。
- 转接提示原system+会话ID+时间戳超过数据库36字符，修正为UUID。

## 图片链路

ChatInput选择/粘贴/拖入 → 既有本地媒体库上传 → 预览 → 按UUID读取媒体库真实文件 → 已配对HTTPS图片接口 → 微信cosupload → sendmsg image → 微信编号 → 本地状态。只接受PNG/JPG、5MB以内，这是当前产品上传限制；微信文档允许媒体30MB。检查真实路径防逃逸，不抓取客户端任意URL。

接口按配对客户、店铺与OpenID隔离，稳定requestId去重。平台最终回执写入持久Outbox，断线补收。图片和文字分开发送，失败保留附件，未知结果清除附件避免重复发；媒体重试及刷新保留mediaFileId。

## 验证

- 正式AI流程reply/clarify/handoff隔离回归3项通过；转接与认领状态回归5项通过。
- 远端完整测试129项通过；前端171项通过，构建成功，严格UI审计0问题。最终后台完整测试数见下方最终复核。
- 浏览器实际验证选择、粘贴、拖入、图片预览、成功清除附件与模拟失败保留；模拟失败只在隔离浏览器拦截，未调用真实发送。
- 用户指定EOHVOO（工作台实际尾号EOHv0o）测试：一张标记“图片发送测试”的图片成功发送，平台返回消息编号。本地消息4494eb1d-4962-44d2-a348-7e2b431f0c83为sent，平台编号存在。发送前后未认领，保持pending_human/pending_claim；此前是JSON handoff，不是人工认领。没有改写真实客户入站消息。
- 指定测试客户之前的一次图片尝试被本地编号校验拦住，未发送到微信；媒体库UUID适配已修复并重新实际验证。
- 新客户后续入站触发自动回复仍需真实消息验证，未伪造客户消息或宣称收件人已读。

## 部署

远端121.196.214.206已更新controlPlaneServer/cloudMessagingService/wechatShopService/wechatShopClient/localShopTransport，备份源代码及Nginx至/opt/lonely-warrior/backups/shop-images-source-20261010-1110.tar.gz和provider-wecom-20261010-1110.conf。仅图片路径增加7m请求容量，其他限制保持。Nginx校验通过，控制平面重启和Nginx重载成功。本地后端已在无活动AI任务时重启；前端已构建。未覆盖业务数据，未启动WAHA。

官方依据：[发送消息](https://developers.weixin.qq.com/doc/store/shop/API/kf/api_sendmsg.html)、[上传多媒体资源](https://developers.weixin.qq.com/doc/store/shop/API/kf/api_cosupload.html)。官方页面通过远端只读请求核对，浏览工具无法直接读取。

最终复核：后台605项、前端171项、远端129项，共905项测试通过。图片实际发送后的本地连接在线，服务无新错误。
