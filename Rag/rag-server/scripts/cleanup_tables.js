/**
 * 数据库清理脚本 - 删除所有表并重新创建
 * 用于解决 Sequelize 累积过多索引的问题
 */

require('dotenv').config();
const { Sequelize } = require('sequelize');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || 3306;
const DB_NAME = process.env.DB_NAME || 'rag_customer_service';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '1z2x3c3c';

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST,
  port: DB_PORT,
  dialect: 'mysql',
  logging: true
});

async function cleanupTables() {
  try {
    console.log('连接数据库...');
    await sequelize.authenticate();
    console.log('连接成功');

    console.log('删除现有表...');
    await sequelize.query('DROP TABLE IF EXISTS runs');
    console.log('✓ runs 表已删除');
    
    await sequelize.query('DROP TABLE IF EXISTS threads');
    console.log('✓ threads 表已删除');
    
    await sequelize.query('DROP TABLE IF EXISTS documents');
    console.log('✓ documents 表已删除');
    
    await sequelize.query('DROP TABLE IF EXISTS users');
    console.log('✓ users 表已删除');

    console.log('\n所有表已删除！');
    console.log('现在重新启动服务，Sequelize 会自动创建干净的表结构。');
    
    await sequelize.close();
    process.exit(0);
  } catch (error) {
    console.error('清理失败:', error.message);
    process.exit(1);
  }
}

cleanupTables();