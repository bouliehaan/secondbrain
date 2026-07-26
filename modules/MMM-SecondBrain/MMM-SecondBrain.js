/* global Module */

// How often the browser nudges the backend as a liveness check, not a poll rate.
const LIVENESS_REFRESH_MS = 5 * 60 * 1000;

Module.register("MMM-SecondBrain", {
  defaults: {
    /*
     * The backend owns the poll schedule and enforces its own floor; anything
     * faster than a minute here is clamped there rather than honoured.
     */
    pollIntervalMs: 60 * 1000,

    /*
     * Notifications, packages and Transmission each get their own slots, so a
     * busy inbox cannot crowd out a shipment or an active download.
     */
    maxItems: 3,
    maxPackageItems: 3,

    configDir: "/etc/magicmirror-secondbrain",
    stateDir: "/var/lib/magicmirror-secondbrain"
  },

  start() {
    this.items = [];
    this.loaded = false;
    this.refreshTimer = null;
    this.configureRetryTimer = null;

    this.hide(0);

    window.setTimeout(
      () => this.configureBackend(),
      750
    );

    this.configureRetryTimer = window.setInterval(
      () => {
        if (!this.loaded) {
          this.configureBackend();
        }
      },
      10 * 1000
    );

    /*
     * A slow liveness nudge, not the poll schedule. The backend polls on its own
     * timer; this only matters if the browser has been suspended and reloaded,
     * and the backend rate-limits it either way.
     */
    this.refreshTimer = window.setInterval(
      () => this.requestRefresh(),
      LIVENESS_REFRESH_MS
    );
  },

  getStyles() {
    return ["MMM-SecondBrain.css"];
  },

  stop() {
    if (this.refreshTimer) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.configureRetryTimer) {
      window.clearInterval(
        this.configureRetryTimer
      );

      this.configureRetryTimer = null;
    }
  },

  notificationReceived(notification) {
    if (notification === "DOM_OBJECTS_CREATED") {
      this.configureBackend();
    }
  },

  resume() {
    this.configureBackend();
    this.requestRefresh();
  },

  configureBackend() {
    this.sendSocketNotification(
      "SECOND_BRAIN_CONFIG",
      {
        pollIntervalMs:
          this.config.pollIntervalMs,

        // The backend reads this as the notification limit only.
        maxItems:
          this.config.maxItems,

        maxPackageItems:
          this.config.maxPackageItems,

        configDir:
          this.config.configDir,

        stateDir:
          this.config.stateDir
      }
    );
  },

  requestRefresh() {
    this.sendSocketNotification(
      "SECOND_BRAIN_REFRESH"
    );
  },

  socketNotificationReceived(
    notification,
    payload
  ) {
    if (
      notification !==
      "SECOND_BRAIN_UPDATE"
    ) {
      return;
    }

    this.loaded = true;

    const newItems = Array.isArray(
      payload?.items
    )
      ? payload.items
      : [];
      
    // Prevent screen flashing by skipping DOM update if data is identical
    const newItemsStr = JSON.stringify(newItems);
    if (this.lastItemsStr === newItemsStr) {
      return;
    }
    this.lastItemsStr = newItemsStr;

    this.items = newItems;

    if (this.configureRetryTimer) {
      window.clearInterval(
        this.configureRetryTimer
      );

      this.configureRetryTimer = null;
    }

    if (this.items.length > 0) {
      this.show(0);
      this.updateDom(0);
    } else {
      this.updateDom(0);
      this.hide(0);
    }
  },

  getDom() {
    const wrapper =
      document.createElement("section");

    wrapper.className =
      "secondbrain-shell";

    if (
      !this.loaded ||
      this.items.length === 0
    ) {
      wrapper.classList.add(
        "secondbrain-empty"
      );

      return wrapper;
    }

    const packages = this.items.filter((item) => this.isPackage(item));
    const notifications = this.items.filter((item) => !this.isTransmission(item) && !this.isPackage(item));
    const downloads = this.items.filter((item) => this.isTransmission(item));

    if (notifications.length > 0) {
      wrapper.appendChild(
        this.renderSection("Notifications", notifications, "notifications")
      );
    }

    if (packages.length > 0) {
      wrapper.appendChild(
        this.renderSection("Packages", packages, "packages")
      );
    }

    if (downloads.length > 0) {
      wrapper.appendChild(
        this.renderSection("Active downloads", downloads, "downloads")
      );
    }

    if (notifications.length === 0 && downloads.length === 0 && packages.length === 0) {
      wrapper.classList.add("secondbrain-empty");
    }

    return wrapper;
  },

  isPackage(item) {
    return item?.kind === "package";
  },

  renderSection(
    title,
    items,
    sectionKind
  ) {
    const section =
      document.createElement("section");

    section.className =
      "secondbrain-section " +
      `secondbrain-section-${sectionKind}`;

    const heading =
      document.createElement("div");

    heading.className =
      "secondbrain-heading";

    heading.textContent = title;

    section.appendChild(heading);

    const list =
      document.createElement("div");

    list.className =
      "secondbrain-list";

    for (const item of items) {
      list.appendChild(
        this.renderItem(item)
      );
    }

    section.appendChild(list);

    return section;
  },

  isTransmission(item) {
    const id = String(
      item?.id || ""
    ).toLowerCase();

    const label = String(
      item?.label || ""
    ).toLowerCase();

    return (
      item?.kind === "download" ||
      id.startsWith("transmission:") ||
      label.includes("transmission")
    );
  },

  renderItem(item) {
    const card =
      document.createElement("article");

    const kind =
      this.safeKind(item.kind);

    card.className =
      "secondbrain-card " +
      `secondbrain-${kind}`;

    const top =
      document.createElement("div");

    top.className =
      "secondbrain-card-top";

    const label =
      document.createElement("span");

    label.className =
      "secondbrain-label";

    label.textContent =
      item.label ||
      this.defaultLabel(kind);

    top.appendChild(label);

    if (item.age) {
      const age =
        document.createElement("span");

      age.className =
        "secondbrain-age";

      age.textContent = item.age;

      top.appendChild(age);
    }

    card.appendChild(top);

    const title =
      document.createElement("div");

    title.className =
      "secondbrain-title";

    title.textContent =
      item.title || "Untitled";

    card.appendChild(title);

    if (item.detail) {
      const detail =
        document.createElement("div");

      detail.className =
        "secondbrain-detail";

      detail.textContent =
        item.detail;

      card.appendChild(detail);
    }

    if (
      kind === "download" &&
      Number.isFinite(item.progress)
    ) {
      const progress =
        document.createElement("div");

      progress.className =
        "secondbrain-progress";

      const bar =
        document.createElement("div");

      bar.className =
        "secondbrain-progress-bar";

      bar.style.width =
        `${Math.max(
          0,
          Math.min(
            100,
            item.progress
          )
        )}%`;

      progress.appendChild(bar);
      card.appendChild(progress);
    }

    return card;
  },

  safeKind(kind) {
    const allowed = new Set([
      "voice",
      "email",
      "download",
      "warning",
      "package"
    ]);

    return allowed.has(kind)
      ? kind
      : "email";
  },

  defaultLabel(kind) {
    return {
      voice: "Message",
      email: "Important email",
      download: "Transmission",
      warning: "Attention",
      package: "Package"
    }[kind] || "Notification";
  }
});
