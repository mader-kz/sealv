/**
 * Conventional geomorphological division of the Caspian Sea.
 *
 * North / Central: Mangyshlak threshold, represented by the conventional
 * straight line from Chechen Island to Cape Tyub-Karagan.
 * Central / South: Apsheron threshold, represented by the conventional
 * straight line from Chilov (Zhiloi) Island to Cape Kuuli.
 *
 * A site is classified by its standing-count centroid. This is a geographic
 * reporting partition, not a claim that seals respect an ecological border.
 */

export type CaspianRegion = "north" | "central" | "south";

export type LngLat = { lat:number;lng:number };

export const CASPIAN_REGION_BOUNDARIES = {
  northCentral:[
    {lat:44.0433,lng:47.7617}, // Chechen Island
    {lat:44.6667,lng:50.3167}, // Cape Tyub-Karagan
  ],
  centralSouth:[
    {lat:40.3333,lng:50.5833}, // Chilov / Zhiloi Island
    {lat:40.2413,lng:52.7347}, // Cape Kuuli
  ],
} as const;

export type CaspianRegionCounts = Record<CaspianRegion,number> & {
  unlocated:number;
  global:number;
};

function boundaryLatitude(boundary:readonly [LngLat,LngLat],lng:number):number{
  const [west,east]=boundary[0].lng<=boundary[1].lng ? boundary : [boundary[1],boundary[0]];
  const clamped=Math.max(west.lng,Math.min(east.lng,lng));
  const fraction=(clamped-west.lng)/(east.lng-west.lng || 1);
  return west.lat+(east.lat-west.lat)*fraction;
}

export function caspianRegionFor(point:LngLat):CaspianRegion|null{
  if(!Number.isFinite(point.lat)||!Number.isFinite(point.lng)) return null;
  const northBoundary=boundaryLatitude(CASPIAN_REGION_BOUNDARIES.northCentral,point.lng);
  if(point.lat>=northBoundary) return "north";
  const southBoundary=boundaryLatitude(CASPIAN_REGION_BOUNDARIES.centralSouth,point.lng);
  if(point.lat<=southBoundary) return "south";
  return "central";
}

export function countByCaspianRegion(
  readings:readonly (LngLat & {count:number|null|undefined})[],
  unlocated=0,
):CaspianRegionCounts{
  const counts:CaspianRegionCounts={north:0,central:0,south:0,unlocated:0,global:0};
  for(const reading of readings){
    const count=Number(reading.count);
    if(!Number.isFinite(count)||count<0) continue;
    const region=caspianRegionFor(reading);
    if(region) counts[region]+=count;
  }
  counts.unlocated=Number.isFinite(unlocated)&&unlocated>0 ? unlocated : 0;
  counts.global=counts.north+counts.central+counts.south+counts.unlocated;
  return counts;
}
