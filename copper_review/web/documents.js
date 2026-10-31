/* Large design documents use IndexedDB; small review notes retain their hash keys. */
let database;
function openDatabase(){
  if(!database)database=new Promise((resolve,reject)=>{const request=indexedDB.open('copper-review-designs',1);request.onupgradeneeded=()=>request.result.createObjectStore('documents');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  return database;
}
export async function rememberDocument(document,baseline){const db=await openDatabase();return new Promise((resolve,reject)=>{const tx=db.transaction('documents','readwrite');tx.objectStore('documents').put({document,baseline},'last');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
export async function rememberedDocument(baseline){const db=await openDatabase();return new Promise((resolve,reject)=>{const request=db.transaction('documents').objectStore('documents').get('last');request.onsuccess=()=>resolve(request.result?.baseline===baseline?request.result.document:null);request.onerror=()=>reject(request.error);});}
