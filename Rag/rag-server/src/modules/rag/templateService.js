require('dotenv').config();
const { sequelize } = require('../../config/database');

// ========== 默认模板配置 ==========
const defaultTemplateConfig = {
  splitStrategy: 'heading_driven',
  maxHeadingLevel: 3,
  keepTableWhole: true,
  keepListWhole: true,
  maxChunkSize: 800,
  chunkOverlap: 120,
  injectHeadingPath: true,
  maxListLength: 10
};

/**
 * 创建模板表
 */
async function createTemplatesTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL COMMENT '模板名称',
      template_id VARCHAR(50) NOT NULL UNIQUE COMMENT '模板唯一标识',
      config JSON NOT NULL COMMENT '模板配置JSON',
      description VARCHAR(500) COMMENT '模板描述',
      is_default TINYINT(1) DEFAULT 0 COMMENT '是否为默认模板',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_template_id (template_id),
      INDEX idx_is_default (is_default)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  
  console.log('templates 表创建成功');
  
  // 检查是否存在默认模板，不存在则插入
  const existing = await sequelize.query(
    'SELECT id FROM templates WHERE template_id = ?',
    {
      replacements: ['default'],
      type: sequelize.QueryTypes.SELECT
    }
  );
  
  if (!existing || existing.length === 0) {
    await sequelize.query(
      `INSERT INTO templates (name, template_id, config, description, is_default)
       VALUES ('默认模板', 'default', ?, '系统默认分块模板', 1)`,
      {
        replacements: [JSON.stringify(defaultTemplateConfig)],
        type: sequelize.QueryTypes.INSERT
      }
    );
    console.log('默认模板初始化完成');
  }
}

/**
 * 获取模板列表
 * @param {Object} options - 查询选项
 * @returns {Array} 模板列表
 */
