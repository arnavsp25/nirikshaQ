import React,{useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Activity,ArrowRight, Bell, CheckCircle2, ChevronRight, Clock3, Moon, Plus, RefreshCw, ShieldAlert, Stethoscope, Sun, UserPlus, Users, X, Zap} from 'lucide-react';
import './styles.css';

const TRIALS=1200;
const uid=()=>Math.random().toString(36).slice(2,9);
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const percentile=(arr,p)=>{const a=[...arr].sort((x,y)=>x-y); const i=(a.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i); return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(i-lo)};
const randn=()=>{let u=0,v=0; while(!u)u=Math.random(); while(!v)v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)};
function gammaSample(shape,scale){
  if(shape<1) throw new Error('This implementation expects shape >= 1');
  const d=shape-1/3,c=1/Math.sqrt(9*d);
  while(true){const x=randn(); const v=Math.pow(1+c*x,3); if(v<=0)continue; const u=Math.random(); if(u<1-0.0331*Math.pow(x,4)||Math.log(u)<0.5*x*x+d*(1-v+Math.log(v)))return d*v*scale;}
}
function forecastDoctor(doc,patients,now=Date.now()){
  const waiting=patients.filter(p=>p.status==='waiting');
  if(!waiting.length)return {};
  const current=patients.find(p=>p.status==='consult');
  const mean=doc.baseAvgMin*doc.paceMultiplier;
  const elapsed=current?.consultStartedAt?Math.max(0,(now-current.consultStartedAt)/60000):0;
  const predictedRemaining=Math.max(1.5,mean-elapsed);
  const result={};
  const buckets=waiting.map(()=>[]);
  for(let t=0;t<TRIALS;t++){
    let cum=current?predictedRemaining*(0.88+Math.random()*0.24):0;
    waiting.forEach((p,i)=>{cum+=gammaSample(4,mean/4); buckets[i].push(cum);});
  }
  waiting.forEach((p,i)=>{const vals=buckets[i], p10=percentile(vals,.1),p50=percentile(vals,.5),p90=percentile(vals,.9);result[p.id]={p10,p50,p90,at:new Date(now+p50*60000),low:new Date(now+p10*60000),high:new Date(now+p90*60000)}});
  return result;
}
function fmtTime(d){return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}).replace(/^0/,'')}
function fmtWindow(f){return f?`${fmtTime(f.low)}–${fmtTime(f.high)}`:'—'}
function severityLabel(s){return s==='emergency'?'Emergency':s==='urgent'?'Urgent':'Routine'}

const initialDoctors=[
 {id:'d1',name:'Dr. Meera Joshi',specialty:'General Medicine',baseAvgMin:8,paceMultiplier:1,queue:[]},
 {id:'d2',name:'Dr. Arjun Rao',specialty:'Paediatrics',baseAvgMin:10,paceMultiplier:1,queue:[]},
 {id:'d3',name:'Dr. Kavita Shah',specialty:'Gynaecology',baseAvgMin:12,paceMultiplier:1,queue:[]}
];

