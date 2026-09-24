-- 清理 Sequelize 累积的冗余索引
-- 使用方法：在 MySQL 中执行此脚本

-- 1. 删除现有表（如果数据不重要）
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS threads;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS users;

-- 2. 重新启动服务后，Sequelize 会自动创建干净的表结构
-- 或者手动创建表（推荐让 Sequelize 自动创建）

-- 可选：如果不想删除数据，可以手动删除冗余索引
-- 查看当前索引
-- SHOW INDEX FROM threads;
-- SHOW INDEX FROM runs;
-- SHOW INDEX FROM documents;
-- SHOW INDEX FROM users;

-- 手动删除特定索引（示例）
-- ALTER TABLE threads DROP INDEX idx_threads_thread_id;
-- ALTER TABLE runs DROP INDEX idx_runs_run_id;

-- 注意：删除表会丢失所有数据，请确保数据不重要或有备份