async function listTemplates(options = {}) {
  const { pageSize = 50, pageNumber = 1 } = options;
  
  try {
    const templates = await sequelize.query(
      `SELECT id, name, template_id, config, description, is_default, created_at, updated_at 
       FROM templates 
       ORDER BY is_default DESC, created_at DESC 
       LIMIT ? OFFSET ?`,
      {
        replacements: [pageSize, (pageNumber - 1) * pageSize],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    // 如果表不存在或查询失败，返回默认模板
    if (!templates || templates.length === 0) {
      // 先尝试创建表
      try {
        await createTemplatesTable();
        // 重新查询
        const newTemplates = await sequelize.query(
          `SELECT id, name, template_id, config, description, is_default, created_at, updated_at 
           FROM templates 
           ORDER BY is_default DESC, created_at DESC 
           LIMIT ? OFFSET ?`,
          {
            replacements: [pageSize, (pageNumber - 1) * pageSize],
            type: sequelize.QueryTypes.SELECT
          }
        );
        return formatTemplates(newTemplates);
      } catch (createError) {
        console.error('创建模板表失败:', createError.message);
        // 返回内置默认模板
        return [{
          id: null,
          name: '默认模板',
          templateId: 'default',
          config: defaultTemplateConfig,
          description: '系统默认分块模板',
          isDefault: true,
          createTime: null,
          updateTime: null
        }];
      }
    }
    
    return formatTemplates(templates);
  } catch (error) {
    console.error('查询模板列表失败:', error.message);
    // 如果是表不存在错误，尝试创建表
    if (error.message.includes('doesn\'t exist')) {
      try {
        await createTemplatesTable();
        return listTemplates(options);
      } catch (createError) {
        console.error('创建模板表失败:', createError.message);
      }
    }
    // 返回内置默认模板
    return [{
      id: null,
      name: '默认模板',
      templateId: 'default',
      config: defaultTemplateConfig,
      description: '系统默认分块模板',
      isDefault: true,
      createTime: null,
      updateTime: null
    }];
  }
}

/**
 * 格式化模板数据
 */
function formatTemplates(templates) {
  return templates.map(t => ({
    id: t.id,
    name: t.name,
    templateId: t.template_id,
    config: t.config ? (typeof t.config === 'string' ? JSON.parse(t.config) : t.config) : defaultTemplateConfig,
    description: t.description,
    isDefault: t.is_default === 1,
    createTime: t.created_at,
    updateTime: t.updated_at
  }));
}

/**
 * 获取单个模板详情
 * @param {string} templateId - 模板ID
 * @returns {Object} 模板详情
 */
async function getTemplate(templateId) {
  try {
    const templates = await sequelize.query(
      `SELECT id, name, template_id, config, description, is_default, created_at, updated_at 
       FROM templates 
       WHERE template_id = ?`,
      {
        replacements: [templateId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    if (!templates || templates.length === 0) {
      // 如果请求的是 default 且不存在，返回默认配置
      if (templateId === 'default') {
        return {
          id: null,
          name: '默认模板',
          templateId: 'default',
          config: defaultTemplateConfig,
          description: '系统默认分块模板',
          isDefault: true,
          createTime: null,
          updateTime: null
        };
      }
      throw new Error(`模板不存在: ${templateId}`);
    }
    
    return formatTemplates(templates)[0];
  } catch (error) {
    // 如果表不存在，返回默认模板
    if (templateId === 'default' && error.message.includes('doesn\'t exist')) {
      return {
        id: null,
        name: '默认模板',
        templateId: 'default',
        config: defaultTemplateConfig,
        description: '系统默认分块模板',
        isDefault: true,
        createTime: null,
        updateTime: null
      };
    }
    throw error;
  }
}

/**
 * 新增模板
 * @param {Object} templateData - 模板数据
 * @returns {Object} 新增结果
 */
async function createTemplate(templateData) {
  const { name, templateId, config, description } = templateData;
  
  // 校验必填字段
  if (!name || !templateId) {
    throw new Error('模板名称和模板ID为必填项');
  }
  
  // 校验模板ID格式（只允许字母、数字、下划线）
  if (!/^[a-zA-Z0-9_]+$/.test(templateId)) {
    throw new Error('模板ID只允许字母、数字、下划线');
  }
  
  // 先确保表存在
  try {
    await createTemplatesTable();
  } catch (e) {}
  
  // 校验模板ID是否已存在
  const existing = await sequelize.query(
    'SELECT id FROM templates WHERE template_id = ?',
    {
      replacements: [templateId],
      type: sequelize.QueryTypes.SELECT
    }
  );
  
  if (existing && existing.length > 0) {
    throw new Error(`模板ID已存在: ${templateId}`);
  }
  
  // 合并默认配置（用户未指定的字段使用默认值）
  const mergedConfig = {
    ...defaultTemplateConfig,
    ...config
  };
  
  // 校验配置值范围
  validateTemplateConfig(mergedConfig);
  
  const result = await sequelize.query(
    `INSERT INTO templates (name, template_id, config, description, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, NOW(), NOW())`,
    {
      replacements: [name, templateId, JSON.stringify(mergedConfig), description || ''],
      type: sequelize.QueryTypes.INSERT
    }
  );
  
  console.log('模板创建成功，templateId:', templateId);
  
  return {
    id: result,
    name,
    templateId,
    config: mergedConfig,
    description,
    isDefault: false
  };
}

/**
 * 编辑模板
 * @param {string} templateId - 模板ID
 * @param {Object} templateData - 更新数据
 * @returns {Object} 更新结果
 */
async function updateTemplate(templateId, templateData) {
  // 不允许修改默认模板的核心配置
  if (templateId === 'default') {
    throw new Error('默认模板不允许修改，请创建新模板');
  }
  
  const { name, config, description } = templateData;
  
  // 检查模板是否存在
  const existing = await sequelize.query(
    'SELECT id, config FROM templates WHERE template_id = ?',
    {
      replacements: [templateId],
      type: sequelize.QueryTypes.SELECT
    }
  );
  
  if (!existing || existing.length === 0) {
    throw new Error(`模板不存在: ${templateId}`);
  }
  
  // 获取现有配置，合并更新
  const existingConfig = existing[0].config ? (typeof existing[0].config === 'string' ? JSON.parse(existing[0].config) : existing[0].config) : defaultTemplateConfig;
  const mergedConfig = config ? { ...existingConfig, ...config } : existingConfig;
  
  // 校验配置值范围
  validateTemplateConfig(mergedConfig);
  
  await sequelize.query(
    `UPDATE templates 
     SET name = ?, config = ?, description = ?, updated_at = NOW() 
     WHERE template_id = ?`,
    {
      replacements: [name, JSON.stringify(mergedConfig), description || '', templateId],
      type: sequelize.QueryTypes.UPDATE
    }
  );
  
  console.log('模板更新成功，templateId:', templateId);
  
  return {
    templateId,
    name,
    config: mergedConfig,
    description
  };
}

/**
 * 删除模板
 * @param {string} templateId - 模板ID
 */
async function deleteTemplate(templateId) {
  // 不允许删除默认模板
  if (templateId === 'default') {
    throw new Error('默认模板不允许删除');
  }
  
  const result = await sequelize.query(
    'DELETE FROM templates WHERE template_id = ? AND is_default = 0',
    {
      replacements: [templateId],
      type: sequelize.QueryTypes.DELETE
    }
  );
  
  console.log('模板删除成功，templateId:', templateId);
  
  return { templateId, deleted: true };
}

/**
 * 设置默认模板
 * @param {string} templateId - 模板ID
 */
async function setDefaultTemplate(templateId) {
  // 先清除所有默认标记
  await sequelize.query(
    'UPDATE templates SET is_default = 0',
    { type: sequelize.QueryTypes.UPDATE }
  );
  
  // 设置指定模板为默认
  await sequelize.query(
    'UPDATE templates SET is_default = 1 WHERE template_id = ?',
    {
      replacements: [templateId],
      type: sequelize.QueryTypes.UPDATE
    }
  );
  
  console.log('默认模板设置成功，templateId:', templateId);
  
  return { templateId, isDefault: true };
}

/**
 * 获取默认模板配置
 * @returns {Object} 默认模板配置
 */
async function getDefaultTemplate() {
  try {
    const templates = await sequelize.query(
      `SELECT template_id, config FROM templates WHERE is_default = 1 LIMIT 1`,
      { type: sequelize.QueryTypes.SELECT }
    );
    
    if (templates && templates.length > 0) {
      const config = templates[0].config;
      return config ? (typeof config === 'string' ? JSON.parse(config) : config) : defaultTemplateConfig;
    }
  } catch (error) {
    console.error('获取默认模板失败:', error.message);
  }
  
  // 如果数据库中没有默认模板或出错，返回系统默认配置
  return defaultTemplateConfig;
}

/**
 * 校验模板配置值范围
 * @param {Object} config - 模板配置
 */
function validateTemplateConfig(config) {
  const errors = [];
  
  if (config.maxHeadingLevel && (config.maxHeadingLevel < 1 || config.maxHeadingLevel > 4)) {
    errors.push('maxHeadingLevel 必须在 1-4 之间');
  }
  
  if (config.maxChunkSize && (config.maxChunkSize < 100 || config.maxChunkSize > 2000)) {
    errors.push('maxChunkSize 必须在 100-2000 之间');
  }
  
  if (config.chunkOverlap && (config.chunkOverlap < 0 || config.chunkOverlap > 500)) {
    errors.push('chunkOverlap 必须在 0-500 之间');
  }
  
  if (config.maxListLength && (config.maxListLength < 1 || config.maxListLength > 50)) {
    errors.push('maxListLength 必须在 1-50 之间');
  }
  
  if (errors.length > 0) {
    throw new Error('模板配置校验失败: ' + errors.join('; '));
  }
}

// ========== 导出模块 ==========
module.exports = {
  defaultTemplateConfig,
  createTemplatesTable,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  setDefaultTemplate,
  getDefaultTemplate,
  validateTemplateConfig
};