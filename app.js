'use strict';

const ROUTER_URL = 'https://valhalla1.openstreetmap.de/route';
const OFF_ROUTE_M = 60;
const MAX_GPS_ACCURACY_M = 80;
const REROUTE_COOLDOWN_MS = 20000;

const map = L.map('map', { center: [49.1951, 16.6068], zoom: 11, preferCanvas: true });
const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const COLORS = { icn:'#d7191c', ncn:'#f57c00', rcn:'#1976d2', lcn:'#2e7d32', mtb:'#7b1fa2', other:'#68737d' };
const LABELS = { icn:'Mezinárodní', ncn:'Národní', rcn:'Regionální', lcn:'Místní', mtb:'MTB', other:'Ostatní' };
const $ = s => document.querySelector(s);
const ui = {
  loading:$('#loading'), message:$('#message'), start:$('#startText'), finish:$('#finishText'), gps:$('#gpsButton'), manual:$('#manualStartButton'), route:$('#routeButton'), clear:$('#clearButton'),
  startNav:$('#startNavigationButton'), stopNav:$('#stopNavigationButton'), voice:$('#voiceEnabled'), hint:$('#hint'), result:$('#result'), distance:$('#distanceText'), time:$('#timeText'),
  navPanel:$('#navigationPanel'), maneuverIcon:$('#maneuverIcon'), maneuverDistance:$('#maneuverDistance'), maneuverText:$('#maneuverText'), remainingDistance:$('#remainingDistance'),
  remainingTime:$('#remainingTime'), offRouteDistance:$('#offRouteDistance'), navStatus:$('#navigationStatus'), collapse:$('#collapseButton'), body:$('#plannerBody')
};

function cycleStyle(f) {
  const k = f.properties?.network || 'other';
  return { color: COLORS[k] || COLORS.other, weight: k === 'icn' ? 5 : k === 'ncn' ? 4 : 3, opacity: .68, lineCap: 'round' };
}
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function popupHtml(f) {
  const p = f.properties || {}, title = p.name || (p.ref ? `Cyklotrasa ${p.ref}` : 'Cyklotrasa');
  return `<b>${esc(title)}</b>${p.ref ? `<br>Číslo: ${esc(p.ref)}` : ''}<br>Síť: ${esc(LABELS[p.network] || LABELS.other)}${p.operator ? `<br>Provozovatel: ${esc(p.operator)}` : ''}`;
}
const cycleLayer = L.geoJSON(null, { style:cycleStyle, onEachFeature:(f,l) => l.bindPopup(popupHtml(f)) }).addTo(map);
L.control.layers({ 'OpenStreetMap':osm }, { 'Cyklotrasy':cycleLayer }, { collapsed:true }).addTo(map);
const legend = L.control({ position:'bottomleft' });
legend.onAdd = () => {
  const d = L.DomUtil.create('div','legend');
  d.innerHTML = '<strong>Cyklotrasy</strong>' + ['icn','ncn','rcn','lcn','mtb'].map(k => `<div><i class="legend-line" style="background:${COLORS[k]}"></i>${LABELS[k]}</div>`).join('');
  return d;
};
legend.addTo(map);

let startPoint=null, finishPoint=null, startMarker=null, finishMarker=null, accuracyCircle=null, routeLayer=null, currentMarker=null;
let routeCoords=[], cumulative=[], maneuvers=[], routeDurationS=0, selectMode='finish';
let navigating=false, watchId=null, lastRerouteAt=0, rerouting=false, wakeLock=null, lastSpokenKey='';

