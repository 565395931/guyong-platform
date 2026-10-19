const fs = require('node:fs/promises')
const path = require('node:path')
const MEDIA_DIR = path.resolve(__dirname, '../../public/media-files')
async function loadShopImage(id, { query = null, directory = MEDIA_DIR } = {}) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Error('请先上传图片，再发送')
  const run = query || require('../../config/database').sequelize.query.bind(require('../../config/database').sequelize)
  const [rows] = await run('SELECT filename, size, media_type FROM media_files WHERE id = :id LIMIT 1', { replacements: { id } })
  const row = rows[0]
  if (!row || row.media_type !== 'image' || !row.filename || path.basename(row.filename) !== row.filename) throw Error('图片不存在或类型不正确，请重新上传')
  if (Number(row.size) > 5 * 1024 * 1024) throw Error('图片超过 5MB，请压缩后发送')
  const root = await fs.realpath(directory)
  const file = await fs.realpath(path.join(root, row.filename))
  if (path.dirname(file) !== root) throw Error('图片路径无效')
  const stat = await fs.stat(file)
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024 || stat.size < 16) throw Error('图片大小无效')
  const buffer = await fs.readFile(file)
  const mimeType = buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? 'image/jpeg' : ''
  if (!mimeType) throw Error('微信小店请选择 PNG 或 JPG 图片')
  return { buffer, mimeType }
}
module.exports = { loadShopImage }
