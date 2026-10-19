# 百炼API Key检索配置

## 实现
- 新增独立bailianSearchService，加密保存API Key、Workspace ID、Index ID，接口只回掩码；北京地域固定，host由合法业务空间ID构建，禁止任意地址和重定向。
- 知识库检索支持API Key模式，保存配置后采用Bearer鉴权的/api/v1/indices/rag/index/retrieve（真实联调时修正，见下方补充）；未保存前原SDK模式保持不变。API Key仅用于检索，旧AccessKey上传管理单独保留。渠道/知识范围仍用既有过滤器；不支持的SDK SearchFilters明确失败，不静默扩大范围。
- AI配置增加检索方式、API Key、业务空间、知识库ID、单独检索测试和ID查找指引；旧上传管理折叠收纳。
- 大模型测试增加使用百炼知识库开关（API配置完成才可用），将检索资料作为数据拼入系统上下文，随后追加固定JSON决策协议。转人工直接规则优先，不进行无用检索或模型调用。
- REST底层检索不执行SDK Rerank，资料分数是供应商召回分数；后续若需要精排，应单独接已发布检索服务。

## 验证
后端627项、前端178项通过；前端生产构建通过，严格UI审计0发现，git diff --check通过。原有Sass弃用及包体积提示保留。
单测验证密文保存、留空保留Key、目标域名/Bearer/知识库参数、恶意ID拒绝、错误脱敏，以及检索资料进入模型system上下文。
实际浏览器验证空字段服务端校验、未配置测试禁用、ID指引可见。模拟接口验证保存成功清空密钥输入、检索切片展示、鉴权失败保留问题并移除旧结果；假密钥未写入数据库、未请求百炼。本地后端已重启、前端已构建。
初次验收时尚缺用户完整百炼API Key和对应Workspace/Index ID，真实联调结果见下方补充。现有百炼AccessKey凭据未修改；原本空白的模型连接未修改。

## 找ID
截图设置左侧业务空间管理：复制API Key所属空间行的Workspace ID，不是API Key行ID或归属账号。北京地域、Key、知识库必须在同一空间。知识库ID位于对应知识库详情页，不是应用APP ID。
官方参考：
https://help.aliyun.com/zh/model-studio/obtain-the-app-id-and-workspace-id
https://help.aliyun.com/zh/model-studio/file-search
https://help.aliyun.com/zh/model-studio/rag-knowledge-retrieval

## 真实联调补充
用户提供完整配置后，原knowledge/search端点返回HTTP401、InvalidParameter、Agent application not found.，并非密钥无效。该端点用于已发布检索服务；单知识库应调用/api/v1/indices/rag/index/retrieve。相同凭据切换端点立即返回HTTP200和data.nodes。已修正端点并区分应用路由错误与鉴权错误。
配置已通过凭据加密服务保存，本地后端已重启。真实检索产品紫外线阻隔率、美国运费均命中5条；通过本地管理员测试路由再次返回HTTP200。已配置模型联合测试发送“基础款的紫外线阻隔率是多少？”，携带5条资料并返回action=reply及99%答案。没有发送真实客户消息或切换自动回复。
新增端点错误识别及实际data.nodes响应回归测试；模块9项、后端全量629项通过。此次未修改前端，无需重新构建。
官方端点说明：https://help.aliyun.com/zh/model-studio/rag/quickstart