const coordText = p => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
function icon(color, letter) {
  return L.divIcon({ className:'', iconSize:[32,32], iconAnchor:[16,16], html:`<div style="width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:${color};border:3px solid white;color:white;font:700 13px system-ui;box-shadow:0 2px 8px #0007">${letter}</div>` });
}
function msg(text, ms=6000) {
  ui.message.textContent=text; ui.message.hidden=false; clearTimeout(msg.timer); msg.timer=setTimeout(() => ui.message.hidden=true, ms);
}
function updateButtons() { ui.route.disabled = !(startPoint && finishPoint) || navigating; }
function setStart(p, accuracy=null) {
  startPoint=p;
  if(startMarker) map.removeLayer(startMarker);
  if(accuracyCircle) map.removeLayer(accuracyCircle);
  startMarker=L.marker([p.lat,p.lng],{icon:icon('#1565c0','S')}).addTo(map).bindPopup('Start');
  if(accuracy) accuracyCircle=L.circle([p.lat,p.lng],{radius:accuracy,color:'#1565c0',weight:1,fillOpacity:.08}).addTo(map);
  ui.start.textContent=coordText(p); selectMode='finish'; map.getContainer().classList.add('crosshair'); ui.hint.textContent='Klikněte do mapy pro určení cíle.'; updateButtons();
}
function setFinish(p) {
  finishPoint=p;
  if(finishMarker) map.removeLayer(finishMarker);
  finishMarker=L.marker([p.lat,p.lng],{icon:icon('#e53935','C')}).addTo(map).bindPopup('Cíl');
  ui.finish.textContent=coordText(p); map.getContainer().classList.remove('crosshair'); ui.hint.textContent='Start a cíl jsou připraveny. Stiskněte „Vypočítat trasu“.'; updateButtons();
}
function locate() {
  if(!navigator.geolocation) { msg('Prohlížeč nepodporuje geolokaci. Použijte „Start ručně“.'); return; }
  ui.gps.disabled=true; ui.start.textContent='Zjišťuji GPS polohu…';
  navigator.geolocation.getCurrentPosition(pos => {
    const p={lat:pos.coords.latitude,lng:pos.coords.longitude}; setStart(p,pos.coords.accuracy); map.setView([p.lat,p.lng],pos.coords.accuracy<100?16:14); ui.gps.disabled=false; msg(`GPS poloha nalezena, přesnost přibližně ${Math.round(pos.coords.accuracy)} m.`);
  }, err => {
    ui.gps.disabled=false; ui.start.textContent='GPS se nepodařilo zjistit';
    msg(({1:'Přístup k poloze nebyl povolen.',2:'Poloha není dostupná.',3:'Vypršel čas pro GPS.'}[err.code]||'Chyba geolokace.')+' Použijte „Start ručně“.',8000);
  }, {enableHighAccuracy:true,timeout:12000,maximumAge:30000});
}

map.on('click', e => {
  if(navigating) return;
  const p={lat:e.latlng.lat,lng:e.latlng.lng};
  if(selectMode==='start') { setStart(p); msg('Ruční start nastaven. Nyní klikněte na cíl.'); } else setFinish(p);
});
ui.gps.addEventListener('click',locate);
ui.manual.addEventListener('click',() => { selectMode='start'; map.getContainer().classList.add('crosshair'); ui.hint.textContent='Klikněte do mapy pro ruční nastavení startu.'; msg('Klikněte do mapy na místo startu.'); });
ui.route.addEventListener('click',() => calculateRoute(false));
ui.startNav.addEventListener('click',startNavigation);
ui.stopNav.addEventListener('click',() => stopNavigation(true));
ui.clear.addEventListener('click',clearAll);
ui.collapse.addEventListener('click',() => { ui.body.hidden=!ui.body.hidden; ui.collapse.textContent=ui.body.hidden?'+':'−'; setTimeout(()=>map.invalidateSize(),150); });

function clearAll() {
  stopNavigation(false);
  [startMarker,finishMarker,accuracyCircle,routeLayer,currentMarker].forEach(l => { if(l&&map.hasLayer(l)) map.removeLayer(l); });
  startPoint=finishPoint=startMarker=finishMarker=accuracyCircle=routeLayer=currentMarker=null; routeCoords=[]; maneuvers=[];
  ui.start.textContent='Zjišťuji GPS polohu…'; ui.finish.textContent='Klikněte do mapy'; ui.result.hidden=true; ui.startNav.disabled=true; ui.hint.textContent='Po získání GPS klikněte do mapy pro určení cíle.'; updateButtons(); locate();
}

function decodePolyline(encoded, precision=6) {
  let i=0,lat=0,lng=0,out=[],factor=10**precision;
  while(i<encoded.length) {
    let shift=0,result=0,byte;
    do { byte=encoded.charCodeAt(i++)-63; result|=(byte&31)<<shift; shift+=5; } while(byte>=32);
    lat+=(result&1)?~(result>>1):(result>>1); shift=0; result=0;
    do { byte=encoded.charCodeAt(i++)-63; result|=(byte&31)<<shift; shift+=5; } while(byte>=32);
    lng+=(result&1)?~(result>>1):(result>>1); out.push([lng/factor,lat/factor]);
  }
  return out;
}
function parseRoute(data) {
  if(!data.trip?.legs?.length) throw new Error('Routing server nevrátil úsek trasy.');
  const coords=[], mans=[];
  data.trip.legs.forEach(leg => {
    let c=typeof leg.shape==='string' ? decodePolyline(leg.shape,6) : (leg.shape?.coordinates||leg.shape);
    if(!Array.isArray(c)||c.length<2) return;
    const offset=coords.length ? coords.length-1 : 0;
    if(coords.length) c=c.slice(1);
    coords.push(...c);
    (leg.maneuvers||[]).forEach(m => mans.push({...m,globalBegin:(m.begin_shape_index||0)+offset,globalEnd:(m.end_shape_index||0)+offset}));
  });
  if(coords.length<2) throw new Error('Geometrii trasy se nepodařilo dekódovat.');
  return {coords,maneuvers:mans};
}

