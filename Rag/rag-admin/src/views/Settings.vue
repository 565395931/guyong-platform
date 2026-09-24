<template>
  <div class="settings">
    <!-- 会话路由配置 -->
    <el-card>
      <template #header>
        <div class="card-header">
          <span>会话路由配置</span>
          <el-tag v-if="poolConfigLoaded" type="success" size="small">已加载</el-tag>
        </div>
      </template>

      <el-form class="settings-form-grid" label-width="160px" v-loading="poolLoading">
        <el-form-item label="AI 自助聊天">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch
                v-model="poolConfig.ai_self_pool_enabled"
                active-text="开启"
                inactive-text="关闭"
                inline-prompt
                :loading="isSavingKey('ai_self_pool_enabled')"
                @change="saveConfigKey('ai_self_pool_enabled')"
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #dcdfe6"
              />
            </div>
            <div class="config-tip">
              开启后，新客户消息将默认进入 AI 自助池，由 AI 自动回复；关闭后新会话直接进入公共池等待人工处理
            </div>
          </div>
        </el-form-item>

        <el-form-item label="AI 最大对话轮数">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.ai_max_rounds"
                :min="0"
                :max="20"
                :disabled="!poolConfig.ai_self_pool_enabled"
              />
              <span class="config-unit">轮</span>
            </div>
            <div class="config-tip">超过此轮数后 AI 自动转待人工池（0=不限制，建议3-10轮）</div>
          </div>
        </el-form-item>

        <el-form-item label="AI 置信度阈值">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="confidencePercent"
                :disabled="!poolConfig.ai_self_pool_enabled"
              />
              <span class="config-unit">%</span>
            </div>
            <div class="config-tip">RAG 置信度达到此值时 AI 正常回答（默认70%），低于谨慎区间下限时直接转人工</div>
          </div>
        </el-form-item>

        <el-form-item label="谨慎回答区间下限">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="cautiousMinPercent"
                :disabled="!poolConfig.ai_self_pool_enabled"
                :min="10"
                :max="confidencePercent - 1"
              />
              <span class="config-unit">%</span>
            </div>
            <div class="config-tip">三层策略：≥阈值正常回答 / 此值~阈值谨慎回答（给出部分信息+承诺确认） / &lt;此值转人工（默认40%）</div>
          </div>
        </el-form-item>

        <el-form-item label="情绪分析转人工">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch
                v-model="poolConfig.sentiment_check_enabled"
                active-text="开启"
                inactive-text="关闭"
                inline-prompt
                :loading="isSavingKey('sentiment_check_enabled')"
                @change="saveConfigKey('sentiment_check_enabled')"
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #dcdfe6"
              />
            </div>
            <div class="config-tip">检测到客户负面情绪时自动转待人工池</div>
          </div>
        </el-form-item>

        <el-form-item label="LLM 复杂度判断">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch
                v-model="poolConfig.complexity_check_enabled"
                active-text="开启"
                inactive-text="关闭"
                inline-prompt
                :loading="isSavingKey('complexity_check_enabled')"
                @change="saveConfigKey('complexity_check_enabled')"
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #dcdfe6"
              />
            </div>
            <div class="config-tip">新客户消息由 LLM 判断是否为复杂问题，复杂问题直接进入待人工池</div>
          </div>
        </el-form-item>

        <el-form-item label="语言兜底检查">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch
                v-model="poolConfig.language_guard_enabled"
                active-text="开启"
                inactive-text="关闭"
                inline-prompt
                :loading="isSavingKey('language_guard_enabled')"
                @change="saveConfigKey('language_guard_enabled')"
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #dcdfe6"
              />
            </div>
            <div class="config-tip">所有发给客户的文本消息都会检查语言是否匹配客户语言（不匹配时自动翻译）。防止 AI 回复、系统通知等出现语言错误</div>
          </div>
        </el-form-item>

        <el-form-item class="full-row" label="转人工关键词">
          <div class="form-item-content">
            <div class="control-row">
              <div class="keyword-editor">
                <el-select
                  v-model="poolConfig.ai_transfer_keywords"
                  multiple
                  filterable
                  :disabled="!poolConfig.ai_self_pool_enabled"
                  placeholder="暂无关键词，可在下方新增"
                  style="width: 100%"
                  @change="normalizeTransferKeywords"
                >
                  <el-option v-for="kw in poolConfig.ai_transfer_keywords" :key="kw" :label="kw" :value="kw">
                    <div class="keyword-option">
                      <span class="keyword-option__label">{{ kw }}</span>
                      <el-button
                        link
                        type="danger"
                        size="small"
                        :icon="Delete"
                        :disabled="!poolConfig.ai_self_pool_enabled"
                        @click.stop.prevent="removeTransferKeyword(kw)"
                      />
                    </div>
                  </el-option>
                </el-select>
                <div class="keyword-add-row">
                  <el-input
                    v-model="newTransferKeyword"
                    clearable
                    :disabled="!poolConfig.ai_self_pool_enabled"
                    placeholder="新增中文关键词"
                    @keyup.enter="addTransferKeyword"
                  />
                  <el-button
                    type="primary"
                    :icon="Plus"
                    :disabled="!poolConfig.ai_self_pool_enabled"
                    @click="addTransferKeyword"
                  >
                    新增
                  </el-button>
                </div>
              </div>
            </div>
            <div class="config-tip">后台只需维护中文关键词；新增或删除后点击“保存配置”生效。客户用其他语言表达同类转人工意图时，系统会通过中文译文和多语言语义匹配自动转人工</div>
          </div>
        </el-form-item>

        <el-form-item class="form-actions">
          <el-button type="primary" @click="saveCardConfig('routing')" :loading="cardSaving === 'routing'">保存配置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 超时与流转配置 -->
    <el-card style="margin-top: 20px;">
      <template #header><span>超时与流转配置</span></template>
      <el-form class="settings-form-grid" label-width="160px" v-loading="poolLoading">
        <el-form-item label="AI自助池无回复超时">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch
                v-model="poolConfig.ai_no_reply_timeout_enabled"
                active-text="开启"
                inactive-text="关闭"
                inline-prompt
                :loading="isSavingKey('ai_no_reply_timeout_enabled')"
                @change="saveConfigKey('ai_no_reply_timeout_enabled')"
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #dcdfe6"
              />
            </div>
            <div class="control-row">
              <el-input-number
                v-model="aiNoReplyMinutes"
                :min="1"
                :disabled="!poolConfig.ai_no_reply_timeout_enabled"
              />
              <span class="config-unit">分钟</span>
            </div>
            <div class="config-tip">开启后，AI 回复后客户超过此时间未回复，会话转入公共池暂存（默认30分钟）</div>
          </div>
        </el-form-item>

        <el-form-item label="待人工池超龄转公共池">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch
                v-model="poolConfig.pending_human_aging_timeout_enabled"
                active-text="开启"
                inactive-text="关闭"
                inline-prompt
                :loading="isSavingKey('pending_human_aging_timeout_enabled')"
                @change="saveConfigKey('pending_human_aging_timeout_enabled')"
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #dcdfe6"
              />
            </div>
            <div class="control-row">
              <el-input-number
                v-model="pendingHumanHours"
                :min="1"
                :disabled="!poolConfig.pending_human_aging_timeout_enabled"
              />
              <span class="config-unit">小时</span>
            </div>
            <div class="config-tip">开启后，待人工池中超过此时间无人抢单，会降级到公共池（默认1小时）</div>
          </div>
        </el-form-item>

        <el-form-item label="公共池超龄归档">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="publicPoolHours"
                :min="6"
              />
              <span class="config-unit">小时</span>
            </div>
            <div class="config-tip">公共池中超过此时间无人认领，自动归档（默认24小时）</div>
          </div>
        </el-form-item>

        <el-form-item label="长期跟进提醒间隔">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.long_term_reminder_hours"
                :min="1"
              />
              <span class="config-unit">小时</span>
            </div>
            <div class="config-tip">长期跟进池会话超期未跟进的提醒间隔（默认48小时）</div>
          </div>
        </el-form-item>

        <el-form-item label="坐席离线自动释放">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch
                v-model="poolConfig.seat_offline_release"
                active-text="开启"
                inactive-text="关闭"
                inline-prompt
                :loading="isSavingKey('seat_offline_release')"
                @change="saveConfigKey('seat_offline_release')"
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #dcdfe6"
              />
            </div>
            <div class="config-tip">坐席离线时自动将其私有池会话释放回公共池</div>
          </div>
        </el-form-item>

        <el-form-item label="工作时间开始">
          <div class="form-item-content">
            <div class="control-row">
              <el-input
                v-model="poolConfig.business_hours_start"
                style="width: 140px"
                placeholder="09:00"
              />
              <span class="config-unit">中国时间</span>
            </div>
            <div class="config-tip">AI 自助池判断需转人工时，会按这个工作时间段判断是否先给客户发送“非工作时间段，等工作时间再详聊”的提示。格式 HH:mm，例如 09:00</div>
          </div>
        </el-form-item>

        <el-form-item label="工作时间结束">
          <div class="form-item-content">
            <div class="control-row">
              <el-input
                v-model="poolConfig.business_hours_end"
                style="width: 140px"
                placeholder="18:00"
              />
              <span class="config-unit">中国时间</span>
            </div>
            <div class="config-tip">支持跨天时间段；当开始和结束相同，视为全天都在工作时间内。格式 HH:mm，例如 18:00</div>
          </div>
        </el-form-item>

        <el-form-item class="full-row" label="非工作时间提示语">
          <div class="form-item-content">
            <div class="control-row" style="align-items: flex-start;">
              <el-input
                v-model="poolConfig.after_hours_transfer_notice"
                type="textarea"
                :rows="3"
                style="width: 100%"
                placeholder="现在是非工作时间段，我手头没有资料，等工作时间再跟您详聊。"
              />
            </div>
            <div class="config-tip">AI 自助池在非工作时间转待人工时，会先向客户发送这段话；系统会根据客户最近一条消息的语言自动翻译后发送。</div>
          </div>
        </el-form-item>

        <el-form-item label="客户等待AI超时">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="aiSelfStaleMinutes"
                :min="5"
              />
              <span class="config-unit">分钟</span>
            </div>
            <div class="config-tip">AI自助池中客户发言后超过此时间仍未收到 AI 回复，会话自动转入待人工池（默认30分钟）</div>
          </div>
        </el-form-item>

        <el-form-item label="私有池消息停滞超时">
          <div class="form-item-content">
            <div class="control-row">
              <el-switch
                v-model="poolConfig.private_pool_stale_timeout_enabled"
                active-text="开启"
                inactive-text="关闭"
                inline-prompt
                :loading="isSavingKey('private_pool_stale_timeout_enabled')"
                @change="saveConfigKey('private_pool_stale_timeout_enabled')"
                style="--el-switch-on-color: #13ce66; --el-switch-off-color: #dcdfe6"
              />
            </div>
            <div class="control-row">
              <el-input-number
                v-model="privateStaleMinutes"
                :min="10"
                :disabled="!poolConfig.private_pool_stale_timeout_enabled"
              />
              <span class="config-unit">分钟</span>
            </div>
            <div class="config-tip">开启后，私有池中最后一条消息超过此时间无活动，会话自动释放回公共池（默认60分钟）</div>
          </div>
        </el-form-item>

        <el-form-item class="form-actions">
          <el-button type="primary" @click="saveCardConfig('timeout')" :loading="cardSaving === 'timeout'">保存配置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- AI 回复队列配置 -->
    <el-card style="margin-top: 20px;">
      <template #header>
        <div class="card-header">
          <span>AI 回复队列配置</span>
          <el-button type="primary" size="small" @click="loadQueueStats" :loading="queueLoading">刷新监控</el-button>
        </div>
      </template>
      <el-form class="settings-form-grid" label-width="160px" v-loading="poolLoading">
        <el-form-item label="队列并发数">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.ai_queue_concurrency"
                :min="1"
                :max="20"
              />
              <span class="config-unit">个</span>
            </div>
            <div class="config-tip">同时处理的 AI 回复任务数（1-20，默认5）。修改后需重启服务生效</div>
          </div>
        </el-form-item>

        <el-form-item label="重试次数">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.ai_retry_limit"
                :min="1"
                :max="5"
              />
              <span class="config-unit">次</span>
            </div>
            <div class="config-tip">AI 回复失败后自动重试次数，超过后自动转人工（1-5次，默认3次）</div>
          </div>
        </el-form-item>

        <el-form-item label="调用超时">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="aiTimeoutSeconds"
                :min="10"
                :max="60"
              />
              <span class="config-unit">秒</span>
            </div>
            <div class="config-tip">单次 AI 调用超时时间（10-60秒，默认30秒）</div>
          </div>
        </el-form-item>

        <el-divider class="full-row" content-position="left" style="margin: 12px 0;">连续消息与串行锁</el-divider>

        <el-form-item label="防抖延迟">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.ai_reply_debounce_ms"
                :min="0"
                :max="10000"
                :step="500"
              />
              <span class="config-unit">毫秒</span>
            </div>
            <div class="config-tip">客户连发多条消息时，给后续消息留出到达时间，只让最新一条触发 AI 回复（0=立即，默认1500ms）</div>
          </div>
        </el-form-item>

        <el-form-item label="合并窗口">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.ai_merge_window_seconds"
                :min="10"
                :max="600"
              />
              <span class="config-unit">秒</span>
            </div>
            <div class="config-tip">在此时间窗口内的连续客户消息会被合并后统一回复（默认120秒）</div>
          </div>
        </el-form-item>

        <el-form-item label="最大合并条数">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.ai_merge_max_messages"
                :min="1"
                :max="20"
              />
              <span class="config-unit">条</span>
            </div>
            <div class="config-tip">最多合并多少条连续客户消息一起回复（默认5条）</div>
          </div>
        </el-form-item>

        <el-form-item label="串行锁TTL">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.ai_reply_lock_ttl_ms"
                :min="10000"
                :max="600000"
                :step="10000"
              />
              <span class="config-unit">毫秒</span>
            </div>
            <div class="config-tip">同一会话 AI 回复串行锁的有效期（默认120000ms=2分钟）</div>
          </div>
        </el-form-item>

        <el-form-item label="锁等待超时">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.ai_reply_lock_wait_ms"
                :min="1000"
                :max="60000"
                :step="1000"
              />
              <span class="config-unit">毫秒</span>
            </div>
            <div class="config-tip">等待获取串行锁的超时时间，超时后任务进入队列重试（默认12000ms=12秒）</div>
          </div>
        </el-form-item>

        <el-form-item class="form-actions">
          <el-button type="primary" @click="saveCardConfig('queue')" :loading="cardSaving === 'queue'">保存配置</el-button>
        </el-form-item>
      </el-form>

      <!-- 队列监控指标 -->
      <div v-if="queueStats" class="queue-stats">
        <el-divider content-position="left">实时队列监控</el-divider>
        <div class="queue-stats__grid">
          <div class="queue-stat-item">
            <div class="queue-stat-item__value">{{ queueStats.waiting }}</div>
            <div class="queue-stat-item__label">等待中</div>
          </div>
          <div class="queue-stat-item">
            <div class="queue-stat-item__value">{{ queueStats.active }}</div>
            <div class="queue-stat-item__label">处理中</div>
          </div>
          <div class="queue-stat-item">
            <div class="queue-stat-item__value queue-stat-item__value--success">{{ queueStats.completed }}</div>
            <div class="queue-stat-item__label">已完成</div>
          </div>
          <div class="queue-stat-item">
            <div class="queue-stat-item__value" :class="{ 'queue-stat-item__value--danger': queueStats.failed > 0 }">{{ queueStats.failed }}</div>
            <div class="queue-stat-item__label">失败</div>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 坐席负载配置 -->
    <el-card style="margin-top: 20px;">
      <template #header><span>坐席负载配置</span></template>
      <el-form class="settings-form-grid" label-width="160px" v-loading="poolLoading">
        <el-form-item label="最大并发会话数">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.seat_max_concurrent"
                :min="0"
                :max="10"
              />
              <span class="config-unit">个</span>
            </div>
            <div class="config-tip">坐席同时接待的最大会话数（1-10，默认5）。设为0则使用每个客服自己的最大接待数</div>
          </div>
        </el-form-item>

        <el-form-item class="form-actions">
          <el-button type="primary" @click="saveCardConfig('seat')" :loading="cardSaving === 'seat'">保存配置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- LLM 大模型配置 -->
    <el-card style="margin-top: 20px;">
      <template #header>
        <div class="card-header">
          <span>LLM 大模型配置</span>
        </div>
      </template>
      <el-form class="settings-form-grid" label-width="180px" v-loading="poolLoading">
        <el-form-item label="AI 自助回复模型">
          <div class="form-item-content">
            <div class="control-row">
              <el-select
                v-model="poolConfig.ai_self_reply_model"
                style="width: 240px;"
              >
                <el-option label="deepseek-v4-flash（推荐）" value="deepseek-v4-flash" />
                <el-option label="qwen3.7-plus" value="qwen3.7-plus" />
                <el-option label="qwen3.6-flash" value="qwen3.6-flash" />
                <el-option label="deepseek-v4-pro" value="deepseek-v4-pro" />
              </el-select>
            </div>
            <div class="config-tip">AI 自助池自动回复客户时使用的模型，默认 deepseek-v4-flash（兼顾速度、成本与推理能力）</div>
          </div>
        </el-form-item>

        <el-form-item label="AI 推荐默认模型">
          <div class="form-item-content">
            <div class="control-row">
              <el-select
                v-model="poolConfig.ai_suggest_model"
                style="width: 240px;"
              >
                <el-option label="deepseek-v4-flash（推荐）" value="deepseek-v4-flash" />
                <el-option label="qwen3.7-plus" value="qwen3.7-plus" />
                <el-option label="qwen3.6-flash" value="qwen3.6-flash" />
                <el-option label="deepseek-v4-pro" value="deepseek-v4-pro" />
              </el-select>
            </div>
            <div class="config-tip">客服工作台点击「AI 推荐」时默认使用的模型，坐席仍可在下拉菜单中切换其他模型</div>
          </div>
        </el-form-item>

        <el-form-item label="翻译模型">
          <div class="form-item-content">
            <div class="control-row">
              <el-select
                v-model="poolConfig.llm_translate_model"
                style="width: 240px;"
              >
                <el-option label="deepseek-v4-flash（推荐）" value="deepseek-v4-flash" />
                <el-option label="qwen3.7-plus" value="qwen3.7-plus" />
                <el-option label="qwen3.6-flash" value="qwen3.6-flash" />
                <el-option label="deepseek-v4-pro" value="deepseek-v4-pro" />
              </el-select>
            </div>
            <div class="config-tip">客户消息非中文时翻译所用的模型，默认 deepseek-v4-flash（成本极低）</div>
          </div>
        </el-form-item>

        <el-form-item label="翻译上下文条数">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.translation_context_message_count"
                :min="0"
                :max="10"
                :step="1"
                style="width: 200px;"
              />
              <span class="config-unit">条</span>
            </div>
            <div class="config-tip">翻译时附带最近 N 条消息作为上下文，帮助模型理解代词、省略等语境。0=关闭上下文翻译（仅翻译单条消息），建议 3-5</div>
          </div>
        </el-form-item>

        <el-form-item label="RAG 检索上下文条数">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.rag_context_message_count"
                :min="0"
                :max="10"
                :step="1"
                style="width: 200px;"
              />
              <span class="config-unit">条</span>
            </div>
            <div class="config-tip">控制知识库检索时是否拼接最近客户消息。0=智能检测（仅短消息/代词消息自动拼接最近3条），大于0=每次检索固定拼接最近 N 条客户消息</div>
          </div>
        </el-form-item>

        <el-form-item label="LLM 上下文条数">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.llm_context_message_count"
                :min="0"
                :max="50"
                :step="1"
                style="width: 200px;"
              />
              <span class="config-unit">条</span>
            </div>
            <div class="config-tip">控制 AI 推荐/AI 自助回复传给大模型的会话历史条数。0=不带历史上下文，默认20；值越大上下文越完整但消耗更多 token</div>
          </div>
        </el-form-item>

        <el-form-item class="full-row" label="AI 推荐可用模型">
          <div class="form-item-content">
            <div class="control-row">
              <el-select
                v-model="poolConfig.llm_suggest_models"
                multiple
                style="width: 480px;"
                placeholder="选择客服工作台可选的 AI 推荐模型"
              >
                <el-option label="deepseek-v4-flash" value="deepseek-v4-flash" />
                <el-option label="qwen3.7-plus" value="qwen3.7-plus" />
                <el-option label="qwen3.6-flash" value="qwen3.6-flash" />
                <el-option label="deepseek-v4-pro" value="deepseek-v4-pro" />
              </el-select>
            </div>
            <div class="config-tip">控制客服工作台「AI 推荐」按钮旁显示的模型选项，可多选。选中的模型会出现在坐席选择器中</div>
          </div>
        </el-form-item>

        <el-form-item label="AI 推荐并发限制">
          <div class="form-item-content">
            <div class="control-row">
              <el-input-number
                v-model="poolConfig.ai_suggest_concurrency"
                :min="1"
                :max="20"
                :step="1"
                style="width: 200px;"
              />
            </div>
            <div class="config-tip">控制同时进行的 AI 推荐 LLM 调用数。值越小越保守（防止 API 限流），值越大吞吐越高。建议 3-5</div>
          </div>
        </el-form-item>

        <el-form-item class="full-row" label="AI 推荐系统提示词">
          <div class="form-item-content">
            <div class="control-row" style="flex-direction: column; align-items: flex-start; width: 100%;">
              <el-input
                v-model="poolConfig.ai_suggest_system_prompt"
                type="textarea"
                :rows="20"
                style="width: 100%; font-family: monospace;"
                placeholder="输入 AI 推荐回答的系统提示词..."
              />
            </div>
            <div class="config-tip">提示词完整内容在 <code>rag-server/prompts/ai_suggest_system_prompt.md</code> 文件中维护，修改文件后重启服务生效。此处可覆盖文件默认值（留空则使用文件内容）。修改后实时生效</div>
          </div>
        </el-form-item>

        <el-form-item class="form-actions">
          <el-button type="primary" @click="saveCardConfig('llm')" :loading="cardSaving === 'llm'">保存配置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { Delete, Plus } from '@element-plus/icons-vue'
