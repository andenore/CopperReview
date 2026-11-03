/* SHA-256 and random IDs that also work outside secure contexts. A local server reached by
 * its network address (http://192.168.…) has no crypto.subtle or crypto.randomUUID. */
const bytesOf=data=>data instanceof ArrayBuffer?new Uint8Array(data):new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
const primes=n=>{const out=[];for(let k=2;out.length<n;k++)if(out.every(p=>k%p))out.push(k);return out;};
const fraction=x=>(x-Math.floor(x))*2**32>>>0;
const K=primes(64).map(p=>fraction(Math.cbrt(p))),H=primes(8).map(p=>fraction(Math.sqrt(p)));
function digest(bytes){
  const length=bytes.length,padded=new Uint8Array(Math.ceil((length+9)/64)*64);padded.set(bytes);padded[length]=0x80;
  const view=new DataView(padded.buffer);view.setUint32(padded.length-8,Math.floor(length/2**29));view.setUint32(padded.length-4,length*8>>>0);
  const h=[...H],w=new Uint32Array(64),rotr=(x,n)=>x>>>n|x<<32-n;
  for(let block=0;block<padded.length;block+=64){
    for(let i=0;i<16;i++)w[i]=view.getUint32(block+i*4);
    for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=w[i-16]+(rotr(a,7)^rotr(a,18)^a>>>3)+w[i-7]+(rotr(b,17)^rotr(b,19)^b>>>10)>>>0;}
    let [a,b,c,d,e,f,g,k]=h;
    for(let i=0;i<64;i++){
      const t1=k+(rotr(e,6)^rotr(e,11)^rotr(e,25))+(e&f^~e&g)+K[i]+w[i]>>>0,t2=(rotr(a,2)^rotr(a,13)^rotr(a,22))+(a&b^a&c^b&c)>>>0;
      k=g;g=f;f=e;e=d+t1>>>0;d=c;c=b;b=a;a=t1+t2>>>0;
    }
    [a,b,c,d,e,f,g,k].forEach((v,i)=>{h[i]=h[i]+v>>>0;});
  }
  return h.map(v=>v.toString(16).padStart(8,'0')).join('');
}
/** Lowercase hex SHA-256 of an ArrayBuffer or typed array. */
export async function sha256(data){
  const bytes=bytesOf(data);
  if(globalThis.crypto?.subtle)return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  return digest(bytes);
}
/** A random RFC 4122 version 4 identifier. */
export function randomId(){
  if(globalThis.crypto?.randomUUID)return crypto.randomUUID();
  const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;
  const hex=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export const sha256Fallback=digest;
