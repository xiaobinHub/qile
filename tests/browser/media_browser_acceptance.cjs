/* Runs inside the isolated full browser suite; never uses real business data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
async function exerciseMedia({dad,origin,firstId,out,stage}) {
  stage('private image preview, failed upload retry, same request ID and cancel preservation');
  await dad.locator('[data-view="store"]').click();
  await dad.locator('[data-store-tab="gifts"]').click();
  const before=await dad.evaluate(async id=>(await fetch(`/api/children/${id}/data`)).json(),firstId);
  const images=before.data.gifts.filter(g=>g.imageAssetId);
  assert.ok(images.length,'Saved image has a file reference');
  for (const gift of images) {
    assert.ok(!Object.hasOwn(gift,'imageData'),'No inline image returned in normal reads');
    assert.match(gift.imageUrl,new RegExp(`^/api/children/${firstId}/assets/`));
  }
  await dad.locator('#giftManageBtn').click();
  await dad.locator('#newGiftBtn').click();
  await dad.locator('#giftName').fill('上传失败后取消');
  await dad.locator('#giftPoints').fill('20');
  const pattern=`**/api/children/${firstId}/assets`;
  const ids=[];
  await dad.route(pattern,async route=>{
    ids.push(route.request().headers()['x-upload-id']);
    if(ids.length===1) await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'隔离测试：图片上传失败，请重试。'})});
    else await route.continue();
  });
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/1ioAAAAASUVORK5CYII=','base64');
  await dad.locator('#giftImageInput').setInputFiles({name:'test.png',mimeType:'image/png',buffer:image});
  await dad.getByRole('button',{name:'重试图片上传'}).waitFor();
  assert.equal(await dad.locator('#saveGiftBtn').isDisabled(),true);
  assert.equal(await dad.locator('#giftName').inputValue(),'上传失败后取消');
  await dad.screenshot({path:path.join(out,'oss-upload-error.png')});
  await dad.getByRole('button',{name:'重试图片上传'}).click();
  await dad.waitForFunction(()=>!document.querySelector('#saveGiftBtn').disabled);
  assert.equal(ids.length,2);
  assert.equal(ids[0],ids[1],'Retry preserves upload id');
  assert.equal(await dad.locator('#giftEditorError').count(),0);
  await dad.screenshot({path:path.join(out,'oss-upload-ready.png')});
  await dad.locator('#giftEditorDialog').getByRole('button',{name:'取消',exact:true}).click();
  await dad.locator('#giftEditorDialog').waitFor({state:'hidden'});
  await dad.locator('#giftManagerDialog').getByRole('button',{name:'关闭',exact:true}).click();
  await dad.locator('#giftManagerDialog').waitFor({state:'hidden'});
  await dad.unroute(pattern);
  const after=await dad.evaluate(async id=>(await fetch(`/api/children/${id}/data`)).json(),firstId);
  assert.equal(after.revision,before.revision,'Cancelled staged upload leaves business revision unchanged');
  assert.deepEqual(after.data.gifts,before.data.gifts);
  await dad.locator('[data-store-tab="ledger"]').click();
  fs.writeFileSync(path.join(out,'oss-media-result.json'),JSON.stringify({passed:true,sameUploadId:true,normalReadsUseFileReferences:true,cancelPreservesRevision:true},null,2));
}
module.exports={exerciseMedia};