async function calculateRoute(isReroute=false) {
  if(!startPoint||!finishPoint) return;
  if(isReroute) { rerouting=true; ui.navStatus.textContent='Přepočítávám trasu…'; }
  else { ui.route.disabled=true; ui.route.textContent='Počítám…'; ui.hint.textContent='Routing server vypočítává cyklistickou trasu.'; }
  const req={locations:[{lat:startPoint.lat,lon:startPoint.lng},{lat:finishPoint.lat,lon:finishPoint.lng}],costing:'bicycle',units:'kilometers',language:'cs-CZ',directions_type:'instructions'};
  try {
    const r=await fetch(`${ROUTER_URL}?json=${encodeURIComponent(JSON.stringify(req))}`);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const data=await r.json(); if(data.error_code) throw new Error(data.error||`Valhalla chyba ${data.error_code}`);
    const parsed=parseRoute(data); routeCoords=parsed.coords; maneuvers=parsed.maneuvers; buildMetrics();
    if(routeLayer&&map.hasLayer(routeLayer)) map.removeLayer(routeLayer);
    routeLayer=L.geoJSON({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:routeCoords}},{style:{color:'#ff1744',weight:7,opacity:.94,lineCap:'round',lineJoin:'round'}}).addTo(map).bringToFront();
    const summary=data.trip.summary||data.trip.legs[0].summary||{}; routeDurationS=Number(summary.time||0); const routeM=Number(summary.length||0)*1000;
    ui.distance.textContent=`${(routeM/1000).toLocaleString('cs-CZ',{maximumFractionDigits:1})} km`; ui.time.textContent=formatTime(routeDurationS); ui.result.hidden=false; ui.startNav.disabled=false;
    if(isReroute) { lastRerouteAt=Date.now(); lastSpokenKey=''; speak('Trasa byla přepočítána.'); ui.navStatus.textContent='Nová trasa je připravena.'; }
    else { map.fitBounds(routeLayer.getBounds(),{padding:[35,35]}); ui.hint.textContent='Trasa je připravena. Pro jízdu stiskněte „Spustit navigaci“.'; msg('Cyklistická trasa byla vypočítána.'); }
  } catch(e) {
    console.error(e); msg(`Trasu nelze vypočítat: ${e.message}`,9000); if(isReroute) ui.navStatus.textContent='Přepočet se nezdařil, pokračuji po původní trase.';
  } finally {
    rerouting=false; ui.route.textContent='Vypočítat trasu'; updateButtons();
  }
}

const toLL=c=>({lat:c[1],lng:c[0]});
function distanceM(a,b) {
  const R=6371000,p1=a.lat*Math.PI/180,p2=b.lat*Math.PI/180,dp=(b.lat-a.lat)*Math.PI/180,dl=(b.lng-a.lng)*Math.PI/180;
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2; return 2*R*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}
function buildMetrics() { cumulative=[0]; for(let i=1;i<routeCoords.length;i++) cumulative[i]=cumulative[i-1]+distanceM(toLL(routeCoords[i-1]),toLL(routeCoords[i])); }
function nearestOnRoute(p) {
  let best={distance:Infinity,index:0,along:0}; const ys=111320,xs=111320*Math.cos(p.lat*Math.PI/180);
  for(let i=0;i<routeCoords.length-1;i++) {
    const a=toLL(routeCoords[i]),b=toLL(routeCoords[i+1]),ax=(a.lng-p.lng)*xs,ay=(a.lat-p.lat)*ys,bx=(b.lng-p.lng)*xs,by=(b.lat-p.lat)*ys,dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy;
    let t=l2?-(ax*dx+ay*dy)/l2:0; t=Math.max(0,Math.min(1,t)); const d=Math.hypot(ax+t*dx,ay+t*dy);
    if(d<best.distance) best={distance:d,index:i,along:cumulative[i]+t*(cumulative[i+1]-cumulative[i])};
  }
  return best;
}

