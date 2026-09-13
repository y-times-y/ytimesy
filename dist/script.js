const button=document.getElementById('run-demo');
const output=document.getElementById('terminal-output');
const initial=output.innerHTML;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
button.addEventListener('click',async()=>{
 button.disabled=true;
 output.innerHTML=initial;
 for(let i=2;i<=4;i++)document.getElementById('step'+i).classList.remove('complete');
 document.getElementById('vm-status').textContent='Demo task running';
 document.getElementById('typed-command').textContent='python research.py';
 button.textContent='Running…';
 const steps=[['Reading /workspace/brief.md','step2'],['Writing and checking report.md','step3'],['Snapshot saved: research-complete','step4']];
 for(const [message,id] of steps){await wait(850);const line=document.createElement('div');line.className='log';line.textContent='✓ '+message;output.appendChild(line);document.getElementById(id).classList.add('complete');}
 document.getElementById('vm-status').textContent='Demo complete · snapshot saved';
 button.textContent='Replay demo ↵';button.disabled=false;
});
document.getElementById('copy-code').addEventListener('click',async event=>{
 const copy=event.currentTarget;
 try{await navigator.clipboard.writeText(document.getElementById('sample-code').textContent);copy.textContent='Copied';}
 catch{copy.textContent='Select code to copy';}
 setTimeout(()=>copy.textContent='Copy',2200);
});