import { adminApi } from '@/api/admin'

// ========== 会话池配置 ==========
const poolLoading = ref(false)
const cardSaving = ref(null)  // 当前正在保存的卡片名称，null 表示无
const savingConfigKeys = reactive({})
const poolConfigLoaded = ref(false)
const newTransferKeyword = ref('')
const poolConfig = reactive({
  ai_self_pool_enabled: true,
  ai_transfer_keywords: [],
  ai_max_rounds: 0,
  ai_no_reply_timeout_enabled: true,
  ai_no_reply_timeout: 1800,
  ai_confidence_threshold: 0.7,
  ai_confidence_cautious_min: 0.4,
  complexity_check_enabled: true,
  sentiment_check_enabled: true,
  pending_human_aging_timeout_enabled: true,
  pending_human_aging_timeout: 3600,
  public_pool_archive_timeout: 86400,
  seat_offline_release: true,
  long_term_reminder_hours: 48,
  ai_self_stale_timeout: 1800,
  private_pool_stale_timeout_enabled: true,
  private_pool_stale_timeout: 3600,
  business_hours_start: '09:00',
  business_hours_end: '18:00',
  after_hours_transfer_notice: '现在是非工作时间段，我手头没有资料，等工作时间再跟您详聊。',
  // 新增队列配置
  ai_queue_concurrency: 5,
  ai_retry_limit: 3,
  ai_timeout_ms: 30000,
  seat_max_concurrent: 5,
  // LLM 配置
  ai_self_reply_model: 'deepseek-v4-flash',
  ai_suggest_model: 'deepseek-v4-flash',
  llm_translate_model: 'deepseek-v4-flash',
  translation_context_message_count: 3,
  rag_context_message_count: 0,
  llm_context_message_count: 20,
  llm_suggest_models: ['deepseek-v4-flash', 'qwen3.7-plus', 'qwen3.6-flash', 'deepseek-v4-pro'],
  ai_suggest_system_prompt: '',
  ai_suggest_concurrency: 3,
  // 连续消息与串行锁配置
  ai_reply_debounce_ms: 1500,
  ai_merge_window_seconds: 120,
  ai_merge_max_messages: 5,
  ai_reply_lock_ttl_ms: 120000,
  ai_reply_lock_wait_ms: 12000,
  // 语言兜底检查
  language_guard_enabled: true
})

