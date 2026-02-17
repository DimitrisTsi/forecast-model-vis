/* ================= Overlay Controls ================= */

document.getElementById("startBtn").addEventListener("click", ()=>{
  document.getElementById("welcomeOverlay").classList.add("hidden");
});

document.getElementById("aboutBtn").addEventListener("click", ()=>{
  document.getElementById("aboutOverlay").classList.remove("hidden");
});

document.getElementById("closeAboutBtn").addEventListener("click", ()=>{
  document.getElementById("aboutOverlay").classList.add("hidden");
});

/* ================= MAP ================= */

const map = new maplibregl.Map({
  container:'map',
  style:'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  center:[12,50],
  zoom:4
});

map.addControl(new maplibregl.NavigationControl());

let lastLat=null,lastLon=null,chart=null;
let fieldData=[];

const modelStyles={
  gfs:{ color:"#ff6b6b" },
  ecmwf:{ color:"#4dabf7" }
};

map.on('click',(e)=>{
  lastLat=e.lngLat.lat;
  lastLon=e.lngLat.lng;
  fetchAll();
  fetchField();
});

/* ================= EVENT LISTENERS ================= */

document.querySelectorAll("input,select")
  .forEach(el=>el.addEventListener("change",()=>{ 
    if(lastLat){ 
      fetchAll();
      fetchField();
    }
  }));

/* ================= FETCH CHART ================= */

async function fetchAll(){

  const variable=document.getElementById("variableSelect").value;
  const selected=Array.from(
    document.querySelectorAll("input[type=checkbox]:checked")
  ).map(cb=>cb.value);

  const models=(await Promise.all(
    selected.map(m=>fetchModel(m,variable))
  )).filter(r=>r!==null);

  if(models.length===0) return;

  render(models,variable);
}

async function fetchModel(modelKey,variable){

  let url;
  if(modelKey==="ecmwf"){
    url=`https://api.open-meteo.com/v1/ecmwf?latitude=${lastLat}&longitude=${lastLon}&hourly=${variable}&timezone=UTC`;
  }else{
    url=`https://api.open-meteo.com/v1/forecast?latitude=${lastLat}&longitude=${lastLon}&hourly=${variable}&model=gfs&timezone=UTC`;
  }

  const r=await fetch(url);
  if(!r.ok) return null;
  const d=await r.json();

  return {
    model:modelKey,
    times:d.hourly.time.map(t=>new Date(t).getTime()),
    values:d.hourly[variable]
  };
}

/* ================= CHART ================= */

function render(models,variable){

  if(chart) chart.destroy();

  const labels=models[0].times.map(t=>{
    const d=new Date(t);
    return d.toLocaleString(undefined,{day:'2-digit',hour:'2-digit'});
  });

  const datasets=models.map(m=>({
    label:m.model.toUpperCase(),
    data:m.values,
    borderColor:modelStyles[m.model].color,
    tension:0.3,
    pointRadius:0,
    fill:false
  }));

  const ctx=document.getElementById("chart").getContext("2d");

  chart=new Chart(ctx,{
    type:'line',
    data:{ labels,datasets },
    options:{
      responsive:true,
      plugins:{
        zoom:{
          zoom:{ wheel:{enabled:true}, mode:'x' },
          pan:{ enabled:true, mode:'x' }
        }
      }
    }
  });
}

function resetZoom(){
  if(chart) chart.resetZoom();
}

/* ================= FIELD ================= */

async function fetchField(){

  const variable=document.getElementById("variableSelect").value;
  const model=document.getElementById("mapModelSelect").value;
  const hour=parseInt(document.getElementById("hourSlider").value);

  const step=0.5;
  const size=2;

  const points=[];

  for(let lat=lastLat-size; lat<=lastLat+size; lat+=step){
    for(let lon=lastLon-size; lon<=lastLon+size; lon+=step){
      points.push({lat,lon});
    }
  }

  const promises=points.map(async p=>{
    let url;
    if(model==="ecmwf"){
      url=`https://api.open-meteo.com/v1/ecmwf?latitude=${p.lat}&longitude=${p.lon}&hourly=${variable}&timezone=UTC`;
    }else{
      url=`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&hourly=${variable}&model=gfs&timezone=UTC`;
    }

    const r=await fetch(url);
    if(!r.ok) return null;
    const d=await r.json();

    return {
      type:"Feature",
      geometry:{ type:"Point", coordinates:[p.lon,p.lat]},
      properties:{ value:d.hourly[variable][hour] }
    };
  });

  fieldData=(await Promise.all(promises)).filter(f=>f!==null);

  renderField();
}

function renderField(){

  if(map.getSource("field")){
    map.getSource("field").setData({
      type:"FeatureCollection",
      features:fieldData
    });
  }else{
    map.addSource("field",{
      type:"geojson",
      data:{ type:"FeatureCollection", features:fieldData }
    });

    map.addLayer({
      id:"fieldLayer",
      type:"circle",
      source:"field",
      paint:{
        "circle-radius":6,
        "circle-color":[
          "interpolate",
          ["linear"],
          ["get","value"],
          -10,"#2c7bb6",
          0,"#abd9e9",
          10,"#ffffbf",
          20,"#fdae61",
          30,"#d7191c"
        ],
        "circle-opacity":0.7
      }
    });
  }
}