async function startNavigation() {
  if(!routeCoords.length||!finishPoint) return;
  if(!navigator.geolocation) { msg('Navigace vyžaduje geolokaci.'); return; }
  navigating=true; document.body.classList.add('navigation-mode'); setTimeout(()=>map.invalidateSize(),150); ui.startNav.hidden=true; ui.stopNav.hidden=false; ui.route.disabled=true; ui.clear.disabled=true; ui.navPanel.hidden=false; ui.hint.textContent='Navigace běží. Telefon ponechte s otevřenou aplikací.'; map.getContainer().classList.remove('crosshair');
  await requestWakeLock(); speak('Navigace byla spuštěna.');
  watchId=navigator.geolocation.watchPosition(updateNavigation,gpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:10000});
}
function stopNavigation(announce=true) {
  navigating=false; document.body.classList.remove('navigation-mode'); setTimeout(()=>map.invalidateSize(),150); if(watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null;} if('speechSynthesis'in window) speechSynthesis.cancel(); releaseWakeLock();
  ui.startNav.hidden=false; ui.stopNav.hidden=true; ui.clear.disabled=false; ui.navPanel.hidden=true; updateButtons(); if(announce) msg('Navigace byla ukončena.');
}
function updateNavigation(pos) {
  if(!navigating||!routeCoords.length) return;
  const p={lat:pos.coords.latitude,lng:pos.coords.longitude};
  if(!currentMarker) currentMarker=L.circleMarker([p.lat,p.lng],{radius:9,color:'#fff',weight:3,fillColor:'#1565c0',fillOpacity:1}).addTo(map); else currentMarker.setLatLng([p.lat,p.lng]);
  map.panTo([p.lat,p.lng],{animate:true,duration:.5});
  const n=nearestOnRoute(p), total=cumulative.at(-1), remaining=Math.max(0,total-n.along), ratio=total?remaining/total:0;
  ui.remainingDistance.textContent=formatDistance(remaining); ui.remainingTime.textContent=formatTime(routeDurationS*ratio); ui.offRouteDistance.textContent=`${Math.round(n.distance)} m`; updateManeuver(n.index,p);
  const accuracy=pos.coords.accuracy||999; ui.navStatus.textContent=`GPS ±${Math.round(accuracy)} m${n.distance>OFF_ROUTE_M?' · mimo trasu':''}`;
  if(distanceM(p,finishPoint)<35) { speak('Dorazili jste do cíle.'); msg('Dorazili jste do cíle.',10000); stopNavigation(false); return; }
  if(n.distance>OFF_ROUTE_M && accuracy<MAX_GPS_ACCURACY_M && !rerouting && Date.now()-lastRerouteAt>REROUTE_COOLDOWN_MS) { startPoint=p; ui.start.textContent=coordText(p); calculateRoute(true); }
}
function updateManeuver(routeIndex,p) {
  if(!maneuvers.length) { ui.maneuverText.textContent='Pokračujte po vyznačené trase'; ui.maneuverDistance.textContent=''; return; }
  let idx=maneuvers.findIndex(m=>(m.globalBegin??0)>routeIndex); if(idx<0) idx=maneuvers.length-1;
  const m=maneuvers[idx], target=toLL(routeCoords[Math.min(m.globalBegin??0,routeCoords.length-1)]), d=distanceM(p,target);
  ui.maneuverText.textContent=m.instruction||m.verbal_pre_transition_instruction||'Pokračujte po trase'; ui.maneuverDistance.textContent=formatDistance(d); ui.maneuverIcon.textContent=symbol(m.type);
  const threshold=d<=35?30:d<=120?100:d<=350?300:null;
  if(threshold!==null) { const key=`${idx}-${threshold}`; if(key!==lastSpokenKey) { lastSpokenKey=key; const t=m.verbal_pre_transition_instruction||m.instruction; if(t) speak(d<=35?t:`Za ${Math.round(d/10)*10} metrů. ${t}`); } }
}
function symbol(type) { if([4,5,6,14,15,16].includes(type))return'←'; if([8,9,10,18,19,20].includes(type))return'→'; if([24,25,26].includes(type))return'↻'; return'↑'; }
function gpsError(e){ui.navStatus.textContent=({1:'GPS nebyla povolena.',2:'GPS poloha není dostupná.',3:'Čekání na GPS vypršelo.'}[e.code]||'Chyba GPS.');}
function speak(text){if(!ui.voice.checked||!('speechSynthesis'in window)||!text)return;speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang='cs-CZ';u.rate=1;speechSynthesis.speak(u);}
async function requestWakeLock(){try{if('wakeLock'in navigator)wakeLock=await navigator.wakeLock.request('screen');}catch(e){console.warn('Wake Lock není dostupný:',e);}}
function releaseWakeLock(){if(wakeLock){wakeLock.release().catch(()=>{});wakeLock=null;}}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&navigating)requestWakeLock();});
function formatDistance(m){return m>=1000?`${(m/1000).toLocaleString('cs-CZ',{maximumFractionDigits:1})} km`:`${Math.max(0,Math.round(m/10)*10)} m`;}
function formatTime(s){const min=Math.max(0,Math.round(s/60)),h=Math.floor(min/60),m=min%60;return h?`${h} h ${m} min`:`${m} min`;}

fetch('data/cyklotrasy.geojson').then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}).then(data=>{cycleLayer.addData(data);ui.loading.hidden=true;locate();}).catch(e=>{console.error(e);ui.loading.textContent='Síť cyklotras se nepodařilo načíst.';locate();});