// 派生 computed（后端存秒/小数，前端展示分钟/小时/百分比）
const confidencePercent = computed({
  get: () => Math.round(((poolConfig.ai_confidence_threshold ?? 0.7)) * 100),
  set: (val) => { poolConfig.ai_confidence_threshold = val / 100 }
})
const cautiousMinPercent = computed({
  get: () => Math.round(((poolConfig.ai_confidence_cautious_min ?? 0.4)) * 100),
  set: (val) => { poolConfig.ai_confidence_cautious_min = val / 100 }
})
const aiNoReplyMinutes = computed({
  get: () => Math.round((poolConfig.ai_no_reply_timeout || 1800) / 60),
  set: (val) => { poolConfig.ai_no_reply_timeout = val * 60 }
})
const pendingHumanHours = computed({
  get: () => Math.round((poolConfig.pending_human_aging_timeout || 3600) / 3600),
  set: (val) => { poolConfig.pending_human_aging_timeout = val * 3600 }
})
const publicPoolHours = computed({
  get: () => Math.round((poolConfig.public_pool_archive_timeout || 86400) / 3600),
  set: (val) => { poolConfig.public_pool_archive_timeout = val * 3600 }
})
const aiTimeoutSeconds = computed({
  get: () => Math.round((poolConfig.ai_timeout_ms || 30000) / 1000),
  set: (val) => { poolConfig.ai_timeout_ms = val * 1000 }
})
const aiSelfStaleMinutes = computed({
  get: () => Math.round((poolConfig.ai_self_stale_timeout || 1800) / 60),
  set: (val) => { poolConfig.ai_self_stale_timeout = val * 60 }
})
const privateStaleMinutes = computed({
  get: () => Math.round((poolConfig.private_pool_stale_timeout || 3600) / 60),
  set: (val) => { poolConfig.private_pool_stale_timeout = val * 60 }
})

