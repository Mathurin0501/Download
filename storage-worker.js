// Dedicated OPFS worker: bounded memory and durable ACK checkpoints.
let handle, position=0;
self.onmessage = async ({data:m}) => {
  try {
    let value;
    if(m.op==='open') {
      const root=await navigator.storage.getDirectory();
      const file=await root.getFileHandle(m.fileName,{create:true});
      handle=await file.createSyncAccessHandle();
      position=handle.getSize() >= m.offset ? m.offset : 0;
      handle.truncate(position); handle.flush(); value=position;
    } else if(m.op==='write') {
      const bytes=new Uint8Array(m.buffer);
      let done=0;
      while(done<bytes.length){const n=handle.write(bytes.subarray(done),{at:position});if(!n)throw Error('Écriture incomplète');done+=n;position+=n;}
    } else if(m.op==='flush') handle.flush();
    else if(m.op==='close'){handle.flush();handle.close();handle=null;}
    else throw Error('Opération inconnue');
    self.postMessage({seq:m.seq,value});
  }catch(e){self.postMessage({seq:m.seq,error:String(e.message||e)});}
};