function App(){
 const [view,setView]=useState('board');
 const [doctors,setDoctors]=useState(initialDoctors);
 const [dark,setDark]=useState(()=>localStorage.getItem('nq-theme')!=='light');
 const [severity,setSeverity]=useState('routine');
 const [form,setForm]=useState({name:'',doctor:'d1'});
 const [toast,setToast]=useState(null);
 const [phone,setPhone]=useState([]);
 const [pendingNotifications,setPendingNotifications]=useState(null);
 const [banner,setBanner]=useState(null);
 const [flashes,setFlashes]=useState({});
 const [now,setNow]=useState(Date.now());
 const [addDoc,setAddDoc]=useState({name:'',specialty:'',avg:'10'});
 const [activeDoctor,setActiveDoctor]=useState('d1');
 const [duration,setDuration]=useState('');
 const [expandedPhone,setExpandedPhone]=useState(false);
 useEffect(()=>{localStorage.setItem('nq-theme',dark?'dark':'light')},[dark]);
 useEffect(()=>{const i=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(i)},[]);
 useEffect(()=>{if(banner){const t=setTimeout(()=>setBanner(null),6000);return()=>clearTimeout(t)}},[banner]);
 const computed=useMemo(()=>{const x={}; doctors.forEach(d=>x[d.id]=forecastDoctor(d,d.queue,now));return x},[doctors,now]);
 const mutate=(fn)=>setDoctors(ds=>ds.map(d=>fn(d)?fn(d):d));
 useEffect(()=>{
   if(!pendingNotifications)return;
   const {ids,doctorId,oldP50={}}=pendingNotifications;
   const stamp=Date.now();
   const messages=ids.map(id=>{
     const f=computed[doctorId]?.[id];
     const old=oldP50[id];
     const delta=f&&typeof old==='number'?Math.max(0,Math.round(f.p50-old)):null;
     const reason=delta?`Your OPD window was recalculated because an emergency patient was prioritized ahead of you, adding about ${delta} min to the median estimate.`:`Your OPD window was recalculated because an emergency patient was prioritized ahead of you.`;
     const window=f?` New arrival window: ${fmtWindow(f)} (median ${fmtTime(f.at)}).`:'';
     return {id:uid(),patientId:id,time:stamp,text:`NirikshaQ: ${reason}${window} Please arrive around your updated window.`};
   });
   setFlashes(x=>({...x,...Object.fromEntries(ids.map(id=>[id,stamp]))}));
   if(messages.length)setPhone(ps=>[...messages,...ps].slice(0,12));
   setPendingNotifications(null);
 },[pendingNotifications,computed]);
 function notify(ids,doctorId,oldP50={}){
   if(ids.length)setPendingNotifications({ids,doctorId,oldP50});
 }
 function register(e){e.preventDefault(); const d=doctors.find(x=>x.id===form.doctor); if(!d)return;
   const id=uid(), token=`${String(d.queue.length+1).padStart(3,'0')}`;
   const patient={id,token,name:form.name.trim()||'Anonymous patient',severity,status:'waiting',createdAt:Date.now(),emergency:severity==='emergency'};
   const currentIdx=d.queue.findIndex(p=>p.status==='consult');
   const insertion=severity==='emergency'?Math.max(currentIdx+1,0):d.queue.length;
   const downstream=severity==='emergency'?d.queue.slice(insertion).filter(p=>p.status==='waiting').map(p=>p.id):[];
   const oldP50=Object.fromEntries(downstream.map(id=>[id,computed[d.id]?.[id]?.p50]).filter(([,v])=>typeof v==='number'));
   setDoctors(ds=>ds.map(x=>{if(x.id!==d.id)return x;const q=[...x.queue];q.splice(insertion,0,patient);return {...x,queue:q}}));
   setForm(f=>({...f,name:''}));
   setToast({kind:'success',text:`${severityLabel(severity)} submitted • Token ${token} • ${severity==='emergency'?'inserted after the current consult; downstream windows recalculated.':'forecast will appear after registration.'}`});
   setSeverity('routine');
   if(severity==='emergency'){setBanner({doctor:d.name,text:'Emergency in progress'});notify(downstream,d.id,oldP50)}
 }
 function escalate(patientId){
   let target, doctorName, doctorId, downstream=[], oldP50={};
   setDoctors(ds=>ds.map(d=>{
     const idx=d.queue.findIndex(p=>p.id===patientId); if(idx<0)return d;
     target=d.queue[idx]; doctorName=d.name; doctorId=d.id;
     const currentIdx=d.queue.findIndex(p=>p.status==='consult');
     const insertion=Math.max(currentIdx+1,0);
     const q=d.queue.filter(p=>p.id!==patientId);
     q.splice(insertion,0,{...target,emergency:true,severity:'emergency'});
     downstream=q.slice(insertion+1).filter(p=>p.status==='waiting').map(p=>p.id);
     oldP50=Object.fromEntries(downstream.map(id=>[id,computed[d.id]?.[id]?.p50]).filter(([,v])=>typeof v==='number'));
     return {...d,queue:q};
   }));
   if(target){setBanner({doctor:doctorName,text:'Emergency in progress'});setToast({kind:'warning',text:`Emergency escalation • ${target.name} is now next after the current consult.`});notify(downstream,doctorId,oldP50)}
 }
 function completeConsult(){const d=doctors.find(x=>x.id===activeDoctor);const cur=d?.queue.find(p=>p.status==='consult');if(!d||!cur)return; const actual=Number(duration);if(!actual||actual<0.5||actual>240){setToast({kind:'error',text:'Enter an actual duration between 0.5 and 240 minutes.'});return}
   const predicted=d.baseAvgMin*d.paceMultiplier; const ewma=d.paceMultiplier*.6+(actual/predicted)*.4; const normalized=ewma*.85+1*.15;
   setDoctors(ds=>ds.map(x=>x.id===d.id?{...x,paceMultiplier:normalized,queue:x.queue.map((p,i)=>i===x.queue.findIndex(z=>z.id===cur.id)?{...p,status:'done',completedAt:Date.now(),actualDuration:actual}:i===x.queue.findIndex(z=>z.id===cur.id)+1?{...p,status:'consult',consultStartedAt:Date.now()}:p)}:x));
   setDuration('');setToast({kind:'success',text:`Consult complete • ${actual} min recorded • Pace recalibrated immediately.`});
 }
 function startIfNeeded(d){if(d.queue.some(p=>p.status==='consult'))return; const first=d.queue.find(p=>p.status==='waiting'); if(!first)return; setDoctors(ds=>ds.map(x=>x.id===d.id?{...x,queue:x.queue.map(p=>p.id===first.id?{...p,status:'consult',consultStartedAt:Date.now()}:p)}:x));}
 function addDoctor(e){e.preventDefault();if(!addDoc.name||!addDoc.specialty||!Number(addDoc.avg))return;const id=uid();setDoctors(ds=>[...ds,{id,name:addDoc.name,specialty:addDoc.specialty,baseAvgMin:Number(addDoc.avg),paceMultiplier:1,queue:[]}]);setActiveDoctor(id);setAddDoc({name:'',specialty:'',avg:'10'});setToast({kind:'success',text:'Doctor added with an empty live queue.'})}
 return <div className={dark?'app dark':'app'}>
   <aside className="rail"><div className="brand"><div className="brandMark">NQ</div><div><b>NirikshaQ</b><span>OPD LIVE</span></div></div>
    <nav>{[['board',Activity,'Queue board'],['nurse',UserPlus,'Nurse station'],['doctor',Stethoscope,'Doctor panel']].map(([id,I,label])=><button key={id} className={view===id?'nav active':'nav'} onClick={()=>setView(id)}><I size={18}/><span>{label}</span></button>)}</nav>
    <div className="railBottom"><button className="theme" onClick={()=>setDark(x=>!x)}>{dark?<Sun size={17}/>:<Moon size={17}/>}<span>{dark?'Light mode':'Dark mode'}</span></button><div className="status"><i/>Live model • client-side</div></div>
   </aside>
   <main className="main"><header><div><div className="eyebrow">GOVERNMENT OPD / LIVE MONITOR</div><h1>{view==='board'?'Queue board':view==='nurse'?'Nurse station':'Doctor panel'}</h1></div><div className="headerRight"><span className="clock"><Clock3 size={15}/> {new Date(now).toLocaleTimeString()}</span><span className="model"><Zap size={14}/> Monte Carlo · {TRIALS.toLocaleString()} trials</span></div></header>
   {banner&&<div className="emergencyBanner"><ShieldAlert size={19}/><div><b>{banner.text}</b><span>{banner.doctor} · downstream windows are being recalculated</span></div><span className="liveDot"/></div>}
   {view==='board'&&<QueueBoard doctors={doctors} computed={computed} flashes={flashes} startIfNeeded={startIfNeeded} />}
   {view==='nurse'&&<NurseStation doctors={doctors} computed={computed} form={form} setForm={setForm} severity={severity} setSeverity={setSeverity} register={register} escalate={escalate}/>} 
   {view==='doctor'&&<DoctorPanel doctors={doctors} computed={computed} activeDoctor={activeDoctor} setActiveDoctor={setActiveDoctor} duration={duration} setDuration={setDuration} completeConsult={completeConsult} addDoc={addDoc} setAddDoc={setAddDoc} addDoctor={addDoctor}/>} 
   </main>
   <div className={'phone '+(expandedPhone?'open':'')}><button className="phoneHead" onClick={()=>setExpandedPhone(x=>!x)}><div><Bell size={16}/><b>Patient phone</b>{phone.length>0&&<em>{phone.length}</em>}</div><ChevronRight size={17} className={expandedPhone?'rot':''}/></button>{expandedPhone&&<div className="phoneBody">{phone.length===0?<div className="emptyPhone">No SMS yet.<br/>Emergency reasons and updated windows appear here.</div>:phone.map(m=><div className="sms" key={m.id}><small>SMS · just now</small>{m.text}</div>)}</div>}</div>
   {toast&&<div className={'toast '+toast.kind}><div>{toast.kind==='warning'?<ShieldAlert size={17}/>:toast.kind==='error'?<X size={17}/>:<CheckCircle2 size={17}/>}</div><span>{toast.text}</span><button onClick={()=>setToast(null)}><X size={14}/></button></div>}
 </div>
}

