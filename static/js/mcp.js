/* mcp.js
 * Model Context Protocol client UI. Backend holds the registry and
 * auto-injects enabled MCP tools into /chat tools; this module only
 * manages the sidebar list (add/toggle/remove/connect) and forwards
 * tool invocations through /mcp/call on behalf of dispatchToolCall. */

import { addMessage } from "./messages.js";

export const Mcp = (() => {
  const listEl = document.getElementById("mcp-list");
  const addToggle = document.getElementById("mcp-add-toggle");
  const dialog = document.getElementById("mcp-add-dialog");
  const addForm = document.getElementById("mcp-add-form");
  const addCancel = document.getElementById("mcp-add-cancel");
  const nameEl = document.getElementById("mcp-add-name");
  const urlEl = document.getElementById("mcp-add-url");
  let servers = [];

  function openDialog() {
    nameEl.value = "";
    urlEl.value = "";
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");  // fallback for ancient browsers
    nameEl.focus();
  }
  function closeDialog() {
    if (dialog.close) dialog.close();
    else dialog.removeAttribute("open");
  }

  async function refresh() {
    try {
      const res = await fetch("/mcp/servers");
      const d = await res.json();
      servers = d.servers || [];
      render();
    } catch (err) {
      console.warn("[mcp] list failed", err);
    }
  }

  function render() {
    listEl.innerHTML = "";
    if (!servers.length) {
      const empty = document.createElement("li");
      empty.className = "session-item";
      empty.style.opacity = "0.5";
      empty.textContent = "(no servers)";
      listEl.appendChild(empty);
      return;
    }
    for (const s of servers) {
      const li = document.createElement("li");
      const cls = ["session-item"];
      if (!s.enabled) cls.push("disabled");
      if (s.last_error) cls.push("error");
      li.className = cls.join(" ");

      const titleEl = document.createElement("span");
      titleEl.className = "session-item-title";
      titleEl.textContent = s.name;

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "mcp-toggle" + (s.enabled ? "" : " off");
      toggle.textContent = s.enabled ? "ON" : "OFF";
      toggle.title = s.enabled ? "Disable (LLM won't see these tools)" : "Enable";

      const del = document.createElement("button");
      del.type = "button";
      del.className = "session-item-del";
      del.title = "Disconnect this MCP server";
      del.textContent = "×";

      const meta = document.createElement("div");
      meta.className = "mcp-meta";
      meta.textContent = s.last_error
        ? `ERROR: ${s.last_error.slice(0, 60)}`
        : `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"} · ${s.url}`;
      meta.title = s.last_error || s.tools.map((t) => t.name).join(", ");

      li.append(titleEl, toggle, del, meta);
      toggle.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/mcp/servers/${s.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !s.enabled }),
        });
        await refresh();
      });
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch(`/mcp/servers/${s.id}`, { method: "DELETE" });
        await refresh();
      });
      listEl.appendChild(li);
    }
  }

  addToggle.addEventListener("click", openDialog);
  addCancel.addEventListener("click", closeDialog);
  // Click on the backdrop (outside the form) dismisses. The dialog
  // itself is the whole viewport; the form is inside it as a child box.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) closeDialog();
  });
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();  // keep dialog open until we've probed
    const name = nameEl.value.trim();
    const url = urlEl.value.trim();
    if (!name || !url) return;
    const submit = addForm.querySelector("button[type=submit]");
    submit.disabled = true;
    submit.textContent = "PROBING…";
    try {
      const res = await fetch("/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url }),
      });
      if (!res.ok) {
        const err = await res.text();
        addMessage("sys", `[MCP ADD FAILED] ${err}`);
        // Keep the dialog open on failure so the user can fix + retry.
      } else {
        const d = await res.json();
        addMessage("sys", `[MCP CONNECTED] ${d.name} (${d.tools.length} tools)`);
        closeDialog();
      }
    } finally {
      submit.disabled = false;
      submit.textContent = "CONNECT";
      await refresh();
    }
  });

  return {
    init: refresh,
    refresh,
    get servers() { return servers; },
    // Tool names like `mcp_sunnycars_ping` are dispatched by the backend.
    isMcpTool(name) {
      return typeof name === "string" && name.startsWith("mcp_");
    },
    async call(toolName, args) {
      const res = await fetch("/mcp/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: toolName, arguments: args || {} }),
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    },
  };
})();
