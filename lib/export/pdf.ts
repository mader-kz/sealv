import type { Footage } from "../types";
import { mockForecast } from "../forecast/mockForecast";
import { detectAnomalies } from "../insights/anomaly";

export async function exportPDF(footages: Footage[]){
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const totalSeals = footages.reduce((s,f)=> s + f.detections.filter(d=>d.status!=="false_positive").reduce((a,d)=>a+d.count,0), 0);
  const totalGroups = footages.reduce((s,f)=> s+f.detections.length,0);
  const forecast = mockForecast(footages);
  const anomalies = detectAnomalies(footages, footages.flatMap(f=>f.detections));

  // header
  doc.setFillColor(15,23,42);
  doc.rect(0,0,210,28,"F");
  doc.setTextColor(56,189,248);
  doc.setFontSize(14);
  doc.setFont("helvetica","bold");
  doc.text("TULEN — CASPIAN SEAL OPERATIONS", 10, 12);
  doc.setFontSize(7);
  doc.setTextColor(148,163,184);
  doc.setFont("helvetica","normal");
  doc.text(`AKTAU SECTOR • WGS84 • ${new Date().toLocaleDateString()} • ${footages.length} sorties • ${totalSeals} seals`, 10, 17);
  doc.setTextColor(226,232,240);
  doc.text(`Generated: ${new Date().toISOString()}`, 10, 22);

  // KPIs
  doc.setTextColor(15,23,42);
  doc.setFontSize(8);
  let y=34;
  doc.setFont("helvetica","bold");
  doc.text(`KPIs`, 10, y);
  doc.setFont("helvetica","normal");
  doc.setFontSize(9);
  y+=6;
  doc.text(`Total seals: ${totalSeals}    Groups: ${totalGroups}    Flights: ${footages.length}    Avg group: ${totalGroups? (totalSeals/totalGroups).toFixed(1):"—"}`, 10, y);

  // forecast
  y+=8;
  doc.setFont("helvetica","bold");
  doc.setFontSize(8);
  doc.text("FORECAST (statistical mock, next 3M)", 10, y);
  doc.setFont("helvetica","normal");
  doc.setFontSize(7);
  y+=4;
  doc.setTextColor(51,65,85);
  const summary = forecast.summary || "—";
  doc.text(summary, 10, y, { maxWidth: 190 });
  y+=6;
  for(const d of forecast.drivers){
    doc.text(`• ${d}`, 10, y);
    y+=3;
  }
  // simple bar representation for forecast
  y+=2;
  doc.setFontSize(6);
  const pts = forecast.points;
  const maxV = Math.max(...pts.map(p=>p.high),1);
  const barW = 190 / pts.length;
  for(let i=0;i<pts.length;i++){
    const p=pts[i];
    const h = (p.value/maxV)*18;
    const x = 10 + i*barW + 2;
    doc.setFillColor(p.isForecast ? 250 : 56, p.isForecast ? 204 : 189, p.isForecast ? 21 : 248);
    doc.rect(x, y+18 - h, barW-4, h, "F");
    doc.setTextColor(100,116,139);
    doc.text(p.date, x, y+22);
  }
  y+=28;

  // anomalies
  if(anomalies.length>0){
    doc.setFont("helvetica","bold");
    doc.setFontSize(8);
    doc.setTextColor(180,83,9);
    doc.text("ANOMALIES (last 30d vs 90d mean, threshold -25%)", 10, y);
    y+=5;
    doc.setFont("helvetica","normal");
    doc.setFontSize(7);
    doc.setTextColor(30,41,59);
    for(const a of anomalies){
      doc.text(`⚠ ${a.region}: ${a.current} vs ${a.expected} expected (${a.deltaPct}%) — ${a.footageIds.length} flights`, 10, y);
      y+=4;
    }
    y+=2;
  }

  // footage table header
  doc.setFont("helvetica","bold");
  doc.setFontSize(8);
  doc.setTextColor(15,23,42);
  doc.text("FOOTAGE (filtered view)", 10, y);
  y+=4;
  doc.setFontSize(6);
  doc.setFont("helvetica","normal");
  doc.setTextColor(71,85,105);
  doc.text("Filename                         Region    Seals  Groups  Center", 10, y);
  y+=2;
  doc.line(10,y,200,y);
  y+=3;
  for(const f of footages.slice(0,22)){
    if(y>270){ doc.addPage(); y=12; }
    const seals=f.detections.filter(d=>d.status!=="false_positive").reduce((s,d)=>s+d.count,0);
    doc.text(`${f.filename.padEnd(30)} ${f.region.padEnd(9)} ${String(seals).padStart(5)} ${String(f.detections.length).padStart(7)}  ${f.center.lat.toFixed(2)},${f.center.lng.toFixed(2)}`, 10, y);
    y+=3;
  }
  if(footages.length>22){
    doc.text(`… and ${footages.length-22} more`, 10, y);
  }

  // footer
  doc.setFontSize(6);
  doc.setTextColor(100,116,139);
  doc.text("TULEN OS • Mock forecast — swappable to real model via POST /api/forecast • Detections with status=false_positive excluded from totals", 10, 290);

  doc.save(`tulen-report-${new Date().toISOString().slice(0,10)}.pdf`);
}
