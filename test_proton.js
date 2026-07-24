const { pollProton } = require('./custom-modules/MMM-SecondBrain/lib/sources.js');

async function main() {
  const configDir = '/Users/jake/Developer/secondbrain/configuration/etc-magicmirror-secondbrain';
  const results = await pollProton(configDir, console);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
