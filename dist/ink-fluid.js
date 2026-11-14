// Finite-volume solver for a thin layer of ink. Each edge subtracts exactly
// the pigment volume it adds to the receiving cell.
export const FILM_STEP=1/18;
const ADHESION=.0022, MIN_FLUX=.00044, MAX_FACE_SHARE=.205;

export function filmFlux(depthA,depthB,bedDifference,previous) {
  if (Math.abs(bedDifference)>.41 || Math.max(depthA,depthB)<ADHESION+MIN_FLUX/MAX_FACE_SHARE) return 0;
  const head=bedDifference+depthA-depthB;
  const capillary=.0015, slope=Math.sign(head)*Math.max(0,Math.abs(head)-capillary);
  const pressure=Math.max(-.12,Math.min(.12,slope));
  const flux=previous*.48+pressure*.16;
  const donor=flux>=0?depthA:depthB;
  const amount=Math.min(Math.abs(flux),Math.max(0,donor-ADHESION)*MAX_FACE_SHARE);
  return amount>=MIN_FLUX?Math.sign(flux)*amount:0;
}

export const FILM_HEIGHT_ORIGIN=-9;
export const FILM_HEIGHT_STEP=.07;
export const FILM_HEIGHT_TOLERANCE=.148;
export const encodeFilmHeight=y=>Math.max(1,Math.min(255,Math.round((y-FILM_HEIGHT_ORIGIN)/FILM_HEIGHT_STEP)+1));
export const decodeFilmHeight=byte=>FILM_HEIGHT_ORIGIN+(byte-1)*FILM_HEIGHT_STEP;

export function wallRunoff(mark,dt) {
  if (!mark.volume || Math.abs(mark.normal[1])>.54) return 0;
  const area=Math.max(.06,mark.radius**2*.88);
  const retained=area*.000082;
  const mobile=Math.max(0,mark.volume-retained);
  mark.runoff=(mark.runoff??0)+mobile*(1-Math.exp(-dt*3.1));
  if (mark.runoff<.000024 || mobile<.000024) return 0;
  const drained=Math.min(mobile,mark.runoff,.00023);
  mark.volume-=drained;
  mark.runoff-=drained;
  return drained;
}
