import type { Footage, Detection } from "../types";

export type Anomaly = { site: string; region: string; current: number; expected: number; deltaPct: number; footageIds: string[] };

export function detectAnomalies(footages: Footage[], detections: Detection[]): Anomaly[] {
  if (footages.length < 4) return [];
  // group by region, last 30 days vs prior 90 days mean
  const now = Date.now();
  const thirty = 30 * 86400000, ninety = 90 * 86400000;
  const byRegion: Record<string, { recent: number; past: number[]; ids: string[] }> = {};
  for(const f of footages){
    const age = now - new Date(f.uploadedAt).getTime();
    const seals = f.detections.filter(d=> d.status!=="false_positive").reduce((s,d)=>s+d.count,0);
    if(!byRegion[f.region]) byRegion[f.region] = { recent: 0, past: [], ids: [] };
    if (age <= thirty) { byRegion[f.region].recent += seals; byRegion[f.region].ids.push(f.id); }
    else if (age <= ninety) byRegion[f.region].past.push(seals);
  }
  const anomalies: Anomaly[] = [];
  for(const [region, v] of Object.entries(byRegion)){
    if(v.past.length===0) continue;
    const mean = v.past.reduce((a,b)=>a+b,0)/v.past.length;
    if(mean===0) continue;
    const deltaPct = Math.round(((v.recent - mean)/mean)*100);
    if (deltaPct <= -25) {
      anomalies.push({ site: region, region, current: v.recent, expected: Math.round(mean), deltaPct, footageIds: v.ids });
    }
  }
  return anomalies.sort((a,b)=> a.deltaPct - b.deltaPct).slice(0,3);
}