function QueueBoard({doctors,computed,flashes,startIfNeeded}){const totalPatients=doctors.reduce((n,d)=>n+d.queue.length,0);const activePatients=doctors.reduce((n,d)=>n+d.queue.filter(p=>p.status!=='done').length,0);const emergencyPatients=doctors.reduce((n,d)=>n+d.queue.filter(p=>p.status!=='done'&&p.emergency).length,0);const activeConsults=doctors.reduce((n,d)=>n+d.queue.filter(p=>p.status==='consult').length,0);return <section className="content"><div className="opdTaskboard"><div className="taskIntro"><div className="eyebrow">HOSPITAL LIVE OPD TASKBOARD</div><h2>Live patient flow</h2><span>Queue state updates from the same forecasting engine used for every arrival window.</span></div><div className="taskMetrics"><div className="taskMetric"><span>ACTIVE PATIENTS</span><strong>{activePatients}</strong><small>{activeConsults} currently in consult</small></div><div className="taskMetric"><span>TOTAL PATIENTS</span><strong>{totalPatients}</strong><small>registered in today&apos;s live board</small></div><div className="taskMetric emergencyMetric"><span>EMERGENCY</span><strong>{emergencyPatients}</strong><small>{emergencyPatients?'priority cases active':'no active emergency'}</small></div></div></div>{doctors.map(d=>{const waits=d.queue.filter(p=>p.status==='waiting');const next=waits[0];const deviation=Math.round((d.paceMultiplier-1)*100);return <div className="doctorBlock" key={d.id}><div className="doctorHead"><div className="docTitle"><div className="docIcon"><Stethoscope size={18}/></div><div><h2>{d.name}</h2><span>{d.specialty} · baseline {d.baseAvgMin} min consult</span></div></div><div className="paceChip">{deviation===0?'On baseline':deviation>0?`Running ${deviation}% slower — recalibrating`:`Running ${Math.abs(deviation)}% faster — recalibrating`}</div><button className="startBtn" onClick={()=>startIfNeeded(d)}>Start next <ArrowRight size={15}/></button></div>
 <div className="table"><div className="row header"><div>Token</div><div>Patient / status</div><div>Predicted arrival window</div><div>Model</div></div>{d.queue.length===0?<div className="emptyRow">No patients yet · register at Nurse Station to start a live queue.</div>:d.queue.map(p=><PatientRow key={p.id} p={p} forecast={computed[d.id]?.[p.id]} isNext={next?.id===p.id} flash={!!flashes[p.id]&&Date.now()-flashes[p.id]<2500}/>)}</div></div>})}</section>}
