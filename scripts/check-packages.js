#!/usr/bin/env node
"use strict";

/*
 * Offline checks for the package-tracking parser.
 *
 * These need no mail account and no mirror -- they feed hand-built MIME messages
 * straight into the parser. Each case guards a specific defect that shipped in
 * the version recovered from tag recovered/package-tracking-6afc993.
 *
 *   node scripts/check-packages.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  extractPackageInfo,
  deduplicate,
  resolveMailbox,
  persistAndMergePackages,
  pruneStalePackages
} = require("../modules/MMM-SecondBrain/lib/sources.js");

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

function message({ from, name, subject, body, date = "Tue, 10 Mar 2026 09:00:00 -0600" }) {
  return {
    envelope: {
      from: [{ address: from, name }],
      subject,
      date: new Date(date)
    },
    internalDate: new Date(date),
    uid: 1,
    source: Buffer.from(body, "utf8")
  };
}

function plainMime(headers, text) {
  return `${headers}\nContent-Type: text/plain; charset=utf-8\n\n${text}\n`;
}

async function run() {
  console.log("\nPackage parser checks\n");

  /* ---------------------------------------------------------------- *
   * A real shipment is recognised end to end.
   * ---------------------------------------------------------------- */
  const shipped = message({
    from: "shipment-tracking@amazon.com",
    name: "Amazon.com",
    subject: 'Shipped: "Blue Widget, 3-pack"',
    body: plainMime(
      "From: Amazon.com <shipment-tracking@amazon.com>\nSubject: Shipped",
      [
        "Your package has shipped.",
        "Tracking ID: 1Z999AA10123456784",
        "Arriving Tuesday, March 12",
        "Order # 114-3941689-1234567"
      ].join("\n")
    )
  });

  const shippedInfo = await extractPackageInfo(shipped);

  check("amazon shipment is detected", shippedInfo !== null);
  check(
    "carrier is surfaced as the card label",
    shippedInfo?.label === "UPS",
    `label was ${shippedInfo?.label}`
  );
  check(
    "tracking id is extracted",
    shippedInfo?.trackingId === "1Z999AA10123456784",
    `got ${shippedInfo?.trackingId}`
  );
  check(
    "status is Shipped",
    shippedInfo?.status === "Shipped",
    `got ${shippedInfo?.status}`
  );
  check(
    "item name comes from the subject",
    shippedInfo?.title === "Blue Widget, 3-pack",
    `got ${shippedInfo?.title}`
  );

  /* ---------------------------------------------------------------- *
   * A tracking number the mail client wrapped across two lines is still
   * found. This is the case the whitespace-stripped second pass exists for.
   * ---------------------------------------------------------------- */
  const wrapped = message({
    from: "auto-reply@fedex.com",
    name: "FedEx",
    subject: "Your package is out for delivery",
    body: plainMime(
      "From: FedEx <auto-reply@fedex.com>\nSubject: Your package is out for delivery",
      // A 12-digit FedEx number broken over two lines: 7712 + 34567890
      "FedEx tracking number 7712\n34567890 is out for delivery today."
    )
  });

  const wrappedInfo = await extractPackageInfo(wrapped);

  check(
    "a tracking number split across lines is still found",
    wrappedInfo?.trackingId === "771234567890",
    `got ${wrappedInfo?.trackingId}`
  );
  check(
    "wrapped-number status is read from the subject",
    wrappedInfo?.status === "Out for delivery",
    `got ${wrappedInfo?.status}`
  );

  /* ---------------------------------------------------------------- *
   * Regression: tracking numbers must never be read out of raw MIME.
   *
   * The attachment below carries a UPS-shaped string inside its base64
   * payload. The previous parser whitespace-stripped the entire raw source
   * and matched against that, inventing a tracking number that appears
   * nowhere in the message a human can read.
   * ---------------------------------------------------------------- */
  const base64Decoy = message({
    from: "news@example-store.com",
    name: "Example Store",
    subject: "Your order of spring deals is here",
    body: [
      "From: Example Store <news@example-store.com>",
      "Subject: Your order of spring deals is here",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Big savings this week. Nothing has shipped, nothing is on the way.",
      "",
      "--b1",
      "Content-Type: application/octet-stream; name=\"pixel.bin\"",
      "Content-Transfer-Encoding: base64",
      "",
      "1Z999AA10123456784AB",
      "",
      "--b1--",
      ""
    ].join("\n")
  });

  const decoyInfo = await extractPackageInfo(base64Decoy);

  check(
    "no tracking number is invented from a base64 attachment",
    decoyInfo === null || decoyInfo.trackingId === null,
    `got trackingId ${decoyInfo?.trackingId}`
  );

  /* ---------------------------------------------------------------- *
   * Regression: a bare 12-digit run is not a FedEx tracking number
   * unless the message actually names FedEx.
   * ---------------------------------------------------------------- */
  const digitRun = message({
    from: "billing@example-utility.com",
    name: "Example Utility",
    subject: "Your payment confirmation",
    body: plainMime(
      "From: Example Utility <billing@example-utility.com>\nSubject: Your payment confirmation",
      "Account 481516234211 was charged. This is a paperless bill."
    )
  });

  const digitRunInfo = await extractPackageInfo(digitRun);

  check(
    "a 12-digit account number is not treated as FedEx",
    digitRunInfo === null,
    `got ${JSON.stringify(digitRunInfo)}`
  );

  /* ---------------------------------------------------------------- *
   * Regression: identifiers must be stable across polls.
   *
   * The previous parser keyed unidentifiable orders with Math.random(), so
   * every poll produced a brand new id -- the state file grew without bound
   * and the same shipment stacked up as duplicate cards.
   * ---------------------------------------------------------------- */
  const anonymousOrder = () =>
    message({
      from: "orders@example-shop.com",
      name: "Example Shop",
      subject: "Your order confirmed",
      body: plainMime(
        "From: Example Shop <orders@example-shop.com>\nSubject: Your order confirmed",
        "Thanks! Your order confirmed. We will send tracking when it has shipped."
      )
    });

  const first = await extractPackageInfo(anonymousOrder());
  const second = await extractPackageInfo(anonymousOrder());

  check("order without an id still produces a card", first !== null);
  check(
    "the same message yields the same id on every poll",
    first !== null && first.id === second?.id,
    `${first?.id} vs ${second?.id}`
  );

  /* ---------------------------------------------------------------- *
   * One shipment announced three times collapses to a single card that
   * keeps the newest status and the most human-readable title.
   * ---------------------------------------------------------------- */
  const order = "114-3941689-1234567";
  const collapsed = deduplicate([
    {
      id: `package:amazon:${order}`,
      kind: "package",
      title: "Blue Widget, 3-pack",
      status: "Ordered",
      orderId: order,
      trackingId: null,
      timestamp: 1000
    },
    {
      id: `package:amazon:${order}`,
      kind: "package",
      title: "Amazon Package",
      status: "Shipped",
      orderId: order,
      trackingId: "1Z999AA10123456784",
      timestamp: 2000
    },
    {
      id: "package:ups:1Z999AA10123456784",
      kind: "package",
      title: "Tracking: 1Z999AA10123456784",
      status: "Out for delivery",
      orderId: null,
      trackingId: "1Z999AA10123456784",
      timestamp: 3000
    }
  ]);

  check(
    "three updates for one shipment collapse to one card",
    collapsed.length === 1,
    `got ${collapsed.length}`
  );
  check(
    "the newest status wins",
    collapsed[0]?.status === "Out for delivery",
    `got ${collapsed[0]?.status}`
  );
  check(
    "the readable title survives the merge",
    collapsed[0]?.title === "Blue Widget, 3-pack",
    `got ${collapsed[0]?.title}`
  );
  check(
    "identifiers are inherited across the merge",
    collapsed[0]?.orderId === order && collapsed[0]?.trackingId === "1Z999AA10123456784",
    `orderId ${collapsed[0]?.orderId}, trackingId ${collapsed[0]?.trackingId}`
  );

  /* ---------------------------------------------------------------- *
   * Refunds and cancellations are not shipments.
   * ---------------------------------------------------------------- */
  const refund = message({
    from: "orders@example-shop.com",
    name: "Example Shop",
    subject: "Refund for your order 12345",
    body: plainMime(
      "From: Example Shop <orders@example-shop.com>\nSubject: Refund for your order 12345",
      "Your refund has been issued. Shipping charges were included."
    )
  });

  check(
    "a refund does not become a package",
    (await extractPackageInfo(refund)) === null
  );

  /* ---------------------------------------------------------------- *
   * Regression: a package must not live in the state file forever.
   *
   * Only Delivered entries were ever pruned, so an order that never
   * produced a delivery mail stayed cached permanently and was
   * republished on every poll -- archiving the order and shipping mail
   * did nothing, because nothing ever removed the card.
   * ---------------------------------------------------------------- */
  const quiet = { error() {} };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "secondbrain-checks-"));

  const day = 86400000;
  const hour = 3600000;

  const stuck = {
    id: "package:amazon:114-0000000-0000001",
    kind: "package",
    title: "Something ordered a week ago",
    status: "Shipped",
    orderId: "114-0000000-0000001",
    trackingId: null,
    timestamp: Date.now() - 7 * day,
    lastSeenAt: Date.now() - 2 * day
  };

  fs.writeFileSync(
    path.join(stateDir, "package_state.json"),
    JSON.stringify([stuck])
  );

  const afterScan = persistAndMergePackages([], stateDir, quiet, true);

  check(
    "a shipment no mail has mentioned for days is forgotten",
    !afterScan.some((item) => item.id === stuck.id),
    `still present: ${JSON.stringify(afterScan.map((i) => i.id))}`
  );

  /*
   * ...but only when a scan actually ran. A mail outage contributes no
   * messages, and must not be mistaken for "nothing is in flight".
   */
  fs.writeFileSync(
    path.join(stateDir, "package_state.json"),
    JSON.stringify([stuck])
  );

  const afterOutage = persistAndMergePackages([], stateDir, quiet, false);

  check(
    "a failed mail scan does not erase remembered shipments",
    afterOutage.some((item) => item.id === stuck.id),
    "the card was dropped even though no mailbox could be read"
  );

  /* A shipment the current scan still sees is kept. */
  const fresh = {
    ...stuck,
    id: "package:amazon:114-0000000-0000002",
    orderId: "114-0000000-0000002",
    timestamp: Date.now() - hour
  };
  delete fresh.lastSeenAt;

  fs.writeFileSync(path.join(stateDir, "package_state.json"), "[]");

  const kept = persistAndMergePackages([fresh], stateDir, quiet, true);

  check(
    "a shipment the scan still sees stays on the board",
    kept.some((item) => item.id === fresh.id),
    "a live shipment was dropped"
  );

  check(
    "lastSeenAt is recorded so the next poll can age it out",
    Number(kept.find((item) => item.id === fresh.id)?.lastSeenAt) > 0,
    "no lastSeenAt was stamped"
  );

  fs.rmSync(stateDir, { recursive: true, force: true });

  /* ---------------------------------------------------------------- *
   * Regression: a shipment that went quiet days ago leaves the wall.
   *
   * Bounding the state file was not enough on its own. The shipping mail
   * stays in All Mail for packageMaxAgeDays, so every poll rebuilt the
   * card from the same message and refreshed its lastSeenAt -- a package
   * that shipped two or three days ago and was never marked delivered sat
   * on the display for the whole scan window. "Shipped" and "Delayed"
   * reached none of the other prune rules.
   * ---------------------------------------------------------------- */
  const shipmentAged = (hours, status = "Shipped") => ({
    id: `package:amazon:aged-${hours}-${status}`,
    kind: "package",
    status,
    title: `Shipped ${hours}h ago`,
    orderId: `114-0000000-000${hours}`,
    timestamp: Date.now() - hours * 3600000
  });

  const board = pruneStalePackages(
    [
      shipmentAged(2 * 24),
      shipmentAged(3 * 24),
      shipmentAged(4, "Shipped"),
      shipmentAged(8, "Delayed")
    ],
    36 * 3600000
  );

  const survived = board.map((item) => item.title);

  check(
    "a shipment that went quiet two days ago is dropped",
    !survived.includes("Shipped 48h ago"),
    `still shown: ${JSON.stringify(survived)}`
  );

  check(
    "a shipment that went quiet three days ago is dropped",
    !survived.includes("Shipped 72h ago"),
    `still shown: ${JSON.stringify(survived)}`
  );

  check(
    "a shipment with news today is kept",
    survived.includes("Shipped 4h ago"),
    `board was ${JSON.stringify(survived)}`
  );

  check(
    "a Delayed shipment is aged out on the same rule",
    pruneStalePackages([shipmentAged(5 * 24, "Delayed")], 36 * 3600000).length === 0,
    "a stale Delayed card survived"
  );

  check(
    "the stale window is configurable",
    pruneStalePackages([shipmentAged(2 * 24)], 7 * 24 * 3600000).length === 1,
    "a longer window did not keep the card"
  );

  /* ---------------------------------------------------------------- *
   * Regression: an explicitly configured mailbox beats special-use.
   *
   * Resolving special-use first meant packageMailbox: "INBOX" silently
   * kept scanning All Mail, so the setting appeared to do nothing.
   * ---------------------------------------------------------------- */
  const gmailFolders = [
    { path: "INBOX", specialUse: "\\Inbox" },
    { path: "[Gmail]/All Mail", specialUse: "\\All" }
  ];

  check(
    "a configured mailbox name wins over special-use",
    resolveMailbox(gmailFolders, "INBOX", "\\All") === "INBOX",
    `got ${resolveMailbox(gmailFolders, "INBOX", "\\All")}`
  );

  check(
    "special-use still resolves a name that does not match",
    resolveMailbox(gmailFolders, "All Mail", "\\All") === "[Gmail]/All Mail",
    `got ${resolveMailbox(gmailFolders, "All Mail", "\\All")}`
  );

  console.log(
    `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
