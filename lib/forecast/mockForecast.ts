import type { Footage } from "../types";

export type ForecastPoint = { date: string; value: number; low: number; high: number; isForecast: boolean };
export type ForecastResult = { points: ForecastPoint[]; drivers: string[]; summary: string };

export function mockForecast(footages: Footage[]): ForecastResult {
  if (footages.length === 0) return { points: [], drivers: [], summary: "No data — seed demo or upload flights to forecast." };

  // group seals by month (use uploadedAt as proxy for observation date)
  const byMonth: Record<string, number> = {};
  const monthKeys: string[] = [];
  // build last 6 months + next 3 forecast months as keys
  const now = new Date();
  for (let i = 5; i >= -3; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    const label = d.toLocaleString("en", { month: "short" });
    monthKeys.push(key);
    if (i >= 0) byMonth[key] = 0; // only past 6 have data
  }

  for (const f of footages) {
    const d = new Date(f.uploadedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    if (byMonth[key] !== undefined) {
      const seals = f.detections.filter(dd=> dd.status!=="false_positive").reduce((s,dd)=>s+dd.count,0);
      byMonth[key] += seals;
    }
  }

  const pastKeys = monthKeys.slice(0,6);
  const futureKeys = monthKeys.slice(6);
  const pastVals = pastKeys.map(k=> byMonth[k] || 0);
  // if all zero (demo spread), fallback to pseudo-random but deterministic
  const total = pastVals.reduce((a,b)=>a+b,0);
  const vals = total===0 ? pastKeys.map((_,i)=> Math.round(60 + Math.sin(i*1.1)*22 + (i%2?18:0))) : pastVals;

  // simple trend: linear regression slope
  const n = vals.length;
  const xMean = (n-1)/2;
  const yMean = vals.reduce((a,b)=>a+b,0)/n;
  let num=0, den=0;
  for(let i=0;i<n;i++){ num += (i - xMean)*(vals[i]-yMean); den += (i-xMean)*(i-xMean); }
  const slope = den ? num/den : 0;

  // seasonality: peak Apr/May (month 4,5) and Sep (9)
  function seasonality(month: number){
    // month 0-11
    if (month===3 || month===4) return 0.12; // Apr/May +12%
    if (month===8) return 0.09; // Sep +9%
    if (month===0 || month===1) return -0.08; // Jan/Feb -8%
    return 0;
  }

  const points: ForecastPoint[] = [];
  for(let i=0;i<6;i++){
    const d = new Date(now.getFullYear(), now.getMonth()-5+i, 1);
    const label = d.toLocaleDateString("en",{month:"short"});
    const v = vals[i];
    points.push({ date: label, value: v, low: Math.round(v*0.85), high: Math.round(v*1.15), isForecast:false });
  }
  let last = vals[vals.length-1] || 60;
  for(let i=0;i<3;i++){
    const d = new Date(now.getFullYear(), now.getMonth()+1+i, 1);
    const label = d.toLocaleDateString("en",{month:"short"});
    const m = d.getMonth();
    const base = last + slope * (i+1);
    const v = Math.max(10, Math.round(base * (1 + seasonality(m)) + (Math.random()-0.5)*6));
    const low = Math.round(v*0.82);
    const high = Math.round(v*1.18);
    points.push({ date: label, value: v, low, high, isForecast:true });
    last = v;
  }

  const delta = points[points.length-1].value - points[5].value;
  const pct = points[5].value ? Math.round((delta/points[5].value)*100) : 0;
  const drivers: string[] = [];
  if (Math.abs(slope) > 1) drivers.push(slope>0 ? `3-month upward trend (+${slope.toFixed(1)}/mo)` : `3-month decline (${slope.toFixed(1)}/mo)`);
  else drivers.push("Stable 3-month trend");
  const nextM = new Date(now.getFullYear(), now.getMonth()+1, 1).getMonth();
  const s = seasonality(nextM);
  if (s>0) drivers.push(`Seasonal out-migration (+${Math.round(s*100)}% expected ${new Date(now.getFullYear(), now.getMonth()+1, 1).toLocaleString("en",{month:"long"})})`);
  else if (s<0) drivers.push(`Seasonal low (${Math.round(s*100)}% vs peak)`);
  else drivers.push("Neutral seasonality");

  const summary = `Forecast ${points[points.length-1].value} seals in ${points[points.length-1].date} (${pct>=0?"+":""}${pct}% vs ${points[5].date})`;

  return { points, drivers, summary };
}
