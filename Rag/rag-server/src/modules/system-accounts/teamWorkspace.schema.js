async function ensureTeamWorkspaceSchema(sequelize) {
  await sequelize.query('CREATE TABLE IF NOT EXISTS workspace_dispatch_lock (id INT PRIMARY KEY)')
  await sequelize.query('INSERT IGNORE INTO workspace_dispatch_lock (id) VALUES (1)')
  // Preserve the previous role before the one-time conversion.
  await sequelize.query(`CREATE TABLE IF NOT EXISTS workspace_role_migrations (
    user_id INT PRIMARY KEY, previous_role VARCHAR(20) NOT NULL,
    migrated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
  await sequelize.query(`INSERT IGNORE INTO workspace_role_migrations (user_id, previous_role)
    SELECT id, role FROM users WHERE role IN ('supervisor', 'user')`)
  await sequelize.query("UPDATE users SET role = 'admin' WHERE role = 'supervisor'")
  await sequelize.query("UPDATE users SET role = 'agent' WHERE role = 'user'")
  await sequelize.query("ALTER TABLE users MODIFY COLUMN role ENUM('agent','admin') DEFAULT 'agent'")
  await sequelize.query(`CREATE TABLE IF NOT EXISTS quick_reply_personal (
    id VARCHAR(36) PRIMARY KEY, user_id INT NOT NULL, payload JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_personal_user (user_id))`)
  await sequelize.query(`CREATE TABLE IF NOT EXISTS quick_reply_overrides (
    user_id INT NOT NULL, reply_id VARCHAR(36) NOT NULL, hidden TINYINT(1) NOT NULL DEFAULT 0,
    payload JSON NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, reply_id))`)
}

async function ensureSeatPresenceSchema(sequelize) {
  const [columns] = await sequelize.query("SHOW COLUMNS FROM seat_status LIKE 'manual_offline'")
  if (!columns.length) await sequelize.query('ALTER TABLE seat_status ADD COLUMN manual_offline TINYINT(1) NOT NULL DEFAULT 0')
}

module.exports = { ensureTeamWorkspaceSchema, ensureSeatPresenceSchema }
