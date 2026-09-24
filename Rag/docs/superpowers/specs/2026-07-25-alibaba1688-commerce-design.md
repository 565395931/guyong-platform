# 1688 订单与退款接入设计

## 目标

在现有聚合客服平台内增加 1688 多店铺账号管理、订单与退款增量同步、业务事件查看和客户加密标识保留。系统必须使用 1688 开放平台官方服务端 API，不通过旺旺桌面端、浏览器脚本或 RPA 模拟客服操作。

## 官方能力依据

2026-07-25 从 1688 开放平台官方 API 目录和详情接口核对到以下当前能力：

- 卖家订单使用 `com.alibaba.trade:alibaba.trade.ec.getOrderList.sellerView-1`。这是“加密场景订单列表查看（卖家视角）”，需要用户授权和签名，支持修改时间窗口，页码从 1 开始，`pageSize` 最高 20。
- 退款使用 `com.alibaba.trade:alibaba.trade.refund.queryOrderRefundList-1`。接口需要用户授权和签名，支持退款修改时间窗口，`currentPageNum` 从 0 开始。
- 固定调用地址为 `https://gw.open.1688.com/openapi/param2/{version}/{namespace}/{apiName}/{appKey}`，内容类型为 `application/x-www-form-urlencoded`。
- 加密订单接口支持 `needBuyerAddressAndPhone=false` 与 `needMemoInfo=false`；买家筛选字段支持 `buyerOpenUid`。
- 官方 CRM 解决方案包含客户管理相关能力，但公开 API 目录没有适用于独立网页客服系统的通用买家聊天发送接口。旺旺消息统计或商家工作台插件能力不能当作服务端聊天发送 API。

## 方案选择

采用加密场景订单接口与退款接口的 30 分钟增量轮询。普通卖家订单接口可能扩大个人信息范围，不用于本系统；旺旺插件和浏览器自动化无法满足后端多店铺、可迁移和稳定运行要求，也不采用。

## 账号与凭据

内部渠道编码为 `alibaba1688`，适配器编码为 `alibaba1688_commerce`。每个店铺独立配置 `appKey`、`appSecret`、`accessToken` 和 `sellerMemberId`。秘密值只在创建账号时进入浏览器，服务端加密保存，列表和详情只返回 `credentialStatus` 与脱敏后的 `sellerMemberIdMask`。

Access Token 失效或授权撤销时，当前版本要求重新授权并重建账号。没有真实店铺授权前，只能通过注入官方形状响应验证系统合同，不能宣称生产数据已接通。

## 客户数据边界

订单请求始终显式发送 `needBuyerAddressAndPhone=false`、`needMemoInfo=false`、`isHis=false`。规范化时保留订单、商品、金额、状态、退款状态和 `buyerOpenUid`，并递归移除联系人、地址、电话、支付宝账号、真实姓名、登录名、留言和备注字段。退款同样保留 `buyerOpenUid`、退款单号、订单号、金额、原因、产品和状态，并清除个人联系信息。

`buyerOpenUid` 仅在同一 App Key 范围内稳定，客户画像必须以 `channel + accountId + buyerOpenUid` 作为隔离键，不能跨应用或跨店铺猜测合并。

## 调用与签名

客户端只接受代码内白名单 API，不能由账号配置覆盖 namespace、API 名称、版本或主机。签名按 1688 param2 规则，以 API 路径和排序后的非空参数生成 HMAC-SHA1 大写十六进制值；`_aop_signature` 不参与自身签名。请求使用 10 秒超时和无损 JSON 解析，错误只映射稳定错误码，不回显 Token、Secret、签名或上游错误正文。

## 同步模型

订单和退款继续使用 `channel_sync_state` 的 `order` 与 `after_sales` 资源。新账号从当前时间前 30 分钟开始，每个窗口最长 30 分钟，每页 20 条，最多 100 页。订单页从 1 开始，退款页从 0 开始；每页必须报告一致总数，记录数必须与总数和页码一致。

同一资源的全部页面先完成解析和规范化，再写入 `channel_event_inbox`。全部事件写入或确认重复后才推进游标。任何鉴权、签名、响应、分页、规范化或入库错误都只记录脱敏错误码并保留原游标。账号和资源互相隔离，一个资源失败后仍尝试同账号的另一个资源，一个账号失败不影响其他账号。

## 前端

侧栏新增可展开“1688”，子项为“业务消息”和角色保护的“账号管理”。账号表单包含 App Key、Seller Member ID、App Secret、Access Token；后两项使用密码框并在提交后立即清空。业务消息页只显示订单、退款和 `buyerOpenUid` 客户识别说明，不显示 AI 回复、人工回复、发送或回复买家控件。

## 验证

所有新行为先写失败测试。完成后运行后端、前端全量测试与 Vite 构建；使用真实 MySQL 仓库和注入的 1688 官方形状响应验证多页、去重、错误保游标和账号隔离；最后在桌面与手机视口验证菜单、表单、脱敏列表、长 ID、详情抽屉和无聊天控件。