const cleanupTransferKeyword = (keyword) => String(keyword || '').trim()

const normalizeKeywordList = (keywords) => {
  const seen = new Set()
  return (Array.isArray(keywords) ? keywords : [])
    .map(cleanupTransferKeyword)
    .filter(Boolean)
    .filter(keyword => {
      const key = keyword.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

const normalizeTransferKeywords = () => {
  poolConfig.ai_transfer_keywords = normalizeKeywordList(poolConfig.ai_transfer_keywords)
}

const addTransferKeyword = () => {
  const keyword = cleanupTransferKeyword(newTransferKeyword.value)
  if (!keyword) {
    ElMessage.warning('请输入关键词')
    return
  }

  const currentKeywords = normalizeKeywordList(poolConfig.ai_transfer_keywords)
  const exists = currentKeywords.some(item => item.toLowerCase() === keyword.toLowerCase())
  if (exists) {
    ElMessage.warning('关键词已存在')
    return
  }

  poolConfig.ai_transfer_keywords = [...currentKeywords, keyword]
  newTransferKeyword.value = ''
}

const removeTransferKeyword = (keyword) => {
  const target = cleanupTransferKeyword(keyword).toLowerCase()
  poolConfig.ai_transfer_keywords = normalizeKeywordList(poolConfig.ai_transfer_keywords)
    .filter(item => item.toLowerCase() !== target)
}

const loadPoolConfig = async () => {
  poolLoading.value = true
  try {
    const res = await adminApi.getPoolConfig()
    const data = res.data?.data || res.data
    if (data) {
      Object.keys(poolConfig).forEach(key => {
        if (data[key]?.value !== undefined) {
          poolConfig[key] = data[key].value
        } else if (data[key] !== undefined) {
          poolConfig[key] = data[key]
        }
      })
      poolConfigLoaded.value = true
    }
  } catch (err) {
    console.error('[Settings] 加载会话池配置失败:', err)
    ElMessage.warning('会话池配置加载失败，使用默认值')
  } finally {
    poolLoading.value = false
  }
}

// 各卡片包含的配置键映射
const cardKeysMap = {
  routing: ['ai_self_pool_enabled', 'ai_max_rounds', 'ai_confidence_threshold', 'ai_confidence_cautious_min', 'sentiment_check_enabled', 'complexity_check_enabled', 'language_guard_enabled', 'ai_transfer_keywords'],
  timeout: ['ai_no_reply_timeout_enabled', 'ai_no_reply_timeout', 'pending_human_aging_timeout_enabled', 'pending_human_aging_timeout', 'public_pool_archive_timeout', 'long_term_reminder_hours', 'seat_offline_release', 'ai_self_stale_timeout', 'private_pool_stale_timeout_enabled', 'private_pool_stale_timeout', 'business_hours_start', 'business_hours_end', 'after_hours_transfer_notice'],
  queue: ['ai_queue_concurrency', 'ai_retry_limit', 'ai_timeout_ms', 'ai_reply_debounce_ms', 'ai_merge_window_seconds', 'ai_merge_max_messages', 'ai_reply_lock_ttl_ms', 'ai_reply_lock_wait_ms'],
  seat: ['seat_max_concurrent'],
  llm: ['ai_self_reply_model', 'ai_suggest_model', 'llm_translate_model', 'translation_context_message_count', 'rag_context_message_count', 'llm_context_message_count', 'llm_suggest_models', 'ai_suggest_concurrency', 'ai_suggest_system_prompt']
}

const saveCardConfig = async (cardName) => {
  const keys = cardKeysMap[cardName]
  if (!keys || keys.length === 0) return

  cardSaving.value = cardName
  try {
    // 批量保存所有配置项
    const promises = keys.map(key => adminApi.updatePoolConfig(key, poolConfig[key]))
    await Promise.all(promises)
    ElMessage.success('配置已保存')
  } catch (err) {
    console.error('[Settings] 保存配置失败:', err)
    ElMessage.error('配置保存失败: ' + (err.response?.data?.message || err.message))
    // 保存失败时重新加载配置
    await loadPoolConfig()
  } finally {
    cardSaving.value = null
  }
}

const isSavingKey = (key) => Boolean(savingConfigKeys[key])

const saveConfigKey = async (key) => {
  if (!key || poolLoading.value) return

  savingConfigKeys[key] = true
  try {
    await adminApi.updatePoolConfig(key, poolConfig[key])
    ElMessage.success('配置已保存')
  } catch (err) {
    console.error('[Settings] 保存配置失败:', err)
    ElMessage.error('配置保存失败: ' + (err.response?.data?.message || err.message))
    await loadPoolConfig()
  } finally {
    delete savingConfigKeys[key]
  }
}

// ========== 队列监控 ==========
const queueLoading = ref(false)
const queueStats = ref(null)

const loadQueueStats = async () => {
  queueLoading.value = true
  try {
    const res = await adminApi.getQueueStats()
    queueStats.value = res.data?.data || res.data
  } catch (err) {
    ElMessage.error('队列状态获取失败: ' + (err.response?.data?.message || err.message))
  } finally {
    queueLoading.value = false
  }
}

onMounted(() => {
  loadPoolConfig()
  loadQueueStats()
})
</script>

<style scoped lang="scss">
.settings {
  .el-slider {
    width: 300px;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .settings-form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    column-gap: 24px;
    align-items: start;

    :deep(.el-form-item) {
      min-width: 0;
    }

    :deep(.full-row),
    :deep(.form-actions),
    :deep(.el-divider) {
      grid-column: 1 / -1;
    }

    :deep(.form-actions .el-form-item__content) {
      justify-content: flex-start;
    }
  }

  .form-item-content {
    width: 100%;

    .control-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .keyword-editor {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      min-width: 0;
    }

    .keyword-add-row {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto;
      gap: 8px;
      width: 100%;
    }

    .keyword-option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
    }

    .keyword-option__label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .config-unit {
      font-size: 13px;
      color: #909399;
    }

    .config-tip {
      font-size: 12px;
      color: #909399;
      line-height: 1.5;
      margin-top: 4px;
    }
  }

  .queue-stats {
    &__grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-top: 16px;
    }
  }

  .queue-stat-item {
    text-align: center;
    padding: 16px;
    background: #f5f7fa;
    border-radius: 8px;

    &__value {
      font-size: 28px;
      font-weight: 700;
      color: #303133;

      &--success { color: #67c23a; }
      &--danger { color: #f56c6c; }
    }

    &__label {
      font-size: 12px;
      color: #909399;
      margin-top: 4px;
    }
  }
}
</style>