function PatientRow({p,forecast,isNext,flash}){return <div className={'row patient '+(flash?'flash':'')+(isNext?' next':'')}><div className="token">#{p.token}</div><div><div className="patientName">{p.name} {p.emergency&&<span className="emergencyBadge">EMERGENCY</span>}</div><div className={'statusChip '+p.status}>{isNext?`Next · ${p.emergency?'emergency':''}`:p.status==='consult'?'In consult':p.status==='done'?'Done':'Waiting'}</div></div><div className="window"><ProbabilityBar forecast={forecast}/><div className="windowText">{forecast? <><b>{fmtWindow(forecast)}</b><span>median {fmtTime(forecast.at)}</span></>:p.status==='done'?'Completed':'Calculating…'}</div></div><div className="modelTag">{forecast?'P10 · P50 · P90':'—'}</div></div>}
function ProbabilityBar({forecast}){if(!forecast)return <div className="prob"><div className="probTrack"><div className="probBand" style={{left:'0%',width:'100%'}}/></div></div>; const spread=Math.max(1,forecast.p90-forecast.p10), median=forecast.p50-forecast.p10; return <div className="prob"><div className="probTrack"><div className="probBand" style={{left:'8%',width:'84%'}}/><i style={{left:`${8+76*(median/spread)}%`}}/></div><div className="probTicks"><span>10%</span><span>50%</span><span>90%</span></div></div>}
function NurseStation({doctors,computed,form,setForm,severity,setSeverity,register,escalate}){const waiting=doctors.flatMap(d=>d.queue.filter(p=>p.status==='waiting'&&!p.emergency).map(p=>({...p,doctor:d.name,doctorId:d.id,window:computed[d.id]?.[p.id]})));return <section className="content twoCol"><div className="panel"><div className="panelTitle"><div><div className="eyebrow">REGISTRATION</div><h2>Register patient</h2></div><UserPlus size={20}/></div><form onSubmit={register} className="form"><label>Patient name <span>optional</span><input value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="e.g. Sunita Patil"/></label><label>Assign doctor<select value={form.doctor} onChange={e=>setForm({...form,doctor:e.target.value})}>{doctors.map(d=><option key={d.id} value={d.id}>{d.name} · {d.specialty}</option>)}</select></label><label>Severity</label><div className="segmented">{['routine','urgent','emergency'].map(s=><button type="button" className={severity===s?s+' selected':''} onClick={()=>setSeverity(s)} key={s}>{severityLabel(s)}</button>)}</div><div className="hint">Emergency registration places the patient immediately after the current consult. It never interrupts an ongoing consult.</div><button className="primary" type="submit"><UserPlus size={17}/> Register {severityLabel(severity)}</button></form></div><div className="panel"><div className="panelTitle"><div><div className="eyebrow">IMPACT RADIUS</div><h2>Escalate existing patient</h2></div><RefreshCw size={20}/></div><p className="sub">Escalation does <b>not</b> interrupt an ongoing consult — it makes the patient next once the current consult ends.</p><div className="escalateList">{waiting.length===0?<div className="emptyPanel">No waiting non-emergency patients available.</div>:waiting.map(p=><div className="escalateRow" key={p.id}><div><b>{p.name}</b><span>#{p.token} · {p.doctor} · <i className={p.severity}>{severityLabel(p.severity)}</i></span></div><div className="esRight"><small>{fmtWindow(p.window)}</small><button onClick={()=>escalate(p.id)}><Zap size={14}/> Escalate</button></div></div>)}</div></div></section>}
function DoctorPanel({doctors,computed,activeDoctor,setActiveDoctor,duration,setDuration,completeConsult,addDoc,setAddDoc,addDoctor}){const d=doctors.find(x=>x.id===activeDoctor)||doctors[0];const cur=d?.queue.find(p=>p.status==='consult');const up=d?.queue.filter(p=>p.status==='waiting').slice(0,3)||[];const dev=Math.round((d?.paceMultiplier-1)*100);return <section className="content"><div className="tabs">{doctors.map(x=><button className={x.id===d.id?'selected':''} onClick={()=>setActiveDoctor(x.id)} key={x.id}>{x.name}<span>{x.specialty}</span></button>)}</div><div className="doctorGrid"><div className="panel current"><div className="eyebrow">CURRENT CONSULT</div><h2>{cur?cur.name:'No patient in consult'}</h2>{cur?<><div className="currentMeta"><span>Token #{cur.token}</span>{cur.emergency&&<span className="emergencyBadge">EMERGENCY</span>}<span>Started {new Date(cur.consultStartedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div><label className="duration">Actual consult duration (minutes)<input type="number" min="0.5" step="0.5" value={duration} onChange={e=>setDuration(e.target.value)} placeholder="e.g. 7.5"/></label><button className="primary" onClick={completeConsult}><CheckCircle2 size={17}/> Complete consult & recalibrate</button></>:<p className="sub">Use “Start next” on the Queue Board to begin the next waiting patient.</p>}</div><div className="panel calibration"><div className="eyebrow">PACE CALIBRATION</div><div className="bigMetric">{dev>0?'+':''}{dev}%</div><p>{dev===0?'Doctor is tracking the baseline consultation pace.':dev>0?`Current consultations are modeled ${dev}% slower than baseline. The model will gradually normalize toward 1.0 as more real durations arrive.`:`Current consultations are modeled ${Math.abs(dev)}% faster than baseline. The model will gradually normalize toward 1.0 as more real durations arrive.`}</p><div className="formula">new = old × 0.6 + (actual ÷ predicted) × 0.4<br/>then 85% current + 15% baseline</div></div></div><div className="panel upnext"><div className="panelTitle"><div><div className="eyebrow">LIVE FORECAST</div><h2>Up next</h2></div><span className="model"><Zap size={13}/> computed</span></div>{up.length===0?<div className="emptyPanel">No waiting patients.</div>:up.map(p=><div className="upRow" key={p.id}><div className="token">#{p.token}</div><div><b>{p.name}</b><span>{p.emergency?'Emergency priority':'Waiting'}</span></div><strong>{fmtWindow(computed[d.id]?.[p.id])}</strong></div>)}</div><div className="panel addDoctor"><div className="panelTitle"><div><div className="eyebrow">CONFIGURATION</div><h2>Add doctor</h2></div><Plus size={20}/></div><form className="inlineForm" onSubmit={addDoctor}><input placeholder="Doctor name" value={addDoc.name} onChange={e=>setAddDoc({...addDoc,name:e.target.value})}/><input placeholder="Specialty" value={addDoc.specialty} onChange={e=>setAddDoc({...addDoc,specialty:e.target.value})}/><input type="number" min="1" value={addDoc.avg} onChange={e=>setAddDoc({...addDoc,avg:e.target.value})}/><button className="primary" type="submit"><Plus size={16}/> Add doctor</button></form></div></section>}

createRoot(document.getElementById('root')).render(<App/>);
