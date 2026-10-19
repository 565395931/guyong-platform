# 内置客服JSON协议与百炼准备

## 已实现
- 内置replyProtocol独立模块，业务提示词保持正常填写，后端追加固定输出协议。严格校验action(reply/clarify/handoff)、非空reply、reason枚举，拒绝代码块/非法JSON/未知字段。
- 模型测试与正式推荐/自助回复使用同一协议；仅完成并验证整个JSON后展示回复文字，原始JSON不发送给客户。正式推荐SSE附带decision元数据。质检/情绪等内部专用提示词仍使用原格式。
- 自助接待读取模型handoff标记后调用既有aiTransferToHuman；失败/空回复/非法JSON立即转人工。客户消息包含“人工”直接转人工。没命中资料不再仅凭低分直接转人工，交给模型判断能否追问；保留既有质检与发送前会话状态核对。
- 测试页显示正常回复/继续追问/需要转人工及原因，仅模拟决策，不操作真实客户会话。

## 验证
- 后端623项、前端178项通过，前端生产构建通过，严格UI审计0发现；原有Sass弃用及大包提示保留。
- 独立测试账户真实调用：问候reply、询问运费且缺收货地址clarify、取消已付款订单handoff/manual_operation、包含人工直接handoff/customer_request且不调用供应商。
- 正式generateRecommendationStream合成调用得到handoff决策，只yield可见文字，无JSON泄漏。浏览器测试页显示客户要求人工、耗时0与正常文字，清空可用。
- 测试后恢复本地未配置连接、上下文20条；百炼凭据前后掩码状态一致。未发送真实客户消息、未开启自动回复、未执行真实渠道接管演练。

## 百炼结论
现有ragService使用Bailian20231229 SDK Retrieve，签名凭据是AccessKey ID/Secret，附Workspace ID、Index ID；Category ID用于上传管理流程，不是Retrieve查询的必填参数。
截图是百炼API Key，不能代替当前SDK所需的AccessKey。另一种知识检索REST接口使用API Key Bearer、Workspace ID拼接北京域名、Index ID，返回nodes资料片段再交给所选回复模型。此轮未切换现有百炼凭据或检索接口，也未进行真实知识库联调。
官方资料：
- https://help.aliyun.com/zh/model-studio/api-bailian-2023-12-29-retrieve
- https://help.aliyun.com/zh/model-studio/rag-knowledge-retrieval
后续联调需要同一业务空间下有效凭据、业务空间ID、知识库ID及至少一份已解析完成的文档。北京地域与截图一致。
