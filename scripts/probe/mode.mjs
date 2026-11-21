// Quick or full: probes that sweep many seeds/layouts run a smaller sweep by default (what
// `npm run probe:quick` runs) and the whole one with `--full` as an argument or PROBE_FULL=1:
//   npm run probe -- scripts/probe/dungeons.mjs --full
// pick(quick, full) is the count to use; an explicit count argument on the probe still wins.
// (`--full` is taken out of process.argv here so a probe's own positional arguments stay put.)
const at = process.argv.indexOf("--full");
if (at >= 0) process.argv.splice(at, 1);
export const FULL = at >= 0 || process.env.PROBE_FULL === "1";
export const pick = (quick, full) => (FULL ? full : quick);
