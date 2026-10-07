// Clocks. Deadlines are judged by the SERVER clock only (CONTRACT "Time rules").
// localNow()  = the phone's clock (plus test skew / mock time travel)
// serverNow() = localNow() corrected by the offset measured from get_state().server_now

let skew = 0;      // test hook: simulated phone clock drift (window.__studybet.setClockOffset)
let virtual = 0;   // test hook: mock time travel, moves phone AND mock server (advance())
let offset = 0;    // serverNow - localNow

export const localNow = () => Date.now() + virtual + skew;
export const serverNow = () => localNow() + offset;
/** Mock server's clock: real time + time travel, unaffected by phone drift. */
export const mockServerNow = () => Date.now() + virtual;

/** t0/t1 = localNow() before/after the request; assumes symmetric latency. */
export function syncServer(serverIso, t0, t1) {
  const s = Date.parse(serverIso);
  if (Number.isFinite(s)) offset = s - (t0 + t1) / 2;
}
export const setSkew = (ms) => { skew = Number(ms) || 0; };
export const advanceVirtual = (ms) => { virtual += Number(ms) || 0; };
export const clockOffset = () => offset;
/** Restore the last known offset from the offline snapshot. */
export const setOffset = (ms) => { offset = Number(ms) || 0; };
