const { ImapFlow } = require('imapflow');
const config = require('../../configuration/config.js');
const secondBrainConfig = config.modules.find(m => m.module === 'MMM-SecondBrain').config;

async function checkProton() {
  const protonConfig = secondBrainConfig.emailAccounts.find(a => a.alias === 'ProtonMail');
  
  const client = new ImapFlow({
    host: protonConfig.host,
    port: protonConfig.port,
    secure: protonConfig.secure,
    auth: {
      user: protonConfig.user,
      pass: protonConfig.password
    },
    logger: false
  });

  await client.connect();
  const mailbox = protonConfig.mailbox || 'INBOX';
  await client.mailboxOpen(mailbox);

  const since = new Date(Date.now() - 7 * 86400000);
  const uids = await client.search({ since }, { uid: true });
  
  if (uids.length > 0) {
    const summaries = await client.fetchAll(uids, { envelope: true }, { uid: true });
    for (const msg of summaries) {
      const subject = msg.envelope?.subject || "";
      let sender = "";
      let address = "";
      if (msg.envelope?.from && msg.envelope.from.length > 0) {
         sender = msg.envelope.from[0].name || "";
         address = msg.envelope.from[0].address || "";
      }
      if (sender.toLowerCase().includes("yunomi") || address.toLowerCase().includes("yunomi") || subject.toLowerCase().includes("yunomi") || sender.toLowerCase().includes("ella")) {
          console.log(`[MATCH] UID: ${msg.uid}, Sender: ${sender} <${address}>, Subject: ${subject}`);
      } else {
          console.log(`UID: ${msg.uid}, Sender: ${sender} <${address}>, Subject: ${subject}`);
      }
    }
  }
  
  await client.logout();
}

checkProton().catch(console.error);
