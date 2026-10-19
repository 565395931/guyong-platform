# 微信小店自研客服接入

本模块是商家自己的小店自研通道，不使用企业微信 SuiteID/SuiteSecret，不实现或宣称 ISV 授权代调用。运营后台统一收件箱可同时显示企业微信和小店消息。客户本地工作台的投递适配尚未包含在本次改动中。

## 官方依据（2026-10-09 核对）

- [商家客服指南](https://developers.weixin.qq.com/doc/store/shop/guide/connect/kf.html)：仅支持商家自研；两个模式互斥；必须先在测试店铺完成验证，切换后新咨询进入 API 通道。
- [消息推送](https://developers.weixin.qq.com/doc/store/shop/dev_before/message_push.html)：GET 验证 Token/timestamp/nonce 三参数 SHA-1，原样返回 echostr；POST 使用 msg_signature 和 Encrypt 四参数验签，AES-CBC 解密后核对 AppID。
- [稳定凭据](https://developers.weixin.qq.com/doc/store/shop/API/apimgnt/common/api_getstableaccesstoken.html)：POST stable_token，force_refresh=false，缓存凭据并避免并发刷新。
- [客服事件](https://developers.weixin.qq.com/doc/store/shop/notify/kf_callback/kf_msg_event.html)：commkf_send_msg_to_kf；持久化成功后返回 success；平台失败重试约 3.5 小时。
- [发送消息](https://developers.weixin.qq.com/doc/store/shop/API/kf/api_sendmsg.html)：request_id 去重；用户消息后 48 小时最多回复 5 条；平台接口错误仍是最终判定。

## 操作顺序

运营后台「微信小店」仅显示店铺列表；点击新增打开独立配置窗口。操作步骤保留在此文档，不再占用页面：

1. 准备要接入店铺自己的 AppID / AppSecret，不能复用其他店铺凭证。网站不区分测试/正式类型，统一流程不替代小店自身的资格或接入要求。
2. 点击新增店铺；系统提前创建两小时有效的回调草稿，地址可立即验证。选择所属客户并填写名称、AppID、AppSecret；同一企业可选同一个客户，不覆盖其他店铺。
3. 弹窗直接显示服务器地址、Token 和消息密钥，文本字段右侧可复制。将三项粘贴到小店提交验证，再保存小店配置；保存沿用同一地址。未保存草稿仅可验证，不处理消息。重新生成会废弃旧草稿参数。AppSecret 仅显示本次输入，已有值不回显、留空保持；回调参数在管理员弹窗明文显示，关闭清除。
4. 保存后在店铺列表点击「测试接口连接」，仅检查已保存的 AppID / AppSecret，不发送客服消息。白名单应填云端执行服务器出口 IP，不是个人电脑 IP。
5. 小店消息推送设置填入该店专属 HTTPS 地址 `/v1/shop/callback/<接入ID>`、同一 Token / EncodingAESKey，提交并确认地址验证。一个店铺只能配置一个推送地址；已有订单等业务不要直接覆盖。本模块仅消费客服事件，其他事件返回 success 后忽略，不替代订单处理器。
6. 对当前店铺执行客服管理 → 客服设置 → 接入自研客服，由超级管理员阅读协议并扫码切换；营业中店铺安排低咨询时段与人工值守。
7. 从微信发真实文字和图片，在本平台确认接收/预览；手动回复并确认微信收到；配置模型，生成包含完整会话的 AI 草稿，经人工确认再发，验证微信收到。模拟测试、凭证有效和地址验证均不能冒充此项完成。
8. 日常处理咨询；更换配置后重新验证。异常时由管理员按小店页面提示恢复原客服；历史记录不互通，现有会话可能留在原模式。

不会由网站自动切换模式、接受协议或启用自动回复。正式店铺既有配置正确时不要求重新生成密钥。

## 实现边界与安全

### 远端 Rag 客服适配审查（2026-10-09）

- GitHub origin/main 已 fetch 并执行 ff-only pull，结果 Already up to date；当前本地提交领先远端 1 个，未提交小店功能未覆盖、未推送。
- 当前云端小店通道进入控制平面收件箱，尚未连接 Rag 的持久 WSS 投递。现有 `/v1/account/devices` 设备令牌仅支持额度操作，不是消息订阅协议。Rag 的 `wechat_shop_commerce` 是商品/订单适配器，不能作为客服发送接口。
- 新回调保存 UnionID、商品/订单编号、引用摘要及引用发送者、语音/视频时长，数据使用字段白名单，不保存完整解密回调。旧消息未保存的信息无法凭空补回。图片仍走鉴权媒体代理，原始签名地址不公开。
- 官方客服回调没有当前用户昵称和头像；reference.ref_msg.from_name 是被引用消息发送者，不等同于当前用户。会员接口 `/channels/ec/vip/user/info/get` 返回 OpenID、UnionID、等级和经验值，也不返回昵称/头像。不得把不同店铺的 OpenID、企业微信 external_userid 或订单收货姓名混用。允许将用户主动提供的信息或人工备注作为独立来源资料，不能冒充微信原生昵称。

两端待实现匹配（须先确认远端仓库和执行位置）：

| 云端 | Rag 侧 | 契约 |
| --- | --- | --- |
| 小店 installation.id + tenantId | 渠道账号 accountId + gatewayAccountId | 显式登记，一家店一条映射；不能用 AppID 充当内部数字账号 |
| externalUserId / unionId | channelUserId / metadata.unionId | 保留原身份，店铺作用域隔离；UnionID 缺失仍能接收消息 |
| 消息编号/时间/类型/正文/shopDetails | StandardMessage + 稳定 eventId | 原始消息编号、UTC 时间、卡片和引用元数据；有合法资料才填 userName |
| 私有图片 | 鉴权媒体下载并本地保存 | 不把管理员 cookie 或签名地址暴露给前端，不公开回调密钥 |
| 持久投递队列 | processed/duplicate/rejected/retryable_error ACK | 断线重放、重复去重，不把 socket.send 当已处理 |
| 官方客服发送 + request_id | 统一出站 dispatcher + commandId | 实际发送结果回写，超时未知状态可查；不得走 commerce/noop 伪造成功 |

候选传输为 Rag 主动连接云端 WSS，先解决按租户/设备授权和店铺映射，再接 Outbox/ACK/重放与回复闭环。现有通用 GatewayServer 使用共享服务令牌、可遍历队列，不能直接作为多客户生产隔离方案。需验证昵称/头像来源、媒体权限、双端账号、幂等与路由目标；本次未扩展线上权限、未部署、未发真实消息。

- AppSecret、回调 Token/AESKey、访问凭据和图片下载地址加密落盘，配置 API 只返回是否已填写。
- 回调路径绑定登记店铺与客户，不接受回调正文自报 tenantId；AppID 与客户归属创建后不可直接修改。
- 消息按渠道/店铺/客户/消息编号去重。重复回调和服务重启不重复入站。
- 图片仅通过已登录运营后台的同源接口读取；来源严格限定微信素材域名与路径、禁止重定向、8MB 上限。不新建公开附件 URL。
- 支持接收文字、图片、语音转文字、商品/订单编号，以及其他类型占位提示。视频/文件暂不支持下载播放；商品/订单卡片不会自动拉详情。
- 出站先实现文本。复用全会话 AI 建议与人工确认发送，不自动回复，不改变额度计费逻辑。
- 发送任务持久化并使用平台 request_id；超时结果未知时保留任务，刷新页面仍可恢复原内容与任务 ID重试。不能把未知结果显示为已发送。
- 回调 POST 时间窗口 4 小时，兼容平台约 3.5 小时重试；GET 地址验证为 5 分钟。凭据普通模式刷新带单进程并发锁，当前控制平面不支持多副本同时写同一个文件存储。
- 存储沿用现有控制平面文件数据边界，不新增长期保留承诺。正式多店商业使用仍需确认平台规则与数据保留政策。

## 发布

只需更新独立 control-plane 的源码和静态资源，重启对应 systemd 服务。既有 provider 进程已代理 `/v1/` 与 `/assets/`，本模块无需修改 Nginx、企业网站代码或既有企业微信回调地址。数据结构读取时兼容旧数据；部署前备份代码与原数据，备份不能公开访问。

## 验证

`node --test test/wechat-shop.test.js` 为离线 Mock 测试，不请求真实微信或模型服务。上线后仍需配置真实凭证并验证一条实际客服消息及回复，才可以宣布真实接入成功。
# 客户身份与订单（2026-10-09）

客服回调的 `FromUserName` 为小店 OpenID；`union_id` 可选。它们不是昵称或头像；引用消息的 `from_name` 也不能当作当前客户的名字。网关以租户 + 店铺安装 ID + OpenID 保存稳定客户档案，人工备注和标签优先显示，采用 revision 拒绝跨窗口覆盖。旧会话无需批量迁移，首次编辑或后续消息创建档案。

消息工作台的小店会话新增「客户备注」「关联订单」。先查询最近 7 天创建的订单，使用官方 `openid` 筛选，每页 20 个 ID；下一页使用加密且绑定会话的 15 分钟游标。第一页同时检查最近 10 张入站订单卡片，覆盖卡片指向的较早订单。不默认扫描所有历史，不自动查询正式店铺、不发送客服消息。

逐条获取订单详情并校验当前 OpenID：普通订单为购买人；礼物区分送礼人和收件人。转发卡片不证明归属，不相关详情不返回；详情暂不可用单独计数。接口只返回订单号、状态码、时间、商品标题/规格/数量、金额（分）和归属类型，原订单/收货地址/电话不保存、不回显、不自动调用敏感信息解密接口，也不自动给 AI 加入订单信息。

`user_info.nickname/head_img_url` 是官方特定潮玩订单的条件字段，不是所有客服客户的基本资料接口。本阶段可展示归属已确认的订单昵称（标注订单来源，不覆盖备注），头像尚未做展示/代理。普通订单没有这些字段时继续显示人工备注或 OpenID 简称，绝不编造身份。

接口仅运营管理员可调用，Cookie 鉴权、同源修改校验、no-store，审计记录不含备注、正文或订单原文：

- `PUT /v1/admin/inbox/:conversationId/customer`：`{remark,tags,revision}`。
- `POST /v1/admin/inbox/:conversationId/orders`：`{cursor:null|上页游标}`。

官方依据：[客服回调](https://developers.weixin.qq.com/doc/store/shop/notify/kf_callback/kf_msg_event.html)、[订单列表](https://developers.weixin.qq.com/doc/store/shop/API/channels-shop-order/api_getorderlist.html)、[订单详情](https://developers.weixin.qq.com/doc/store/shop/API/channels-shop-order/api_getorder.html)、[敏感信息解密](https://developers.weixin.qq.com/doc/store/shop/API/channels-shop-order/api_decodesensitiveinfo.html)。

验证：新增模拟测试覆盖备注跨会话、跨店隔离、并发冲突、旧存储兼容、订单归属/礼物/卡片、分页防篡改和过期、官方请求字段。已完成本地隔离浏览器保存备注、草稿保留、订单显示、未保存关闭保护及 390px 窄屏弹窗检查。真实小店昵称、订单权限、真实订单匹配仍须测试账号联调；Rag 同步、手机通知与自动接管尚未包含在本阶段。
