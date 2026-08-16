"use strict";

const fs = require("node:fs");
const path = require("node:path");

const cache = {
  key: "",
  expiresAt: 0,
  contacts: new Map()
};

function clean(value) {
  return String(value || "").trim();
}

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }

  if (digits.length > 10) {
    digits = digits.slice(-10);
  }

  return digits.length >= 7 ? digits : "";
}

function formatPhone(value) {
  const digits = normalizePhone(value);

  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }

  return digits || "Unknown number";
}

function extractVoicePhone(subject, senderAddress) {
  const candidates = [
    String(subject || ""),
    String(senderAddress || "").split("@")[0]
  ];

  for (const candidate of candidates) {
    const matches = candidate.match(/\+?\d[\d\s().-]{6,}\d/g) || [];

    for (const match of matches) {
      const normalized = normalizePhone(match);

      if (normalized) {
        return normalized;
      }
    }
  }

  return "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)));
}

function unfoldVcard(value) {
  return String(value || "")
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .replace(/\r/g, "");
}

function unescapeVcard(value) {
  return String(value || "")
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseVcard(value) {
  const lines = unfoldVcard(value).split("\n");
  let name = "";
  const phones = [];

  for (const line of lines) {
    const separator = line.indexOf(":");

    if (separator < 0) {
      continue;
    }

    const property = line.slice(0, separator).toUpperCase();
    const rawValue = line.slice(separator + 1);

    if (!name && (property === "FN" || property.startsWith("FN;"))) {
      name = unescapeVcard(rawValue);
    }

    if (property === "TEL" || property.startsWith("TEL;")) {
      const phone = normalizePhone(rawValue);

      if (phone) {
        phones.push(phone);
      }
    }
  }

  return {
    name: name || "Unknown contact",
    phones
  };
}

function responseBlocks(xml) {
  return Array.from(
    String(xml || "").matchAll(
      /<(?:[A-Za-z0-9_-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?response>/gi
    ),
    (match) => match[1]
  );
}

function firstTag(block, tagName) {
  const expression = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${tagName}>`,
    "i"
  );

  const match = expression.exec(block);
  return match ? decodeXml(match[1]).trim() : "";
}

function addressDataEntries(xml) {
  return Array.from(
    String(xml || "").matchAll(
      /<(?:[A-Za-z0-9_-]+:)?address-data\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?address-data>/gi
    ),
    (match) => decodeXml(match[1])
  );
}

function authorization(config) {
  return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
}

async function davRequest(url, config, method, body, depth = "1") {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(5000, Number(config.timeoutMs || 15000))
  );

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: authorization(config),
        Depth: depth,
        "Content-Type": "application/xml; charset=utf-8"
      },
      body,
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok && response.status !== 207) {
      throw new Error(`CardDAV ${method} returned HTTP ${response.status}`);
    }

    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function discoverAddressBooks(config) {
  const baseUrl = clean(config.baseUrl).replace(/\/+$/, "");
  const principalUrl = clean(config.cardDavUrl) ||
    `${baseUrl}/remote.php/dav/addressbooks/users/${encodeURIComponent(config.username)}/`;

  const xml = await davRequest(
    principalUrl,
    config,
    "PROPFIND",
    `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:resourcetype />
    <d:displayname />
  </d:prop>
</d:propfind>`
  );

  const urls = [];

  for (const block of responseBlocks(xml)) {
    if (!/<(?:[A-Za-z0-9_-]+:)?addressbook\b/i.test(block)) {
      continue;
    }

    const href = firstTag(block, "href");

    if (!href) {
      continue;
    }

    urls.push(new URL(href, `${baseUrl}/`).toString());
  }

  return [...new Set(urls)];
}

async function fetchContacts(config) {
  const books = await discoverAddressBooks(config);

  if (books.length === 0) {
    throw new Error("Nextcloud returned no CardDAV address books");
  }

  const contacts = new Map();

  for (const bookUrl of books) {
    const xml = await davRequest(
      bookUrl,
      config,
      "REPORT",
      `<?xml version="1.0" encoding="UTF-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <card:address-data />
  </d:prop>
</card:addressbook-query>`
    );

    for (const vcard of addressDataEntries(xml)) {
      const parsed = parseVcard(vcard);

      for (const phone of parsed.phones) {
        if (!contacts.has(phone)) {
          contacts.set(phone, parsed.name);
        }
      }
    }
  }

  return contacts;
}

async function loadContacts(configDir, log = console) {
  const configPath = path.join(
    configDir,
    "nextcloud-contacts.json"
  );

  if (!fs.existsSync(configPath)) {
    return new Map();
  }

  const config = JSON.parse(
    fs.readFileSync(configPath, "utf8")
  );

  if (
    config.enabled === false ||
    !config.baseUrl ||
    !config.username ||
    !config.password
  ) {
    return new Map();
  }

  const key = JSON.stringify([
    config.baseUrl,
    config.cardDavUrl || "",
    config.username
  ]);

  if (
    cache.key === key &&
    Date.now() < cache.expiresAt
  ) {
    return cache.contacts;
  }

  try {
    const contacts = await fetchContacts(config);

    cache.key = key;
    cache.contacts = contacts;
    cache.expiresAt = Date.now() +
      Math.max(1, Number(config.cacheMinutes || 15)) * 60000;

    log.info?.(
      `[MMM-SecondBrain] Loaded ${contacts.size} Nextcloud phone entries.`
    );

    return contacts;
  } catch (error) {
    log.error?.(
      `[MMM-SecondBrain] Nextcloud contacts failed: ${error.message}`
    );

    /*
     * Back off on failure as well as on success.
     *
     * Leaving expiresAt in the past made every voice message in the scan retry
     * the full CardDAV discovery and REPORT. That put the one network call which
     * runs *only* when there is a text to show onto the critical path of the
     * whole poll, and the poll publishes nothing until it returns -- so a slow
     * Nextcloud delayed texts precisely when there were texts to delay.
     *
     * The stale map is still served, so cards keep their names; this only bounds
     * how often a sulking server is asked again. A short window, because the
     * cheap recovery matters more than the saved request.
     */
    if (cache.key !== key) {
      cache.key = key;
      cache.contacts = new Map();
    }

    cache.expiresAt = Date.now() +
      Math.max(1, Number(config.retryMinutes || 2)) * 60000;

    return cache.contacts;
  }
}

async function resolveVoiceContact(
  configDir,
  subject,
  senderAddress,
  log = console
) {
  const phone = extractVoicePhone(
    subject,
    senderAddress
  );

  if (!phone) {
    return {
      phone: "",
      name: "Unknown caller"
    };
  }

  const contacts = await loadContacts(
    configDir,
    log
  );

  return {
    phone,
    name: contacts.get(phone) || formatPhone(phone)
  };
}

module.exports = {
  resolveVoiceContact,
  normalizePhone,
  formatPhone
};
