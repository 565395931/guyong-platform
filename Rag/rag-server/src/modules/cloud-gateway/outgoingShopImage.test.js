const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path')
const {loadShopImage}=require('./outgoingShopImage')
test('媒体库图片校验拒绝路径逃逸、伪装文件和超限',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'shop-image-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}))
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);await fs.writeFile(path.join(dir,'fixture.png'),png)
 const id='12345678-1234-1234-1234-123456789012'
 const row={filename:'fixture.png',size:png.length,media_type:'image'};const query=async()=>[[row]]
 assert.equal((await loadShopImage(id,{query,directory:dir})).mimeType,'image/png')
 await assert.rejects(loadShopImage('http://localhost',{query,directory:dir}),/上传图片/)
 row.filename='../fixture.png';await assert.rejects(loadShopImage(id,{query,directory:dir}),/图片不存在/)
 row.filename='fixture.png';row.size=6*1024*1024;await assert.rejects(loadShopImage(id,{query,directory:dir}),/5MB/)
 row.size=16;await fs.writeFile(path.join(dir,'fixture.png'),Buffer.alloc(20));await assert.rejects(loadShopImage(id,{query,directory:dir}),/PNG 或 JPG/)
})
